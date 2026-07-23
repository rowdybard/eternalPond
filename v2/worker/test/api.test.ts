import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const billingMocks = vi.hoisted(() => ({
  createKeeperCheckout: vi.fn(),
  createKeeperPortal: vi.fn(),
  keeperBillingConfigured: vi.fn(),
  reconcileStripeEvent: vi.fn(),
  retrieveKeeperCheckout: vi.fn(),
  verifyStripeWebhook: vi.fn(),
}));

const emailMocks = vi.hoisted(() => ({
  verifyResendWebhook: vi.fn(),
}));

vi.mock("../src/billing", () => billingMocks);

vi.mock("../src/email", () => ({
  emailConfigured: vi.fn(() => false),
  escapeHtml: (value: string) => value,
  sendPondEmail: vi.fn(),
  ...emailMocks,
}));

import worker from "../src/index";

const ALLOWED_ORIGIN = "http://localhost:5173";
const CLAIM = "claim_abcdefghijklmnopqrstuvwxyz0123456789";
const OWNER_TOKEN = "owner_abcdefghijklmnopqrstuvwxyz0123456789";

function apiEnv(core: object, overrides: Record<string, string> = {}): Env {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "POND_CORE") return { getByName: () => core };
      if (typeof property === "string" && Object.hasOwn(overrides, property)) return overrides[property];
      return Reflect.get(target, property, receiver);
    },
  });
}

function ownerHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${OWNER_TOKEN}`,
    "Content-Type": "application/json",
    Origin: ALLOWED_ORIGIN,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  billingMocks.keeperBillingConfigured.mockReturnValue(false);
});

describe("Eternal Pond HTTP API boundary", () => {
  it("allows preflight only for configured browser origins", async () => {
    const core = {};
    const rejected = await worker.fetch(new Request("http://example.com/api/v3/keeper", {
      method: "OPTIONS",
      headers: { Origin: "https://attacker.example" },
    }), apiEnv(core));
    expect(rejected.status).toBe(403);
    expect(rejected.headers.has("Access-Control-Allow-Origin")).toBe(false);

    const accepted = await worker.fetch(new Request("http://example.com/api/v3/keeper", {
      method: "OPTIONS",
      headers: { Origin: ALLOWED_ORIGIN },
    }), apiEnv(core));
    expect(accepted.status).toBe(204);
    expect(accepted.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
    expect(accepted.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });

  it("returns only the public-soul RPC result and hides invalid slugs as not found", async () => {
    const view = {
      slug: "quiet-thistle-under-glass",
      name: "Quiet Thistle under Glass",
      tint: 123,
      status: "alive",
      completedLives: 2,
      soulId: "internal_soul_must_not_escape",
      email: "quiet@example.com",
    };
    const core = { getPublicSoul: vi.fn().mockResolvedValue(view) };
    const response = await worker.fetch(
      new Request("http://example.com/api/v3/public/souls/quiet-thistle-under-glass"),
      apiEnv(core),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      slug: "quiet-thistle-under-glass",
      name: "Quiet Thistle under Glass",
      tint: 123,
      status: "alive",
      completedLives: 2,
    });
    expect(core.getPublicSoul).toHaveBeenCalledWith({ slug: "quiet-thistle-under-glass" });

    const invalid = await worker.fetch(
      new Request("http://example.com/api/v3/public/souls/not_a_public_slug"),
      apiEnv(core),
    );
    expect(invalid.status).toBe(404);
    expect(core.getPublicSoul).toHaveBeenCalledTimes(1);
  });

  it("uses a timing-safe bearer gate and validates retention date ranges", async () => {
    const report = { generatedAt: 1, cohorts: [] };
    const core = { getRetentionReport: vi.fn().mockResolvedValue(report) };
    const testEnv = apiEnv(core, { ANALYTICS_BEARER_TOKEN: "secret.with-punctuation=" });
    const rejected = await worker.fetch(new Request("http://example.com/api/v3/analytics/retention", {
      headers: { Authorization: "Bearer wrong" },
    }), testEnv);
    expect(rejected.status).toBe(401);
    expect(core.getRetentionReport).not.toHaveBeenCalled();

    const invalidRange = await worker.fetch(new Request(
      "http://example.com/api/v3/analytics/retention?from=2026-08-01&to=2026-07-01",
      { headers: { Authorization: "Bearer secret.with-punctuation=" } },
    ), testEnv);
    expect(invalidRange.status).toBe(400);

    const accepted = await worker.fetch(new Request(
      "http://example.com/api/v3/analytics/retention?from=2026-07-01&to=2026-07-09",
      { headers: { Authorization: "Bearer secret.with-punctuation=" } },
    ), testEnv);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual(report);
    expect(core.getRetentionReport).toHaveBeenCalledWith({ from: "2026-07-01", to: "2026-07-09" });
  });

  it("requires an allowed origin and bounded JSON for secure links", async () => {
    const core = {
      inspectSecureLink: vi.fn().mockResolvedValue({ valid: true, purpose: "confirm_email" }),
      redeemSecureLink: vi.fn().mockResolvedValue({ ok: true, purpose: "return_soul", token: "new_safe_token" }),
    };
    const rejected = await worker.fetch(new Request("http://example.com/api/v3/links/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
      body: JSON.stringify({ claim: CLAIM }),
    }), apiEnv(core));
    expect(rejected.status).toBe(403);

    const oversized = await worker.fetch(new Request("http://example.com/api/v3/links/inspect", {
      method: "POST",
      headers: {
        "Content-Length": String(9 * 1024),
        "Content-Type": "application/json",
        Origin: ALLOWED_ORIGIN,
      },
      body: JSON.stringify({ claim: CLAIM }),
    }), apiEnv(core));
    expect(oversized.status).toBe(413);
    expect(core.inspectSecureLink).not.toHaveBeenCalled();

    const accepted = await worker.fetch(new Request("http://example.com/api/v3/links/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ claim: CLAIM }),
    }), apiEnv(core));
    expect(accepted.status).toBe(200);
    expect(core.inspectSecureLink).toHaveBeenCalledWith({ claim: CLAIM });

    const redeemed = await worker.fetch(new Request("http://example.com/api/v3/links/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ claim: CLAIM, currentToken: OWNER_TOKEN }),
    }), apiEnv(core));
    expect(redeemed.status).toBe(200);
    expect(core.redeemSecureLink).toHaveBeenCalledWith({ claim: CLAIM, currentToken: OWNER_TOKEN });
  });

  it("authenticates Keeper owner routes and normalizes preference updates", async () => {
    const summary = {
      configured: false,
      eligible: true,
      requiresConfirmedEmail: false,
      state: "eligible",
      weeklyLetters: true,
      dedication: "for everyone by the water",
    };
    const core = {
      getKeeperSummary: vi.fn().mockResolvedValue(summary),
      updateKeeperPreferences: vi.fn().mockResolvedValue(summary),
    };
    const noOrigin = await worker.fetch(new Request("http://example.com/api/v3/keeper", {
      headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
    }), apiEnv(core));
    expect(noOrigin.status).toBe(403);

    const read = await worker.fetch(new Request("http://example.com/api/v3/keeper", {
      headers: { Authorization: `Bearer ${OWNER_TOKEN}`, Origin: ALLOWED_ORIGIN },
    }), apiEnv(core));
    expect(read.status).toBe(200);
    expect(core.getKeeperSummary).toHaveBeenCalledWith({ token: OWNER_TOKEN, billingConfigured: false });

    const patch = await worker.fetch(new Request("http://example.com/api/v3/keeper", {
      method: "PATCH",
      headers: ownerHeaders(),
      body: JSON.stringify({ dedication: "  for   everyone by the water  ", weeklyLetters: true }),
    }), apiEnv(core));
    expect(patch.status).toBe(200);
    expect(core.updateKeeperPreferences).toHaveBeenCalledWith({
      token: OWNER_TOKEN,
      dedication: "for everyone by the water",
      weeklyLetters: true,
    });
  });

  it("creates Keeper Checkout only from the server-side preparation", async () => {
    billingMocks.keeperBillingConfigured.mockReturnValue(true);
    billingMocks.createKeeperCheckout.mockResolvedValue({
      id: "cs_test_safe",
      url: "https://checkout.stripe.test/safe",
      expiresAt: 123456,
    });
    const core = {
      prepareKeeperCheckout: vi.fn().mockResolvedValue({
        ok: true,
        attemptId: "attempt_safe",
        membershipRef: "membership_safe",
        idempotencyKey: "keeper-checkout-attempt_safe",
      }),
      recordKeeperCheckout: vi.fn().mockResolvedValue(undefined),
      failKeeperCheckout: vi.fn().mockResolvedValue(undefined),
    };
    const forged = await worker.fetch(new Request("http://example.com/api/v3/keeper/checkout", {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify({ interval: "month", priceId: "price_attacker" }),
    }), apiEnv(core));
    expect(forged.status).toBe(400);
    expect(billingMocks.createKeeperCheckout).not.toHaveBeenCalled();

    const response = await worker.fetch(new Request("http://example.com/api/v3/keeper/checkout", {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify({ interval: "month" }),
    }), apiEnv(core));

    expect(response.status).toBe(200);
    expect(billingMocks.createKeeperCheckout).toHaveBeenCalledWith(expect.anything(), {
      membershipRef: "membership_safe",
      interval: "month",
      customerId: undefined,
      idempotencyKey: "keeper-checkout-attempt_safe",
    });
    expect(core.recordKeeperCheckout).toHaveBeenCalledWith({
      attemptId: "attempt_safe",
      sessionId: "cs_test_safe",
      expiresAt: 123456,
    });
  });

  it("creates a Keeper portal only for the canonical customer", async () => {
    billingMocks.keeperBillingConfigured.mockReturnValue(true);
    billingMocks.createKeeperPortal.mockResolvedValue({ url: "https://billing.stripe.test/safe" });
    const core = {
      prepareKeeperPortal: vi.fn().mockResolvedValue({ ok: true, customerId: "cus_canonical" }),
    };
    const response = await worker.fetch(new Request("http://example.com/api/v3/keeper/portal", {
      method: "POST",
      headers: ownerHeaders(),
    }), apiEnv(core));
    expect(response.status).toBe(200);
    expect(core.prepareKeeperPortal).toHaveBeenCalledWith({ token: OWNER_TOKEN });
    expect(billingMocks.createKeeperPortal).toHaveBeenCalledWith(expect.anything(), "cus_canonical");
    expect(await response.json()).toEqual({ ok: true, url: "https://billing.stripe.test/safe" });
  });

  it("verifies raw provider webhooks before forwarding normalized events", async () => {
    emailMocks.verifyResendWebhook.mockReturnValue({
      type: "email.delivered",
      created_at: "2026-07-22T12:00:00.000Z",
      data: { email_id: "resend_email_safe" },
    });
    billingMocks.verifyStripeWebhook.mockResolvedValue({ id: "evt_safe" });
    billingMocks.reconcileStripeEvent.mockResolvedValue({
      eventId: "evt_safe",
      type: "checkout.session.completed",
      objectId: "cs_safe",
      createdAt: 123,
    });
    const core = {
      applyResendWebhook: vi.fn().mockResolvedValue({ duplicate: false }),
      applyStripeEvent: vi.fn().mockResolvedValue({ duplicate: true }),
    };
    const testEnv = apiEnv(core, {
      RESEND_WEBHOOK_SECRET: "whsec_test",
      STRIPE_SECRET_KEY: "sk_test_mock",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
    });
    emailMocks.verifyResendWebhook.mockImplementationOnce(() => {
      throw new Error("bad signature");
    });
    const rejectedResend = await worker.fetch(new Request("http://example.com/api/v3/resend/webhook", {
      method: "POST",
      headers: { "svix-id": "msg_bad", "svix-timestamp": "123", "svix-signature": "v1,bad" },
      body: "{\"type\":\"email.delivered\"}",
    }), testEnv);
    expect(rejectedResend.status).toBe(400);
    expect(core.applyResendWebhook).not.toHaveBeenCalled();

    emailMocks.verifyResendWebhook.mockReturnValue({
      type: "email.delivered",
      created_at: "2026-07-22T12:00:00.000Z",
      data: { email_id: "resend_email_safe" },
    });
    const resend = await worker.fetch(new Request("http://example.com/api/v3/resend/webhook", {
      method: "POST",
      headers: { "svix-id": "msg_safe", "svix-timestamp": "123", "svix-signature": "v1,safe" },
      body: "{\"type\":\"email.delivered\"}",
    }), testEnv);
    expect(resend.status).toBe(200);
    expect(emailMocks.verifyResendWebhook).toHaveBeenCalledWith(expect.anything(), "{\"type\":\"email.delivered\"}", {
      id: "msg_safe",
      timestamp: "123",
      signature: "v1,safe",
    });
    expect(core.applyResendWebhook).toHaveBeenCalledWith(expect.objectContaining({
      webhookId: "msg_safe",
      eventType: "email.delivered",
      providerId: "resend_email_safe",
    }));

    billingMocks.verifyStripeWebhook.mockRejectedValueOnce(new Error("bad signature"));
    const rejectedStripe = await worker.fetch(new Request("http://example.com/api/v3/stripe/webhook", {
      method: "POST",
      headers: { "Stripe-Signature": "t=123,v1=bad" },
      body: "{\"id\":\"evt_bad\"}",
    }), testEnv);
    expect(rejectedStripe.status).toBe(400);
    expect(core.applyStripeEvent).not.toHaveBeenCalled();

    billingMocks.verifyStripeWebhook.mockResolvedValue({ id: "evt_safe" });
    const stripe = await worker.fetch(new Request("http://example.com/api/v3/stripe/webhook", {
      method: "POST",
      headers: { "Stripe-Signature": "t=123,v1=safe" },
      body: "{\"id\":\"evt_safe\"}",
    }), testEnv);
    expect(stripe.status).toBe(200);
    expect(core.applyStripeEvent).toHaveBeenCalledWith(expect.objectContaining({ eventId: "evt_safe" }));
    expect(await stripe.json()).toEqual({ received: true, duplicate: true });

    const oversized = await worker.fetch(new Request("http://example.com/api/v3/stripe/webhook", {
      method: "POST",
      headers: { "Content-Length": String(129 * 1024), "Stripe-Signature": "t=123,v1=safe" },
      body: "{}",
    }), testEnv);
    expect(oversized.status).toBe(413);
  });
});
