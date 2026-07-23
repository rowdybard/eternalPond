import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  type LifeStartedMessage,
  type ServerMessage,
  type SharingAckMessage,
  type WelcomeMessage,
} from "@eternal-pond/shared";
import type { PondCoreV2 } from "../src/core";
import { sha256Hex } from "../src/crypto";
import { GROWTH_SCHEMA_VERSION } from "../src/growth-schema";
import type { NormalizedStripeEvent } from "../src/growth-types";

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHLY_PRICE_ID = "price_growth_core_monthly";

function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function welcomeFrom(messages: ServerMessage[]): WelcomeMessage {
  const welcome = messages.find((message): message is WelcomeMessage => message.type === "welcome");
  expect(welcome).toBeDefined();
  return welcome as WelcomeMessage;
}

async function pauseSimulation(stub: DurableObjectStub<PondCoreV2>): Promise<void> {
  await runInDurableObject(stub, async (instance: PondCoreV2) => {
    const internal = instance as unknown as { timer: ReturnType<typeof setInterval> | null };
    if (internal.timer !== null) clearInterval(internal.timer);
    internal.timer = null;
  });
}

async function incarnate(
  stub: DurableObjectStub<PondCoreV2>,
  sessionId: string,
  requestId: string,
): Promise<ServerMessage[]> {
  const deliveries = await stub.receiveBatch({
    gatewayShard: 0,
    entries: [{
      sessionId,
      message: {
        v: PROTOCOL_VERSION,
        type: "incarnate",
        requestId,
        point: { x: 0.51, z: 0.49 },
      },
    }],
  });
  return deliveries[0]?.messages ?? [];
}

describe("Eternal Pond growth schema and relationship invariants", () => {
  it("migrates a populated schema-v3 fixture to the latest schema without losing canonical records and repeats safely", async () => {
    const stub = env.POND_CORE.getByName("growth-schema-v3-fixture");
    await stub.getPublicStatus();

    const now = Date.now();
    const tokenHash = await sha256Hex("legacy-browser-token-for-schema-fixture");
    const soulId = "fixture_soul_v3";
    const lifeId = "fixture_life_v3";
    const soulEntityId = "fixture_soul_entity_v3";
    const ecologyEntityId = "fixture_ecology_lily_v3";
    const memoryId = "fixture_memory_v3";

    await runInDurableObject(stub, async (instance: PondCoreV2, state) => {
      const sql = state.storage.sql;
      sql.exec(`
        DROP TABLE IF EXISTS public_ripple_limits;
        DROP TABLE IF EXISTS soul_page_visits;
        DROP TABLE IF EXISTS pond_letter_send_limits;
        DROP TABLE IF EXISTS email_suppressions;
        DROP TABLE IF EXISTS stripe_webhook_events;
        DROP TABLE IF EXISTS keeper_checkout_attempts;
        DROP TABLE IF EXISTS keeper_subscriptions;
        DROP TABLE IF EXISTS keeper_memberships;
        DROP TABLE IF EXISTS soul_events;
        DROP TABLE IF EXISTS resend_webhook_events;
        DROP TABLE IF EXISTS email_deliveries;
        DROP TABLE IF EXISTS secure_link_claims;
        DROP TABLE IF EXISTS pond_letter_preferences;
        DROP TABLE IF EXISTS public_souls;
        DROP TABLE IF EXISTS soul_visits;
        DROP TABLE IF EXISTS soul_credentials;
        DROP INDEX IF EXISTS memories_memorial_life;
        DROP INDEX IF EXISTS lives_one_active_soul;
        DELETE FROM schema_migrations WHERE version >= 4;
      `);
      sql.exec(
        `INSERT INTO souls(id, token_hash, poetic_name, tint, created_at, last_seen_at, completed_lives)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        soulId, tokenHash, "Legacy Reed under Glass", 0x71c9bd, now - DAY_MS, now - 1_000, 3,
      );
      sql.exec(
        `INSERT INTO lives(id, soul_id, life_kind, started_at, ends_at, ended_at, poetic_record,
          memorial_phase, memorial_name, owner_soul_id, billing_reference)
         VALUES (?, ?, 'mortal', ?, ?, NULL, NULL, NULL, NULL, ?, NULL)`,
        lifeId, soulId, now - 60_000, now + 100 * DAY_MS, soulId,
      );
      sql.exec(
        `INSERT INTO entities(id, soul_id, life_id, label, kind, x, z, depth, heading, speed, size,
          tint, age_ratio, born_at, ends_at, refuge_until, life_kind, memorial_phase, is_foreground,
          seed, state_json, updated_at)
         VALUES (?, ?, ?, ?, 'soulFish', 0.41, 0.52, -0.08, 0.2, 0.01, 0.7,
          ?, 0.1, ?, ?, NULL, 'mortal', NULL, 0, 73, '{}', ?)`,
        soulEntityId, soulId, lifeId, "Legacy Reed under Glass", 0x71c9bd,
        now - 60_000, now + 100 * DAY_MS, now,
      );
      sql.exec(
        `INSERT INTO entities(id, soul_id, life_id, label, kind, x, z, depth, heading, speed, size,
          tint, age_ratio, born_at, ends_at, refuge_until, life_kind, memorial_phase, is_foreground,
          seed, state_json, updated_at)
         VALUES (?, NULL, NULL, NULL, 'lily', 0.22, 0.68, 0, 0, 0, 0.5,
          7422877, 0, ?, ?, NULL, NULL, NULL, 0, 91, '{"source":"offering"}', ?)`,
        ecologyEntityId, now - 60_000, now + 100 * DAY_MS, now,
      );
      sql.exec(
        `INSERT INTO memories(id, soul_id, life_id, display_name, tint, life_kind, completed_at)
         VALUES (?, ?, ?, ?, ?, 'mortal', ?)`,
        memoryId, soulId, lifeId, "Legacy Reed under Glass", 0x71c9bd, now - 30_000,
      );

      const internal = instance as unknown as { installSchema(): void };
      internal.installSchema();
      internal.installSchema();

      expect(sql.exec<{ version: number }>("SELECT MAX(version) AS version FROM schema_migrations").one().version).toBe(GROWTH_SCHEMA_VERSION);
      expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM soul_credentials WHERE soul_id = ?", soulId).one().count).toBe(1);
      expect(sql.exec<{ token_hash: string }>("SELECT token_hash FROM soul_credentials WHERE soul_id = ?", soulId).one().token_hash).toBe(tokenHash);
      expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM souls WHERE id = ?", soulId).one().count).toBe(1);
      expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM lives WHERE id = ?", lifeId).one().count).toBe(1);
      expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM memories WHERE id = ?", memoryId).one().count).toBe(1);
      expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM entities WHERE id IN (?, ?)", soulEntityId, ecologyEntityId).one().count).toBe(2);
      expect(sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'public_ripple_limits'",
      ).one().count).toBe(1);
      expect(sql.exec<{ name: string }>("PRAGMA table_info(resend_webhook_events)").toArray().map((column) => column.name)).toContain("bounce_type");
    });

    await evictDurableObject(stub);
    await stub.getPublicStatus();
    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      const sql = state.storage.sql;
      expect(sql.exec<{ version: number }>("SELECT MAX(version) AS version FROM schema_migrations").one().version).toBe(GROWTH_SCHEMA_VERSION);
      expect(sql.exec<{ completed_lives: number; token_hash: string }>(
        "SELECT completed_lives, token_hash FROM souls WHERE id = ?",
        soulId,
      ).one()).toEqual({ completed_lives: 3, token_hash: tokenHash });
      expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM soul_credentials WHERE soul_id = ?", soulId).one().count).toBe(1);
      expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM lives WHERE id = ?", lifeId).one().count).toBe(1);
      expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM memories WHERE id = ?", memoryId).one().count).toBe(1);
      expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM entities WHERE id IN (?, ?)", soulEntityId, ecologyEntityId).one().count).toBe(2);
    });
  });

  it("upgrades an already-applied schema v8 world with the v9 visit and delivery safeguards", async () => {
    const stub = env.POND_CORE.getByName("growth-schema-v8-fixture");
    await stub.getPublicStatus();

    await runInDurableObject(stub, async (instance: PondCoreV2, state) => {
      const sql = state.storage.sql;
      sql.exec(`
        DROP TABLE IF EXISTS soul_page_visits;
        DROP TABLE IF EXISTS pond_letter_send_limits;
        DELETE FROM schema_migrations WHERE version = 9;
      `);

      const internal = instance as unknown as { installSchema(): void };
      internal.installSchema();
      internal.installSchema();

      expect(sql.exec<{ version: number }>(
        "SELECT MAX(version) AS version FROM schema_migrations",
      ).one().version).toBe(GROWTH_SCHEMA_VERSION);
      for (const table of ["soul_page_visits", "pond_letter_send_limits"]) {
        expect(sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?",
          table,
        ).one().count).toBe(1);
      }
      expect(sql.exec<{ name: string }>("PRAGMA table_info(resend_webhook_events)")
        .toArray().map((column) => column.name)).toContain("event_created_at");
      expect(sql.exec<{ name: string }>("PRAGMA table_info(keeper_checkout_attempts)")
        .toArray().map((column) => column.name)).toContain("customer_id");
      expect(sql.exec<{ name: string }>("PRAGMA table_info(email_deliveries)")
        .toArray().map((column) => column.name)).toEqual(expect.arrayContaining(["email_hash", "consent_version"]));
    });
  });

  it("records one authenticated visit per soul and UTC day even with extra tabs", async () => {
    const stub = env.POND_CORE.getByName("growth-daily-visits");
    const first = await stub.connectSoul({
      requestId: "visit_first_tab",
      visitId: "visit_page_first_tab",
      renderer: "canvas",
      reducedMotion: true,
      gatewayShard: 0,
    });
    const token = welcomeFrom(first.messages).token;
    expect(token).toBeTruthy();
    const second = await stub.connectSoul({
      requestId: "visit_second_tab",
      visitId: "visit_page_second_tab",
      token,
      renderer: "canvas",
      reducedMotion: true,
      gatewayShard: 0,
    });
    const third = await stub.connectSoul({
      requestId: "visit_third_tab",
      visitId: "visit_page_third_tab",
      token,
      renderer: "webgl",
      reducedMotion: false,
      gatewayShard: 0,
    });
    await pauseSimulation(stub);

    const today = utcDay(first.attachment.connectedAt);
    const tomorrowStart = Date.parse(`${today}T00:00:00.000Z`) + DAY_MS;
    await runInDurableObject(stub, async (instance: PondCoreV2, state) => {
      const internal = instance as unknown as { recordVisit(soulId: string, now: number): void };
      internal.recordVisit(first.attachment.soulId, tomorrowStart + 100);
      internal.recordVisit(first.attachment.soulId, tomorrowStart + 900);
      const rows = state.storage.sql.exec<{
        day: string;
        first_seen_at: number;
        last_seen_at: number;
      }>(
        "SELECT day, first_seen_at, last_seen_at FROM soul_visits WHERE soul_id = ? ORDER BY day",
        first.attachment.soulId,
      ).toArray();
      expect(rows).toHaveLength(2);
      expect(rows[0]?.day).toBe(today);
      expect(rows[1]).toEqual({
        day: utcDay(tomorrowStart),
        first_seen_at: tomorrowStart + 100,
        last_seen_at: tomorrowStart + 900,
      });
    });

    await stub.disconnectSoul(first.attachment.sessionId);
    await stub.disconnectSoul(second.attachment.sessionId);
    await stub.disconnectSoul(third.attachment.sessionId);
  });

  it("updates last_seen_at only when the soul's final concurrent session disconnects", async () => {
    const stub = env.POND_CORE.getByName("growth-final-disconnect");
    const first = await stub.connectSoul({
      requestId: "disconnect_first",
      renderer: "webgl",
      reducedMotion: false,
      gatewayShard: 0,
    });
    const token = welcomeFrom(first.messages).token;
    expect(token).toBeTruthy();
    const second = await stub.connectSoul({
      requestId: "disconnect_second",
      token,
      renderer: "webgl",
      reducedMotion: false,
      gatewayShard: 0,
    });
    await pauseSimulation(stub);
    const day = utcDay(first.attachment.connectedAt);

    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      state.storage.sql.exec("UPDATE souls SET last_seen_at = 42 WHERE id = ?", first.attachment.soulId);
      state.storage.sql.exec(
        "UPDATE soul_visits SET last_seen_at = 42 WHERE soul_id = ? AND day = ?",
        first.attachment.soulId, day,
      );
    });
    await stub.disconnectSoul(first.attachment.sessionId);
    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      expect(state.storage.sql.exec<{ last_seen_at: number }>(
        "SELECT last_seen_at FROM souls WHERE id = ?",
        first.attachment.soulId,
      ).one().last_seen_at).toBe(42);
      expect(state.storage.sql.exec<{ last_seen_at: number }>(
        "SELECT last_seen_at FROM soul_visits WHERE soul_id = ? AND day = ?",
        first.attachment.soulId, day,
      ).one().last_seen_at).toBe(42);
    });

    await stub.disconnectSoul(second.attachment.sessionId);
    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      expect(state.storage.sql.exec<{ last_seen_at: number }>(
        "SELECT last_seen_at FROM souls WHERE id = ?",
        first.attachment.soulId,
      ).one().last_seen_at).toBeGreaterThan(42);
      expect(state.storage.sql.exec<{ last_seen_at: number }>(
        "SELECT last_seen_at FROM soul_visits WHERE soul_id = ? AND day = ?",
        first.attachment.soulId, day,
      ).one().last_seen_at).toBeGreaterThan(42);
    });
  });

  it("counts only D1 through D8 as retained while keeping later visits separate", async () => {
    const stub = env.POND_CORE.getByName("growth-retention-window");
    await stub.getPublicStatus();
    const cohortStart = Math.floor((Date.now() - 20 * DAY_MS) / DAY_MS) * DAY_MS;
    const cohortDay = utcDay(cohortStart);
    const souls = ["retention_d0", "retention_d1", "retention_d8", "retention_d9"];

    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      const sql = state.storage.sql;
      souls.forEach((soulId, index) => {
        const createdAt = cohortStart + 100 + index;
        sql.exec(
          `INSERT INTO souls(id, token_hash, poetic_name, tint, created_at, last_seen_at, completed_lives)
           VALUES (?, ?, ?, ?, ?, ?, 0)`,
          soulId, `hash_${soulId}`, `Retention Soul ${index}`, 0x71c9bd + index, createdAt, createdAt,
        );
        sql.exec(
          `INSERT INTO soul_credentials(id, soul_id, token_hash, created_at, last_used_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, NULL)`,
          `credential_${soulId}`, soulId, `hash_${soulId}`, createdAt, createdAt,
        );
        sql.exec(
          `INSERT INTO lives(id, soul_id, life_kind, started_at, ends_at, ended_at, owner_soul_id)
           VALUES (?, ?, 'mortal', ?, ?, ?, ?)`,
          `life_${soulId}`, soulId, cohortStart + 1_000 + index,
          cohortStart + 2 * DAY_MS, cohortStart + 2 * DAY_MS, soulId,
        );
        sql.exec(
          `INSERT INTO soul_visits(soul_id, day, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?)`,
          soulId, cohortDay, cohortStart + 2_000 + index, cohortStart + 3_000 + index,
        );
      });
      for (const [soulId, offset] of [["retention_d1", 1], ["retention_d8", 8], ["retention_d9", 9]] as const) {
        const at = cohortStart + offset * DAY_MS + 2_000;
        sql.exec(
          `INSERT INTO soul_visits(soul_id, day, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?)`,
          soulId, utcDay(at), at, at + 500,
        );
      }
    });

    const report = await stub.getRetentionReport({ from: cohortDay, to: cohortDay });
    expect(report.returnWindow).toEqual({ fromDay: 1, throughDay: 8 });
    expect(report.totals).toMatchObject({
      eligibleSouls: 4,
      returnedSouls: 2,
      returnRate: 0.5,
    });
    expect(report.cohorts).toHaveLength(1);
    expect(report.cohorts[0]).toMatchObject({
      day: cohortDay,
      newCredentials: 4,
      firstBirths: 4,
      birthCompletions24h: 4,
      eligibleSouls: 4,
      returnedSouls: 2,
      returnRate: 0.5,
      secondVisitSouls: 3,
      secondVisitRate: 0.75,
    });
  });

  it("emits lifeStarted with the canonical mortal life after an immediate birth", async () => {
    const stub = env.POND_CORE.getByName("growth-life-started");
    const connection = await stub.connectSoul({
      requestId: "life_started_hello",
      renderer: "webgl",
      reducedMotion: false,
      gatewayShard: 0,
    });
    const messages = await incarnate(stub, connection.attachment.sessionId, "life_started_birth");
    const started = messages.find((message): message is LifeStartedMessage => message.type === "lifeStarted");
    expect(started).toBeDefined();
    expect(started?.requestId).toBe("life_started_birth");
    expect(started?.life).toMatchObject({
      entityId: expect.any(String),
      name: welcomeFrom(connection.messages).identity.name,
      lifeKind: "mortal",
      status: "living",
    });
    expect(started?.life.lifeId).toEqual(expect.any(String));
    expect((started?.life.endsAt ?? 0) - (started?.life.bornAt ?? 0)).toBeGreaterThanOrEqual(2 * DAY_MS);
    expect((started?.life.endsAt ?? 0) - (started?.life.bornAt ?? 0)).toBeLessThanOrEqual(7 * DAY_MS);
    expect(started?.reincarnation).toBe(false);

    await pauseSimulation(stub);
    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      const row = state.storage.sql.exec<{ life_kind: string; ended_at: number | null }>(
        "SELECT life_kind, ended_at FROM lives WHERE id = ?",
        started?.life.lifeId ?? "",
      ).one();
      expect(row).toEqual({ life_kind: "mortal", ended_at: null });
    });
    await stub.disconnectSoul(connection.attachment.sessionId);
  });

  it("keeps public slugs immutable across disable/re-enable and exposes only allowlisted fields", async () => {
    const stub = env.POND_CORE.getByName("growth-public-sharing");
    const connection = await stub.connectSoul({
      requestId: "sharing_hello",
      renderer: "webgl",
      reducedMotion: false,
      gatewayShard: 0,
    });
    await incarnate(stub, connection.attachment.sessionId, "sharing_birth");
    await pauseSimulation(stub);

    const enable = await stub.receiveBatch({
      gatewayShard: 0,
      entries: [{
        sessionId: connection.attachment.sessionId,
        message: { v: PROTOCOL_VERSION, type: "setSharing", requestId: "sharing_enable", enabled: true },
      }],
    });
    const enabled = enable[0]?.messages.find((message): message is SharingAckMessage => message.type === "sharingAck");
    const slug = enabled?.sharing.slug;
    expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

    const view = await stub.getPublicSoul({ slug: slug ?? "missing" });
    expect(view).not.toBeNull();
    expect(Object.keys(view ?? {}).sort()).toEqual([
      "completedLives", "currentLife", "dedication", "name", "slug", "status", "tint",
    ]);
    expect(Object.keys(view?.currentLife ?? {}).sort()).toEqual([
      "ageText", "kind", "presentation", "remainingPassageText",
    ]);
    expect(Object.keys(view?.currentLife?.presentation ?? {}).sort()).toEqual([
      "ageRatio", "depth", "heading", "size", "x", "z",
    ]);
    expect(JSON.stringify(view)).not.toMatch(/soulId|lifeId|entityId|memoryId|token|email|billing/iu);

    await stub.receiveBatch({
      gatewayShard: 0,
      entries: [{
        sessionId: connection.attachment.sessionId,
        message: { v: PROTOCOL_VERSION, type: "setSharing", requestId: "sharing_disable", enabled: false },
      }],
    });
    expect(await stub.getPublicSoul({ slug: slug ?? "missing" })).toBeNull();

    const reenable = await stub.receiveBatch({
      gatewayShard: 0,
      entries: [{
        sessionId: connection.attachment.sessionId,
        message: { v: PROTOCOL_VERSION, type: "setSharing", requestId: "sharing_reenable", enabled: true },
      }],
    });
    const restored = reenable[0]?.messages.find((message): message is SharingAckMessage => message.type === "sharingAck");
    expect(restored?.sharing.slug).toBe(slug);
    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM public_souls WHERE soul_id = ?",
        connection.attachment.soulId,
      ).one().count).toBe(1);
    });
    await stub.disconnectSoul(connection.attachment.sessionId);
  });

  it("redeems a recovery claim once and mints a secondary credential for the same soul", async () => {
    const stub = env.POND_CORE.getByName("growth-recovery-claim");
    const connection = await stub.connectSoul({
      requestId: "claim_hello",
      renderer: "canvas",
      reducedMotion: true,
      gatewayShard: 0,
    });
    const welcome = welcomeFrom(connection.messages);
    expect(welcome.token).toBeTruthy();
    await pauseSimulation(stub);

    const claim = "return_claim_growth_core_abcdefghijklmnopqrstuvwxyz0123456789";
    const claimHash = await sha256Hex(claim);
    const now = Date.now();
    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      state.storage.sql.exec(
        `INSERT INTO pond_letter_preferences(
          soul_id, status, consent_version, mortal_letters_enabled, keeper_letters_enabled, requested_at
        ) VALUES (?, 'confirmed', 1, 1, 0, ?)`,
        connection.attachment.soulId, now,
      );
      state.storage.sql.exec(
        `INSERT INTO secure_link_claims(
          token_hash, soul_id, purpose, consent_version, life_id, expires_at, consumed_at, created_at
        ) VALUES (?, ?, 'return_soul', 1, NULL, ?, NULL, ?)`,
        claimHash, connection.attachment.soulId, now + DAY_MS, now,
      );
    });

    expect(await stub.inspectSecureLink({ claim })).toMatchObject({
      valid: true,
      purpose: "return_soul",
      name: welcome.identity.name,
    });
    const redeemed = await stub.redeemSecureLink({ claim });
    expect(redeemed).toMatchObject({ ok: true, purpose: "return_soul", name: welcome.identity.name });
    expect(redeemed.token).toBeTruthy();
    expect(await stub.inspectSecureLink({ claim })).toEqual({ valid: false });
    expect(await stub.redeemSecureLink({ claim })).toMatchObject({ ok: false, message: "invalid_or_expired" });

    const recovered = await stub.connectSoul({
      requestId: "claim_recovered",
      token: redeemed.token,
      renderer: "canvas",
      reducedMotion: true,
      gatewayShard: 0,
    });
    expect(welcomeFrom(recovered.messages).identity.id).toBe(welcome.identity.id);
    expect(welcomeFrom(recovered.messages).token).toBeUndefined();
    await pauseSimulation(stub);
    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM soul_credentials WHERE soul_id = ? AND revoked_at IS NULL",
        connection.attachment.soulId,
      ).one().count).toBe(2);
    });
    await stub.disconnectSoul(connection.attachment.sessionId);
    await stub.disconnectSoul(recovered.attachment.sessionId);
  });

  it("converts, rests, and reactivates one Keeper life in place from normalized Stripe events", async () => {
    const stub = env.POND_CORE.getByName("growth-keeper-continuity");
    const connection = await stub.connectSoul({
      requestId: "keeper_hello",
      renderer: "webgl",
      reducedMotion: false,
      gatewayShard: 0,
    });
    const birthMessages = await incarnate(stub, connection.attachment.sessionId, "keeper_birth");
    const started = birthMessages.find((message): message is LifeStartedMessage => message.type === "lifeStarted");
    expect(started).toBeDefined();
    const originalLifeId = started?.life.lifeId ?? "";
    await pauseSimulation(stub);

    const membershipId = "keeper_membership_growth_core";
    const subscriptionId = "sub_growth_core";
    const customerId = "cus_growth_core";
    const now = Date.now();
    await runInDurableObject(stub, async (instance: PondCoreV2, state) => {
      const internal = instance as unknown as { env: Env };
      internal.env = {
        ...internal.env,
        STRIPE_MONTHLY_PRICE_ID: MONTHLY_PRICE_ID,
      } as unknown as Env;
      state.storage.sql.exec(
        `INSERT INTO keeper_memberships(id, soul_id, updated_at, weekly_letters_enabled)
         VALUES (?, ?, ?, 0)`,
        membershipId, connection.attachment.soulId, now,
      );
    });

    const activeEvent: NormalizedStripeEvent = {
      eventId: "evt_keeper_paid_initial",
      type: "invoice.paid",
      objectId: "in_keeper_paid_initial",
      createdAt: now,
      invoicePaid: true,
      paidInvoiceThroughAt: now + 30 * DAY_MS,
      subscription: {
        subscriptionId,
        membershipRef: membershipId,
        customerId,
        status: "active",
        priceId: MONTHLY_PRICE_ID,
        interval: "month",
        quantity: 1,
        cancelAtPeriodEnd: false,
        paidThroughAt: null,
      },
    };
    expect(await stub.applyStripeEvent(activeEvent)).toEqual({ duplicate: false });
    expect(await stub.applyStripeEvent(activeEvent)).toEqual({ duplicate: true });

    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      const sql = state.storage.sql;
      expect(sql.exec<{
        id: string;
        life_kind: string;
        ends_at: number | null;
        ended_at: number | null;
        memorial_phase: string | null;
      }>("SELECT id, life_kind, ends_at, ended_at, memorial_phase FROM lives WHERE soul_id = ?", connection.attachment.soulId).one()).toEqual({
        id: originalLifeId,
        life_kind: "memorial",
        ends_at: null,
        ended_at: null,
        memorial_phase: "water",
      });
      expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM lives WHERE soul_id = ?", connection.attachment.soulId).one().count).toBe(1);
      expect(sql.exec<{ completed_lives: number }>("SELECT completed_lives FROM souls WHERE id = ?", connection.attachment.soulId).one().completed_lives).toBe(0);
    });

    const expiredAt = now - 1_000;
    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      state.storage.sql.exec(
        "UPDATE keeper_memberships SET paid_through_at = ?, stripe_status = 'canceled' WHERE id = ?",
        expiredAt, membershipId,
      );
      state.storage.sql.exec(
        "UPDATE keeper_subscriptions SET paid_through_at = ?, stripe_status = 'canceled' WHERE stripe_subscription_id = ?",
        expiredAt, subscriptionId,
      );
    });
    const restEvent: NormalizedStripeEvent = {
      eventId: "evt_keeper_terminal_cancel",
      type: "customer.subscription.deleted",
      objectId: subscriptionId,
      createdAt: now + 1,
      subscription: {
        ...activeEvent.subscription!,
        status: "canceled",
        paidThroughAt: null,
      },
    };
    expect(await stub.applyStripeEvent(restEvent)).toEqual({ duplicate: false });
    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      const sql = state.storage.sql;
      expect(sql.exec<{ id: string; memorial_phase: string | null }>(
        "SELECT id, memorial_phase FROM lives WHERE soul_id = ?",
        connection.attachment.soulId,
      ).one()).toEqual({ id: originalLifeId, memorial_phase: "dome" });
      expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM lives WHERE soul_id = ?", connection.attachment.soulId).one().count).toBe(1);
      expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM memories WHERE life_id = ?", originalLifeId).one().count).toBe(1);
    });

    const reactivateEvent: NormalizedStripeEvent = {
      eventId: "evt_keeper_paid_again",
      type: "invoice.paid",
      objectId: "in_keeper_paid_again",
      createdAt: now + 2,
      invoicePaid: true,
      paidInvoiceThroughAt: now + 60 * DAY_MS,
      subscription: {
        ...activeEvent.subscription!,
      },
    };
    expect(await stub.applyStripeEvent(reactivateEvent)).toEqual({ duplicate: false });
    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      const sql = state.storage.sql;
      expect(sql.exec<{ id: string; life_kind: string; memorial_phase: string | null }>(
        "SELECT id, life_kind, memorial_phase FROM lives WHERE soul_id = ?",
        connection.attachment.soulId,
      ).one()).toEqual({ id: originalLifeId, life_kind: "memorial", memorial_phase: "water" });
      expect(sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM lives WHERE soul_id = ? AND ended_at IS NULL",
        connection.attachment.soulId,
      ).one().count).toBe(1);
      expect(sql.exec<{ life_id: string; rested_at: number | null }>(
        "SELECT life_id, rested_at FROM keeper_memberships WHERE id = ?",
        membershipId,
      ).one()).toEqual({ life_id: originalLifeId, rested_at: null });
      expect(sql.exec<{ completed_lives: number }>("SELECT completed_lives FROM souls WHERE id = ?", connection.attachment.soulId).one().completed_lives).toBe(0);
    });
    await stub.disconnectSoul(connection.attachment.sessionId);
  });
});
