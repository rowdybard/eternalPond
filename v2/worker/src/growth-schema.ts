export const GROWTH_SCHEMA_VERSION = 9;

function hasColumn(sql: SqlStorage, table: string, column: string): boolean {
  const columns = sql.exec<{ [key: string]: SqlStorageValue; name: string }>(`PRAGMA table_info(${table})`).toArray();
  return columns.some((item) => item.name === column);
}

export function installGrowthSchema(sql: SqlStorage, current: number, now: number): void {
  if (current < 4) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS soul_credentials (
        id TEXT PRIMARY KEY,
        soul_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        revoked_at INTEGER,
        FOREIGN KEY (soul_id) REFERENCES souls(id)
      );
      CREATE INDEX IF NOT EXISTS soul_credentials_soul ON soul_credentials(soul_id, revoked_at);
      INSERT OR IGNORE INTO soul_credentials(id, soul_id, token_hash, created_at, last_used_at, revoked_at)
        SELECT 'legacy_' || id, id, token_hash, created_at, last_seen_at, NULL FROM souls;
      CREATE TABLE IF NOT EXISTS soul_visits (
        soul_id TEXT NOT NULL,
        day TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (soul_id, day),
        FOREIGN KEY (soul_id) REFERENCES souls(id)
      );
      CREATE INDEX IF NOT EXISTS soul_visits_day ON soul_visits(day, soul_id);
    `);
    sql.exec("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (4, ?)", now);
  }

  if (current < 5) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS public_souls (
        soul_id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
        enabled_at INTEGER NOT NULL,
        disabled_at INTEGER,
        FOREIGN KEY (soul_id) REFERENCES souls(id)
      );
      CREATE INDEX IF NOT EXISTS public_souls_enabled ON public_souls(slug, disabled_at);
    `);
    if (!hasColumn(sql, "memories", "x")) sql.exec("ALTER TABLE memories ADD COLUMN x REAL");
    if (!hasColumn(sql, "memories", "z")) sql.exec("ALTER TABLE memories ADD COLUMN z REAL");
    sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS memories_memorial_life ON memories(life_id) WHERE life_kind = 'memorial'");
    sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS lives_one_active_soul ON lives(soul_id) WHERE soul_id IS NOT NULL AND ended_at IS NULL");
    sql.exec("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (5, ?)", now);
  }

  if (current < 6) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS pond_letter_preferences (
        soul_id TEXT PRIMARY KEY,
        email_ciphertext TEXT,
        email_iv TEXT,
        email_hash TEXT,
        email_masked TEXT,
        encryption_version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'unsubscribed', 'suppressed')),
        consent_version INTEGER NOT NULL DEFAULT 1,
        mortal_letters_enabled INTEGER NOT NULL DEFAULT 1,
        keeper_letters_enabled INTEGER NOT NULL DEFAULT 0,
        requested_at INTEGER NOT NULL,
        confirmed_at INTEGER,
        unsubscribed_at INTEGER,
        last_confirmation_sent_at INTEGER,
        FOREIGN KEY (soul_id) REFERENCES souls(id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS pond_letter_email_hash ON pond_letter_preferences(email_hash)
        WHERE email_hash IS NOT NULL AND status IN ('pending', 'confirmed');
      CREATE TABLE IF NOT EXISTS secure_link_claims (
        token_hash TEXT PRIMARY KEY,
        soul_id TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('confirm_email', 'return_soul', 'unsubscribe')),
        consent_version INTEGER NOT NULL,
        life_id TEXT,
        expires_at INTEGER,
        consumed_at INTEGER,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (soul_id) REFERENCES souls(id)
      );
      CREATE INDEX IF NOT EXISTS secure_link_claims_soul ON secure_link_claims(soul_id, purpose, consumed_at);
      CREATE TABLE IF NOT EXISTS email_deliveries (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE,
        soul_id TEXT NOT NULL,
        delivery_kind TEXT NOT NULL CHECK (delivery_kind IN ('confirmation', 'mortal_death', 'keeper_weekly')),
        life_id TEXT,
        membership_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('waiting_confirmation', 'pending', 'sending', 'sent', 'delivered', 'failed', 'unknown', 'skipped', 'suppressed')),
        due_at INTEGER NOT NULL,
        attempted_at INTEGER,
        sent_at INTEGER,
        delivered_at INTEGER,
        provider_id TEXT UNIQUE,
        failure_code TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (soul_id) REFERENCES souls(id)
      );
      CREATE INDEX IF NOT EXISTS email_deliveries_due ON email_deliveries(status, due_at);
      CREATE INDEX IF NOT EXISTS email_deliveries_soul ON email_deliveries(soul_id, sent_at);
      CREATE TABLE IF NOT EXISTS resend_webhook_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        provider_id TEXT,
        received_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS soul_events (
        id TEXT PRIMARY KEY,
        soul_id TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        event_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (soul_id) REFERENCES souls(id)
      );
      CREATE INDEX IF NOT EXISTS soul_events_recent ON soul_events(soul_id, event_at DESC);
    `);
    sql.exec("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (6, ?)", now);
  }

  if (current < 7) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS keeper_memberships (
        id TEXT PRIMARY KEY,
        soul_id TEXT NOT NULL UNIQUE,
        life_id TEXT UNIQUE,
        stripe_customer_id TEXT UNIQUE,
        current_subscription_id TEXT UNIQUE,
        stripe_status TEXT,
        stripe_price_id TEXT,
        billing_interval TEXT CHECK (billing_interval IN ('month', 'year') OR billing_interval IS NULL),
        cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
        paid_through_at INTEGER,
        activated_at INTEGER,
        rested_at INTEGER,
        updated_at INTEGER NOT NULL,
        dedication TEXT,
        weekly_letters_enabled INTEGER NOT NULL DEFAULT 0,
        last_weekly_letter_at INTEGER,
        next_weekly_letter_at INTEGER,
        FOREIGN KEY (soul_id) REFERENCES souls(id)
      );
      CREATE TABLE IF NOT EXISTS keeper_subscriptions (
        stripe_subscription_id TEXT PRIMARY KEY,
        membership_id TEXT NOT NULL,
        stripe_customer_id TEXT NOT NULL,
        stripe_price_id TEXT,
        billing_interval TEXT,
        stripe_status TEXT NOT NULL,
        cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
        paid_through_at INTEGER,
        started_at INTEGER,
        ended_at INTEGER,
        last_event_created_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (membership_id) REFERENCES keeper_memberships(id)
      );
      CREATE INDEX IF NOT EXISTS keeper_subscriptions_membership ON keeper_subscriptions(membership_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS keeper_checkout_attempts (
        id TEXT PRIMARY KEY,
        membership_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        billing_interval TEXT NOT NULL CHECK (billing_interval IN ('month', 'year')),
        state TEXT NOT NULL CHECK (state IN ('pending', 'created', 'expired', 'failed')),
        stripe_session_id TEXT UNIQUE,
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (membership_id) REFERENCES keeper_memberships(id)
      );
      CREATE TABLE IF NOT EXISTS stripe_webhook_events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        object_id TEXT,
        event_created_at INTEGER NOT NULL,
        processed_at INTEGER NOT NULL
      );
    `);
    sql.exec("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (7, ?)", now);
  }

  if (current < 8) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS public_ripple_limits (
        visitor_soul_id TEXT NOT NULL,
        slug TEXT NOT NULL COLLATE NOCASE,
        last_at INTEGER NOT NULL,
        PRIMARY KEY (visitor_soul_id, slug),
        FOREIGN KEY (visitor_soul_id) REFERENCES souls(id)
      );
      CREATE TABLE IF NOT EXISTS email_suppressions (
        email_hash TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        suppressed_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS keeper_one_open_checkout
        ON keeper_checkout_attempts(membership_id)
        WHERE state IN ('pending', 'created');
    `);
    if (!hasColumn(sql, "resend_webhook_events", "bounce_type")) {
      sql.exec("ALTER TABLE resend_webhook_events ADD COLUMN bounce_type TEXT");
    }
    sql.exec("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (8, ?)", now);
  }

  if (current < 9) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS pond_letter_send_limits (
        soul_id TEXT PRIMARY KEY,
        email_hash TEXT NOT NULL,
        last_reserved_at INTEGER NOT NULL,
        FOREIGN KEY (soul_id) REFERENCES souls(id)
      );
      CREATE TABLE IF NOT EXISTS soul_page_visits (
        soul_id TEXT NOT NULL,
        visit_id TEXT NOT NULL,
        day TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        counted INTEGER NOT NULL,
        PRIMARY KEY (soul_id, visit_id),
        FOREIGN KEY (soul_id) REFERENCES souls(id)
      );
    `);
    if (!hasColumn(sql, "resend_webhook_events", "event_created_at")) {
      sql.exec("ALTER TABLE resend_webhook_events ADD COLUMN event_created_at INTEGER");
    }
    if (!hasColumn(sql, "keeper_checkout_attempts", "customer_id")) {
      sql.exec("ALTER TABLE keeper_checkout_attempts ADD COLUMN customer_id TEXT");
    }
    if (!hasColumn(sql, "email_deliveries", "email_hash")) {
      sql.exec("ALTER TABLE email_deliveries ADD COLUMN email_hash TEXT");
    }
    if (!hasColumn(sql, "email_deliveries", "consent_version")) {
      sql.exec("ALTER TABLE email_deliveries ADD COLUMN consent_version INTEGER");
    }
    sql.exec("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (9, ?)", now);
  }
}
