import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type PondLetterAckMessage,
  type RitualAckMessage,
  type ServerMessage,
  type SharingAckMessage,
  type WelcomeMessage,
} from "@eternal-pond/shared";
import type { PondCoreV2 } from "../src/core";
import type { NormalizedStripeEvent } from "../src/growth-types";
import worker from "../src/index";

const DAY_MS = 24 * 60 * 60 * 1000;
const ALLOWED_ORIGIN = "http://localhost:5173";
const OWNER_TOKEN = "owner_abcdefghijklmnopqrstuvwxyz0123456789";
const MONTHLY_PRICE_ID = "price_growth_edges_monthly";
const EMAIL_ENCRYPTION_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

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
  message: Exclude<ClientMessage, { type: "hello" }>,
): Promise<ServerMessage[]> {
  const result = await stub.receiveBatch({
    gatewayShard: 0,
    entries: [{ sessionId, message }],
  });
  return result[0]?.messages ?? [];
}

function apiEnv(core: object, overrides: Record<string, string> = {}): Env {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "POND_CORE") return { getByName: () => core };
      if (typeof property === "string" && Object.hasOwn(overrides, property)) return overrides[property];
      return Reflect.get(target, property, receiver);
    },
  });
}

describe("Eternal Pond growth edge invariants", () => {
  it("deduplicates a stable page visit across transport reconnects and extra tabs", async () => {
    const stub = env.POND_CORE.getByName("growth-edge-stable-page-visits");
    const firstPage = await stub.connectSoul({
      requestId: "visit_first_connection",
      visitId: "visit_stable_page_a",
      renderer: "canvas",
      reducedMotion: true,
      gatewayShard: 0,
    });
    const token = welcomeFrom(firstPage.messages).token;
    expect(token).toBeTruthy();
    await pauseSimulation(stub);
    await stub.disconnectSoul(firstPage.attachment.sessionId);

    const transportReconnect = await stub.connectSoul({
      requestId: "visit_transport_reconnect",
      visitId: "visit_stable_page_a",
      token,
      renderer: "canvas",
      reducedMotion: true,
      gatewayShard: 0,
    });
    const extraTab = await stub.connectSoul({
      requestId: "visit_extra_tab",
      visitId: "visit_extra_tab_b",
      token,
      renderer: "canvas",
      reducedMotion: true,
      gatewayShard: 0,
    });
    await pauseSimulation(stub);
    await stub.disconnectSoul(transportReconnect.attachment.sessionId);
    await stub.disconnectSoul(extraTab.attachment.sessionId);

    const genuinelyNewPage = await stub.connectSoul({
      requestId: "visit_new_page",
      visitId: "visit_genuine_page_c",
      token,
      renderer: "canvas",
      reducedMotion: true,
      gatewayShard: 0,
    });
    await pauseSimulation(stub);

    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      const sql = state.storage.sql;
      expect(sql.exec<{ visit_id: string; counted: number }>(`
        SELECT visit_id, counted FROM soul_page_visits
        WHERE soul_id = ? ORDER BY visit_id
      `, firstPage.attachment.soulId).toArray()).toEqual([
        { visit_id: "visit_extra_tab_b", counted: 0 },
        { visit_id: "visit_genuine_page_c", counted: 1 },
        { visit_id: "visit_stable_page_a", counted: 1 },
      ]);
      expect(sql.exec<{ count: number }>(`
        SELECT COUNT(*) AS count FROM soul_events
        WHERE soul_id = ? AND event_kind = 'authenticated_connection'
      `, firstPage.attachment.soulId).one().count).toBe(1);
    });
    await stub.disconnectSoul(genuinelyNewPage.attachment.sessionId);
  });

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

  it("grants Keeper paid-through only from invoice.paid's authoritative period end", async () => {
    const stub = env.POND_CORE.getByName("growth-edge-stripe-paid-through-proof");
    const connection = await stub.connectSoul({
      requestId: "stripe_paid_through_hello",
      renderer: "canvas",
      reducedMotion: true,
      gatewayShard: 0,
    });
    await pauseSimulation(stub);
    await stub.disconnectSoul(connection.attachment.sessionId);
    const now = Date.now();
    const membershipId = "membership_stripe_paid_through_edge";
    const subscriptionId = "sub_stripe_paid_through_edge";
    const misleadingSubscriptionSnapshot = now + 365 * DAY_MS;
    const paidInvoiceThroughAt = now + 30 * DAY_MS;

    await runInDurableObject(stub, async (instance: PondCoreV2, state) => {
      const internal = instance as unknown as { env: Env };
      internal.env = {
        ...internal.env,
        STRIPE_MONTHLY_PRICE_ID: MONTHLY_PRICE_ID,
      } as unknown as Env;
      state.storage.sql.exec(
        `INSERT INTO keeper_memberships(id, soul_id, updated_at, weekly_letters_enabled)
         VALUES (?, ?, ?, 0)`,
        membershipId,
        connection.attachment.soulId,
        now,
      );
    });

    const subscription = {
      subscriptionId,
      membershipRef: membershipId,
      customerId: "cus_stripe_paid_through_edge",
      status: "active",
      priceId: MONTHLY_PRICE_ID,
      interval: "month",
      quantity: 1,
      cancelAtPeriodEnd: false,
      paidThroughAt: misleadingSubscriptionSnapshot,
    } satisfies NonNullable<NormalizedStripeEvent["subscription"]>;
    const nonInvoiceEvent: NormalizedStripeEvent = {
      eventId: "evt_subscription_update_no_payment",
      type: "customer.subscription.updated",
      objectId: subscriptionId,
      createdAt: now,
      subscription,
    };
    await expect(stub.applyStripeEvent(nonInvoiceEvent)).resolves.toEqual({ duplicate: false });

    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      const sql = state.storage.sql;
      const membership = sql.exec<{ activated_at: number | null; paid_through_at: number | null }>(
        "SELECT activated_at, paid_through_at FROM keeper_memberships WHERE id = ?",
        membershipId,
      ).one();
      expect(membership.activated_at).toBeNull();
      expect(membership.paid_through_at ?? 0).toBe(0);
      const storedSubscription = sql.exec<{ paid_through_at: number | null }>(
        "SELECT paid_through_at FROM keeper_subscriptions WHERE stripe_subscription_id = ?",
        subscriptionId,
      ).one();
      expect(storedSubscription.paid_through_at ?? 0).toBe(0);
      expect(sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM lives WHERE soul_id = ?",
        connection.attachment.soulId,
      ).one().count).toBe(0);
    });

    const paidInvoiceEvent: NormalizedStripeEvent = {
      eventId: "evt_invoice_paid_authoritative_period",
      type: "invoice.paid",
      objectId: "in_stripe_paid_through_edge",
      createdAt: now + 1,
      subscription,
      invoicePaid: true,
      paidInvoiceThroughAt,
    };
    await expect(stub.applyStripeEvent(paidInvoiceEvent)).resolves.toEqual({ duplicate: false });

    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      const sql = state.storage.sql;
      const membership = sql.exec<{ activated_at: number | null; paid_through_at: number | null }>(
        "SELECT activated_at, paid_through_at FROM keeper_memberships WHERE id = ?",
        membershipId,
      ).one();
      expect(membership.activated_at).toEqual(expect.any(Number));
      expect(membership.paid_through_at).toBe(paidInvoiceThroughAt);
      expect(sql.exec<{ paid_through_at: number | null }>(
        "SELECT paid_through_at FROM keeper_subscriptions WHERE stripe_subscription_id = ?",
        subscriptionId,
      ).one().paid_through_at).toBe(paidInvoiceThroughAt);
      expect(sql.exec<{ life_kind: string; ends_at: number | null }>(
        "SELECT life_kind, ends_at FROM lives WHERE soul_id = ?",
        connection.attachment.soulId,
      ).one()).toEqual({ life_kind: "memorial", ends_at: null });
    });
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

  it("keeps Keeper summaries available for recovery while billing configuration is disabled", async () => {
    const stub = env.POND_CORE.getByName("growth-edge-disabled-keeper-summary");
    const connection = await stub.connectSoul({
      requestId: "disabled_keeper_summary_hello",
      renderer: "canvas",
      reducedMotion: true,
      gatewayShard: 0,
    });
    const token = welcomeFrom(connection.messages).token;
    expect(token).toBeTruthy();
    await pauseSimulation(stub);

    await expect(stub.getKeeperSummary({ token: token ?? "", billingConfigured: false })).resolves.toMatchObject({
      configured: false,
      state: "none",
    });

    const now = Date.now();
    const paidThroughAt = now + 30 * DAY_MS;
    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      state.storage.sql.exec(
        `INSERT INTO keeper_memberships(
          id, soul_id, stripe_status, paid_through_at, activated_at, updated_at, weekly_letters_enabled
        ) VALUES (?, ?, 'active', ?, ?, ?, 0)`,
        "membership_disabled_recovery_edge",
        connection.attachment.soulId,
        paidThroughAt,
        now,
        now,
      );
    });

    await expect(stub.getKeeperSummary({ token: token ?? "", billingConfigured: false })).resolves.toMatchObject({
      configured: true,
      state: "active",
      paidThroughAt,
    });
    await stub.disconnectSoul(connection.attachment.sessionId);
  });

  it("hides the Keeper checkout route when billing is disabled", async () => {
    const prepareKeeperCheckout = vi.fn();
    const recoverySummary = {
      configured: false,
      eligible: true,
      requiresConfirmedEmail: false,
      state: "active",
      paidThroughAt: Date.now() + DAY_MS,
      weeklyLetters: false,
    };
    const getKeeperSummary = vi.fn().mockResolvedValue(recoverySummary);
    const testEnv = apiEnv(
      { getKeeperSummary, prepareKeeperCheckout },
      { KEEPER_BILLING_ENABLED: "false" },
    );
    const summaryResponse = await worker.fetch(new Request("http://example.com/api/v3/keeper", {
      headers: {
        Authorization: `Bearer ${OWNER_TOKEN}`,
        Origin: ALLOWED_ORIGIN,
      },
    }), testEnv);
    expect(summaryResponse.status).toBe(200);
    expect(await summaryResponse.json()).toEqual(recoverySummary);
    expect(getKeeperSummary).toHaveBeenCalledWith({
      token: OWNER_TOKEN,
      billingConfigured: false,
    });

    const response = await worker.fetch(new Request("http://example.com/api/v3/keeper/checkout", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OWNER_TOKEN}`,
        "Content-Type": "application/json",
        Origin: ALLOWED_ORIGIN,
      },
      body: JSON.stringify({ interval: "month" }),
    }), testEnv);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(prepareKeeperCheckout).not.toHaveBeenCalled();
  });

  it("preserves both Pond Letter switches when changing only the email address", async () => {
    const stub = env.POND_CORE.getByName("growth-edge-email-switch-preservation");
    const connection = await stub.connectSoul({
      requestId: "email_switches_hello",
      renderer: "canvas",
      reducedMotion: true,
      gatewayShard: 0,
    });
    await pauseSimulation(stub);
    const now = Date.now();

    await runInDurableObject(stub, async (instance: PondCoreV2, state) => {
      const internal = instance as unknown as {
        env: Env;
        sendEmailDelivery(deliveryId: string, existingPrimaryClaim?: string): Promise<boolean>;
      };
      internal.env = {
        ...internal.env,
        EMAIL_ENCRYPTION_KEY,
        PUBLIC_APP_ORIGIN: "https://pond.example",
        RESEND_API_KEY: "re_test_growth_edges",
        RESEND_FROM: "Pond <pond@example.com>",
      } as unknown as Env;
      internal.sendEmailDelivery = async () => true;
      state.storage.sql.exec(
        `INSERT INTO pond_letter_preferences(
          soul_id, email_hash, email_masked, status, consent_version,
          mortal_letters_enabled, keeper_letters_enabled, requested_at, confirmed_at
        ) VALUES (?, 'email_hash_before_change', 'o***@example.com', 'confirmed', 4, 0, 1, ?, ?)`,
        connection.attachment.soulId,
        now,
        now,
      );
    });

    const messages = await sendClientMessage(stub, connection.attachment.sessionId, {
      v: PROTOCOL_VERSION,
      type: "setPondLetter",
      requestId: "email_change_only",
      email: "new-address@example.com",
    });
    const acknowledgement = messages.find(
      (message): message is PondLetterAckMessage => message.type === "pondLetterAck",
    );
    expect(acknowledgement).toMatchObject({
      accepted: true,
      confirmationSent: true,
      preference: {
        status: "pending",
        mortalLetters: false,
        keeperLetters: true,
      },
    });

    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      const row = state.storage.sql.exec<{
        email_hash: string | null;
        consent_version: number;
        mortal_letters_enabled: number;
        keeper_letters_enabled: number;
        status: string;
      }>(`
        SELECT email_hash, consent_version, mortal_letters_enabled, keeper_letters_enabled, status
        FROM pond_letter_preferences WHERE soul_id = ?
      `, connection.attachment.soulId).one();
      expect(row).toMatchObject({
        consent_version: 5,
        mortal_letters_enabled: 0,
        keeper_letters_enabled: 1,
        status: "pending",
      });
      expect(row.email_hash).not.toBe("email_hash_before_change");
    });
    await stub.disconnectSoul(connection.attachment.sessionId);
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
          id, dedupe_key, soul_id, email_hash, consent_version, delivery_kind, status,
          due_at, sent_at, provider_id, created_at
        ) VALUES (?, ?, ?, ?, 1, 'mortal_death', 'sent', ?, ?, ?, ?)`,
        "delivery_transient",
        "mortal-death:transient-edge",
        transientSoul.attachment.soulId,
        "email_hash_transient_edge",
        now,
        now,
        "resend_transient_edge",
        now,
      );
      sql.exec(
        `INSERT INTO email_deliveries(
          id, dedupe_key, soul_id, email_hash, consent_version, delivery_kind, status,
          due_at, sent_at, provider_id, created_at
        ) VALUES (?, ?, ?, ?, 1, 'mortal_death', 'sent', ?, ?, ?, ?)`,
        "delivery_permanent",
        "mortal-death:permanent-edge",
        permanentSoul.attachment.soulId,
        "email_hash_permanent_edge",
        now,
        now,
        "resend_permanent_edge",
        now,
      );
      sql.exec(
        `INSERT INTO email_deliveries(
          id, dedupe_key, soul_id, email_hash, consent_version, delivery_kind, status, due_at, created_at
        ) VALUES (?, ?, ?, ?, 1, 'keeper_weekly', 'pending', ?, ?)`,
        "delivery_permanent_future",
        "keeper-weekly:permanent-edge",
        permanentSoul.attachment.soulId,
        "email_hash_permanent_edge",
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

  it("suppresses the delivery's snapshotted address without suppressing a newer preference", async () => {
    const stub = env.POND_CORE.getByName("growth-edge-snapshotted-email-bounce");
    const connection = await stub.connectSoul({
      requestId: "snapshot_bounce_hello",
      renderer: "canvas",
      reducedMotion: true,
      gatewayShard: 0,
    });
    await pauseSimulation(stub);
    const now = Date.now();

    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      const sql = state.storage.sql;
      sql.exec(
        `INSERT INTO pond_letter_preferences(
          soul_id, email_hash, status, consent_version, mortal_letters_enabled,
          keeper_letters_enabled, requested_at, confirmed_at
        ) VALUES (?, 'email_hash_new_preference', 'confirmed', 2, 1, 1, ?, ?)`,
        connection.attachment.soulId,
        now,
        now,
      );
      sql.exec(
        `INSERT INTO email_deliveries(
          id, dedupe_key, soul_id, email_hash, consent_version, delivery_kind,
          status, due_at, sent_at, provider_id, created_at
        ) VALUES (?, ?, ?, 'email_hash_old_snapshot', 1, 'mortal_death', 'sent', ?, ?, ?, ?)`,
        "delivery_old_snapshot",
        "mortal-death:old-snapshot-edge",
        connection.attachment.soulId,
        now,
        now,
        "resend_old_snapshot_edge",
        now,
      );
      sql.exec(
        `INSERT INTO email_deliveries(
          id, dedupe_key, soul_id, email_hash, consent_version, delivery_kind,
          status, due_at, created_at
        ) VALUES (?, ?, ?, 'email_hash_new_preference', 2, 'keeper_weekly', 'pending', ?, ?)`,
        "delivery_new_preference_pending",
        "keeper-weekly:new-preference-edge",
        connection.attachment.soulId,
        now + DAY_MS,
        now,
      );
    });

    await expect(stub.applyResendWebhook({
      webhookId: "webhook_old_snapshot_bounce",
      eventType: "email.bounced",
      providerId: "resend_old_snapshot_edge",
      eventCreatedAt: now + 10,
      receivedAt: now + 20,
      bounceType: "Permanent",
    })).resolves.toEqual({ duplicate: false });

    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      const sql = state.storage.sql;
      expect(sql.exec<{
        email_hash: string | null;
        status: string;
        mortal_letters_enabled: number;
        keeper_letters_enabled: number;
      }>(`
        SELECT email_hash, status, mortal_letters_enabled, keeper_letters_enabled
        FROM pond_letter_preferences WHERE soul_id = ?
      `, connection.attachment.soulId).one()).toEqual({
        email_hash: "email_hash_new_preference",
        status: "confirmed",
        mortal_letters_enabled: 1,
        keeper_letters_enabled: 1,
      });
      expect(sql.exec<{ reason: string }>(
        "SELECT reason FROM email_suppressions WHERE email_hash = 'email_hash_old_snapshot'",
      ).one().reason).toBe("hard_bounce");
      expect(sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM email_suppressions WHERE email_hash = 'email_hash_new_preference'",
      ).one().count).toBe(0);
      expect(sql.exec<{ status: string; failure_code: string | null }>(
        "SELECT status, failure_code FROM email_deliveries WHERE id = 'delivery_old_snapshot'",
      ).one()).toEqual({ status: "failed", failure_code: "hard_bounce" });
      expect(sql.exec<{ status: string; failure_code: string | null }>(
        "SELECT status, failure_code FROM email_deliveries WHERE id = 'delivery_new_preference_pending'",
      ).one()).toEqual({ status: "pending", failure_code: null });
    });
    await stub.disconnectSoul(connection.attachment.sessionId);
  });

  it("uses a delayed delivered webhook's provider event time instead of receipt time", async () => {
    const stub = env.POND_CORE.getByName("growth-edge-resend-delivered-time");
    const connection = await stub.connectSoul({
      requestId: "delivered_time_hello",
      renderer: "canvas",
      reducedMotion: true,
      gatewayShard: 0,
    });
    await pauseSimulation(stub);
    const receivedAt = Date.now();
    const eventCreatedAt = receivedAt - 4 * 60 * 60 * 1000;

    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      state.storage.sql.exec(
        `INSERT INTO email_deliveries(
          id, dedupe_key, soul_id, delivery_kind, status, due_at, sent_at, provider_id, created_at
        ) VALUES (?, ?, ?, 'mortal_death', 'sent', ?, ?, ?, ?)`,
        "delivery_delayed_webhook",
        "mortal-death:delayed-webhook-edge",
        connection.attachment.soulId,
        eventCreatedAt - 1_000,
        eventCreatedAt - 1_000,
        "resend_delayed_delivery_edge",
        eventCreatedAt - 2_000,
      );
    });

    await expect(stub.applyResendWebhook({
      webhookId: "webhook_delayed_delivery",
      eventType: "email.delivered",
      providerId: "resend_delayed_delivery_edge",
      eventCreatedAt,
      receivedAt,
    })).resolves.toEqual({ duplicate: false });

    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      expect(state.storage.sql.exec<{ status: string; delivered_at: number | null }>(
        "SELECT status, delivered_at FROM email_deliveries WHERE id = 'delivery_delayed_webhook'",
      ).one()).toEqual({ status: "delivered", delivered_at: eventCreatedAt });
      expect(state.storage.sql.exec<{ event_created_at: number | null; received_at: number }>(
        `SELECT event_created_at, received_at FROM resend_webhook_events
         WHERE id = 'webhook_delayed_delivery'`,
      ).one()).toEqual({ event_created_at: eventCreatedAt, received_at: receivedAt });
    });
    await stub.disconnectSoul(connection.attachment.sessionId);
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
      letterReturnRate: 0.3333,
    });
    expect(report.cohorts).toHaveLength(1);
    expect(report.cohorts[0]).toMatchObject({
      day: cohortDay,
      eligibleSouls: 3,
      returnedSouls: 2,
      deliveredLetters: 3,
      returnedAfterLetter: 1,
      letterReturnRate: 0.3333,
    });
  });
});
