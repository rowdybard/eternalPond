import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type RitualAckMessage,
  type ServerMessage,
  type SharingAckMessage,
  type WelcomeMessage,
} from "@eternal-pond/shared";
import type { PondCoreV2 } from "../src/core";
import worker from "../src/index";

const DAY_MS = 24 * 60 * 60 * 1000;
const ALLOWED_ORIGIN = "http://localhost:5173";
const OWNER_TOKEN = "owner_abcdefghijklmnopqrstuvwxyz0123456789";

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

async function sendClientMessage(
  stub: DurableObjectStub<PondCoreV2>,
  sessionId: string,
  message: ClientMessage,
): Promise<ServerMessage[]> {
  const result = await stub.receiveBatch({
    gatewayShard: 0,
    entries: [{ sessionId, message }],
  });
  return result[0]?.messages ?? [];
}

function apiEnv(core: object): Env {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "POND_CORE") return { getByName: () => core };
      return Reflect.get(target, property, receiver);
    },
  });
}

describe("Eternal Pond growth edge invariants", () => {
  it("persists the five-minute public-ripple cooldown across Durable Object eviction", async () => {
    const stub = env.POND_CORE.getByName("growth-edge-public-ripple-eviction");
    const owner = await stub.connectSoul({
      requestId: "ripple_owner_hello",
      renderer: "canvas",
      reducedMotion: true,
      gatewayShard: 0,
    });
    const visitor = await stub.connectSoul({
      requestId: "ripple_visitor_hello",
      renderer: "canvas",
      reducedMotion: true,
      gatewayShard: 0,
    });
    const visitorToken = welcomeFrom(visitor.messages).token;
    expect(visitorToken).toBeTruthy();
    await pauseSimulation(stub);

    const sharingMessages = await sendClientMessage(stub, owner.attachment.sessionId, {
      v: PROTOCOL_VERSION,
      type: "setSharing",
      requestId: "ripple_enable_sharing",
      enabled: true,
    });
    const sharing = sharingMessages.find(
      (message): message is SharingAckMessage => message.type === "sharingAck",
    );
    const slug = sharing?.sharing.slug;
    expect(slug).toBeTruthy();

    const firstMessages = await sendClientMessage(stub, visitor.attachment.sessionId, {
      v: PROTOCOL_VERSION,
      type: "leavePublicRipple",
      requestId: "ripple_first",
      slug: slug ?? "missing",
    });
    const first = firstMessages.find(
      (message): message is RitualAckMessage => message.type === "ritualAck",
    );
    expect(first).toMatchObject({ accepted: true });

    await stub.disconnectSoul(owner.attachment.sessionId);
    await stub.disconnectSoul(visitor.attachment.sessionId);
    await evictDurableObject(stub);

    const returnedVisitor = await stub.connectSoul({
      requestId: "ripple_visitor_return",
      token: visitorToken,
      renderer: "canvas",
      reducedMotion: true,
      gatewayShard: 0,
    });
    await pauseSimulation(stub);
    const repeatedMessages = await sendClientMessage(stub, returnedVisitor.attachment.sessionId, {
      v: PROTOCOL_VERSION,
      type: "leavePublicRipple",
      requestId: "ripple_repeated_after_eviction",
      slug: slug ?? "missing",
    });
    const repeated = repeatedMessages.find(
      (message): message is RitualAckMessage => message.type === "ritualAck",
    );
    expect(repeated).toMatchObject({ accepted: false, reason: "cooldown" });
    expect(repeated?.nextOfferingAt).toBeGreaterThan(Date.now());

    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM public_ripple_limits WHERE visitor_soul_id = ? AND slug = ?",
        returnedVisitor.attachment.soulId,
        slug ?? "missing",
      ).one().count).toBe(1);
    });
    await stub.disconnectSoul(returnedVisitor.attachment.sessionId);
  });

  it("does not present failed or expired Keeper checkout attempts as pending", async () => {
    const stub = env.POND_CORE.getByName("growth-edge-keeper-pending");
    const connection = await stub.connectSoul({
      requestId: "keeper_edge_hello",
      renderer: "canvas",
      reducedMotion: true,
      gatewayShard: 0,
    });
    const token = welcomeFrom(connection.messages).token;
    expect(token).toBeTruthy();
    await pauseSimulation(stub);
    const now = Date.now();
    const membershipId = "membership_keeper_edge";

    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      const sql = state.storage.sql;
      sql.exec("UPDATE souls SET completed_lives = 1 WHERE id = ?", connection.attachment.soulId);
      sql.exec(
        `INSERT INTO keeper_memberships(id, soul_id, updated_at, weekly_letters_enabled)
         VALUES (?, ?, ?, 0)`,
        membershipId,
        connection.attachment.soulId,
        now,
      );
      sql.exec(
        `INSERT INTO keeper_checkout_attempts(
          id, membership_id, idempotency_key, billing_interval, state, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'month', 'failed', ?, ?, ?)`,
        "attempt_keeper_failed",
        membershipId,
        "keeper-edge-failed-key",
        now + DAY_MS,
        now,
        now,
      );
      sql.exec(
        `INSERT INTO keeper_checkout_attempts(
          id, membership_id, idempotency_key, billing_interval, state, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'month', 'created', ?, ?, ?)`,
        "attempt_keeper_expired",
        membershipId,
        "keeper-edge-expired-key",
        now - 1,
        now - DAY_MS,
        now - DAY_MS,
      );
    });

    await expect(stub.getKeeperSummary({ token: token ?? "", billingConfigured: true })).resolves.toMatchObject({
      eligible: true,
      state: "eligible",
    });

    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      state.storage.sql.exec(
        "UPDATE keeper_checkout_attempts SET state = 'expired' WHERE id = 'attempt_keeper_expired'",
      );
      state.storage.sql.exec(
        `INSERT INTO keeper_checkout_attempts(
          id, membership_id, idempotency_key, billing_interval, state, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'year', 'pending', ?, ?, ?)`,
        "attempt_keeper_live",
        membershipId,
        "keeper-edge-live-key",
        Date.now() + DAY_MS,
        Date.now(),
        Date.now(),
      );
    });
    await expect(stub.getKeeperSummary({ token: token ?? "", billingConfigured: true })).resolves.toMatchObject({
      state: "pending",
    });
    await stub.disconnectSoul(connection.attachment.sessionId);
  });

  it("maps an unconfirmed-email Keeper weekly-letter update to HTTP 409", async () => {
    const updateKeeperPreferences = vi.fn().mockRejectedValue(new Error("email_required"));
    const response = await worker.fetch(new Request("http://example.com/api/v3/keeper", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${OWNER_TOKEN}`,
        "Content-Type": "application/json",
        Origin: ALLOWED_ORIGIN,
      },
      body: JSON.stringify({ weeklyLetters: true }),
    }), apiEnv({ updateKeeperPreferences }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "email_required" });
    expect(updateKeeperPreferences).toHaveBeenCalledWith({
      token: OWNER_TOKEN,
      dedication: undefined,
      weeklyLetters: true,
    });
  });

  it("suppresses proactive mail for Permanent bounces but not Transient bounces", async () => {
    const stub = env.POND_CORE.getByName("growth-edge-resend-bounces");
    const transientSoul = await stub.connectSoul({
      requestId: "bounce_transient_hello",
      renderer: "canvas",
      reducedMotion: true,
      gatewayShard: 0,
    });
    const permanentSoul = await stub.connectSoul({
      requestId: "bounce_permanent_hello",
      renderer: "canvas",
      reducedMotion: true,
      gatewayShard: 0,
    });
    await pauseSimulation(stub);
    const now = Date.now();

    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      const sql = state.storage.sql;
      for (const [soulId, emailHash] of [
        [transientSoul.attachment.soulId, "email_hash_transient_edge"],
        [permanentSoul.attachment.soulId, "email_hash_permanent_edge"],
      ] as const) {
        sql.exec(
          `INSERT INTO pond_letter_preferences(
            soul_id, email_hash, status, consent_version, mortal_letters_enabled, keeper_letters_enabled,
            requested_at, confirmed_at
          ) VALUES (?, ?, 'confirmed', 1, 1, 1, ?, ?)`,
          soulId,
          emailHash,
          now,
          now,
        );
      }
      sql.exec(
        `INSERT INTO email_deliveries(
          id, dedupe_key, soul_id, delivery_kind, status, due_at, sent_at, provider_id, created_at
        ) VALUES (?, ?, ?, 'mortal_death', 'sent', ?, ?, ?, ?)`,
        "delivery_transient",
        "mortal-death:transient-edge",
        transientSoul.attachment.soulId,
        now,
        now,
        "resend_transient_edge",
        now,
      );
      sql.exec(
        `INSERT INTO email_deliveries(
          id, dedupe_key, soul_id, delivery_kind, status, due_at, sent_at, provider_id, created_at
        ) VALUES (?, ?, ?, 'mortal_death', 'sent', ?, ?, ?, ?)`,
        "delivery_permanent",
        "mortal-death:permanent-edge",
        permanentSoul.attachment.soulId,
        now,
        now,
        "resend_permanent_edge",
        now,
      );
      sql.exec(
        `INSERT INTO email_deliveries(
          id, dedupe_key, soul_id, delivery_kind, status, due_at, created_at
        ) VALUES (?, ?, ?, 'keeper_weekly', 'pending', ?, ?)`,
        "delivery_permanent_future",
        "keeper-weekly:permanent-edge",
        permanentSoul.attachment.soulId,
        now + DAY_MS,
        now,
      );
    });

    await expect(stub.applyResendWebhook({
      webhookId: "webhook_transient_edge",
      eventType: "email.bounced",
      providerId: "resend_transient_edge",
      eventCreatedAt: now,
      receivedAt: now + 1,
      bounceType: "Transient",
    })).resolves.toEqual({ duplicate: false });
    await expect(stub.applyResendWebhook({
      webhookId: "webhook_permanent_edge",
      eventType: "email.bounced",
      providerId: "resend_permanent_edge",
      eventCreatedAt: now,
      receivedAt: now + 2,
      bounceType: "Permanent",
    })).resolves.toEqual({ duplicate: false });

    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      const sql = state.storage.sql;
      expect(sql.exec<{
        status: string;
        mortal_letters_enabled: number;
        keeper_letters_enabled: number;
      }>(
        `SELECT status, mortal_letters_enabled, keeper_letters_enabled
         FROM pond_letter_preferences WHERE soul_id = ?`,
        transientSoul.attachment.soulId,
      ).one()).toEqual({ status: "confirmed", mortal_letters_enabled: 1, keeper_letters_enabled: 1 });
      expect(sql.exec<{ status: string; failure_code: string | null }>(
        "SELECT status, failure_code FROM email_deliveries WHERE id = 'delivery_transient'",
      ).one()).toEqual({ status: "failed", failure_code: "non_permanent_bounce" });

      expect(sql.exec<{
        status: string;
        mortal_letters_enabled: number;
        keeper_letters_enabled: number;
      }>(
        `SELECT status, mortal_letters_enabled, keeper_letters_enabled
         FROM pond_letter_preferences WHERE soul_id = ?`,
        permanentSoul.attachment.soulId,
      ).one()).toEqual({ status: "suppressed", mortal_letters_enabled: 0, keeper_letters_enabled: 0 });
      expect(sql.exec<{ status: string; failure_code: string | null }>(
        "SELECT status, failure_code FROM email_deliveries WHERE id = 'delivery_permanent'",
      ).one()).toEqual({ status: "failed", failure_code: "hard_bounce" });
      expect(sql.exec<{ status: string; failure_code: string | null }>(
        "SELECT status, failure_code FROM email_deliveries WHERE id = 'delivery_permanent_future'",
      ).one()).toEqual({ status: "suppressed", failure_code: "hard_bounce" });
      expect(sql.exec<{ bounce_type: string | null }>(
        "SELECT bounce_type FROM resend_webhook_events WHERE id = 'webhook_permanent_edge'",
      ).one().bounce_type).toBe("Permanent");
      expect(sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM email_suppressions WHERE email_hash = 'email_hash_transient_edge'",
      ).one().count).toBe(0);
      expect(sql.exec<{ reason: string }>(
        "SELECT reason FROM email_suppressions WHERE email_hash = 'email_hash_permanent_edge'",
      ).one().reason).toBe("hard_bounce");
    });

    await stub.disconnectSoul(transientSoul.attachment.sessionId);
    await stub.disconnectSoul(permanentSoul.attachment.sessionId);
  });

  it("counts only post-delivery authenticated reconnects, including later on the same UTC day", async () => {
    const stub = env.POND_CORE.getByName("growth-edge-letter-return-window");
    await stub.getPublicStatus();
    const cohortStart = Math.floor((Date.now() - 20 * DAY_MS) / DAY_MS) * DAY_MS;
    const cohortDay = utcDay(cohortStart);
    const deliveryAt = cohortStart + 2 * DAY_MS + 12 * 60 * 60 * 1000;
    const cases = ["post_delivery", "pre_delivery", "d0_only"] as const;

    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      const sql = state.storage.sql;
      cases.forEach((caseName, index) => {
        const soulId = `letter_return_${caseName}`;
        const createdAt = cohortStart + 100 + index;
        sql.exec(
          `INSERT INTO souls(id, token_hash, poetic_name, tint, created_at, last_seen_at, completed_lives)
           VALUES (?, ?, ?, ?, ?, ?, 1)`,
          soulId,
          `hash_${caseName}`,
          `Letter Return ${index}`,
          0x71c9bd + index,
          createdAt,
          createdAt,
        );
        sql.exec(
          `INSERT INTO soul_credentials(id, soul_id, token_hash, created_at, last_used_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, NULL)`,
          `credential_${caseName}`,
          soulId,
          `hash_${caseName}`,
          createdAt,
          createdAt,
        );
        sql.exec(
          `INSERT INTO lives(id, soul_id, life_kind, started_at, ends_at, ended_at, owner_soul_id)
           VALUES (?, ?, 'mortal', ?, ?, ?, ?)`,
          `life_${caseName}`,
          soulId,
          cohortStart + 1_000 + index,
          cohortStart + DAY_MS,
          cohortStart + DAY_MS,
          soulId,
        );
        sql.exec(
          `INSERT INTO soul_visits(soul_id, day, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?)`,
          soulId,
          cohortDay,
          cohortStart + 2_000 + index,
          cohortStart + 3_000 + index,
        );
        sql.exec(
          `INSERT INTO email_deliveries(
            id, dedupe_key, soul_id, delivery_kind, status, due_at, delivered_at, created_at
          ) VALUES (?, ?, ?, 'mortal_death', 'delivered', ?, ?, ?)`,
          `delivery_${caseName}`,
          `mortal-death:${caseName}`,
          soulId,
          deliveryAt,
          deliveryAt,
          deliveryAt - 1_000,
        );
      });

      for (const caseName of ["post_delivery", "pre_delivery"] as const) {
        const visitAt = caseName === "post_delivery" ? deliveryAt + 60_000 : deliveryAt - 60_000;
        sql.exec(
          `INSERT INTO soul_visits(soul_id, day, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?)`,
          `letter_return_${caseName}`,
          utcDay(visitAt),
          visitAt,
          visitAt,
        );
      }
      sql.exec(
        `INSERT INTO soul_events(id, soul_id, event_kind, event_at, payload_json)
         VALUES (?, ?, 'authenticated_connection', ?, '{}')`,
        "event_post_delivery",
        "letter_return_post_delivery",
        deliveryAt + 60_000,
      );
      sql.exec(
        `INSERT INTO soul_events(id, soul_id, event_kind, event_at, payload_json)
         VALUES (?, ?, 'authenticated_connection', ?, '{}')`,
        "event_pre_delivery",
        "letter_return_pre_delivery",
        deliveryAt - 60_000,
      );
      sql.exec(
        `INSERT INTO soul_events(id, soul_id, event_kind, event_at, payload_json)
         VALUES (?, ?, 'authenticated_connection', ?, '{}')`,
        "event_d0_only",
        "letter_return_d0_only",
        cohortStart + 60_000,
      );
    });

    const report = await stub.getRetentionReport({ from: cohortDay, to: cohortDay });
    expect(report.totals).toMatchObject({
      eligibleSouls: 3,
      returnedSouls: 2,
      deliveredLetters: 3,
      returnedAfterLetter: 1,
      letterReturnRate: 1 / 3,
    });
    expect(report.cohorts).toHaveLength(1);
    expect(report.cohorts[0]).toMatchObject({
      day: cohortDay,
      eligibleSouls: 3,
      returnedSouls: 2,
      deliveredLetters: 3,
      returnedAfterLetter: 1,
      letterReturnRate: 1 / 3,
    });
  });
});
