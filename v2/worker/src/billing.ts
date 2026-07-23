import Stripe from "stripe";
import type { NormalizedStripeEvent, NormalizedStripeSubscription } from "./growth-types";

export type KeeperInterval = "month" | "year";

function stripeClient(env: Env): Stripe {
  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error("keeper_billing_not_configured");
  return new Stripe(secretKey, {
    apiVersion: "2026-06-24.dahlia",
    httpClient: Stripe.createFetchHttpClient(),
  });
}

export function keeperBillingConfigured(env: Env): boolean {
  return String(env.KEEPER_BILLING_ENABLED) === "true"
    && Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET)
    && Boolean(env.STRIPE_MONTHLY_PRICE_ID && env.STRIPE_ANNUAL_PRICE_ID)
    && Boolean(env.PUBLIC_APP_ORIGIN);
}

export function keeperPortalConfigured(env: Env): boolean {
  return Boolean(env.STRIPE_SECRET_KEY && env.PUBLIC_APP_ORIGIN);
}

export async function createKeeperCheckout(
  env: Env,
  input: {
    membershipRef: string;
    interval: KeeperInterval;
    customerId?: string;
    idempotencyKey: string;
  },
): Promise<{ id: string; url: string; expiresAt: number }> {
  if (!keeperBillingConfigured(env)) throw new Error("keeper_billing_not_configured");
  const price = input.interval === "month" ? env.STRIPE_MONTHLY_PRICE_ID : env.STRIPE_ANNUAL_PRICE_ID;
  const session = await stripeClient(env).checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    client_reference_id: input.membershipRef,
    customer: input.customerId,
    success_url: `${env.PUBLIC_APP_ORIGIN}/?keeper=return`,
    cancel_url: `${env.PUBLIC_APP_ORIGIN}/?keeper=cancel`,
    metadata: { pond_keeper_ref: input.membershipRef },
    subscription_data: { metadata: { pond_keeper_ref: input.membershipRef } },
  }, { idempotencyKey: input.idempotencyKey });
  if (!session.url) throw new Error("stripe_checkout_url_missing");
  return { id: session.id, url: session.url, expiresAt: session.expires_at * 1000 };
}

export async function createKeeperPortal(
  env: Env,
  customerId: string,
): Promise<{ url: string }> {
  if (!keeperPortalConfigured(env)) throw new Error("keeper_portal_not_configured");
  const session = await stripeClient(env).billingPortal.sessions.create({
    customer: customerId,
    configuration: env.STRIPE_PORTAL_CONFIGURATION_ID || undefined,
    return_url: `${env.PUBLIC_APP_ORIGIN}/`,
  });
  return { url: session.url };
}

export async function retrieveKeeperCheckout(env: Env, sessionId: string): Promise<{ id: string; url: string; expiresAt: number }> {
  const session = await stripeClient(env).checkout.sessions.retrieve(sessionId);
  if (!session.url) throw new Error("stripe_checkout_url_missing");
  return { id: session.id, url: session.url, expiresAt: session.expires_at * 1000 };
}

export async function verifyStripeWebhook(env: Env, payload: string, signature: string): Promise<Stripe.Event> {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new Error("stripe_webhook_not_configured");
  return stripeClient(env).webhooks.constructEventAsync(
    payload,
    signature,
    env.STRIPE_WEBHOOK_SECRET,
    undefined,
    Stripe.createSubtleCryptoProvider(),
  );
}

export async function retrieveStripeSubscription(env: Env, subscriptionId: string): Promise<Stripe.Subscription> {
  return stripeClient(env).subscriptions.retrieve(subscriptionId, { expand: ["latest_invoice"] });
}

function expandableId(value: string | { id: string } | null | undefined): string | null {
  if (typeof value === "string") return value;
  return value?.id ?? null;
}

export function normalizeStripeSubscription(subscription: Stripe.Subscription): NormalizedStripeSubscription | null {
  if (subscription.items.data.length !== 1) return null;
  const item = subscription.items.data[0];
  const membershipRef = subscription.metadata.pond_keeper_ref;
  const customerId = expandableId(subscription.customer);
  if (!membershipRef || !customerId || !item) return null;
  const interval = item.price.recurring?.interval;
  return {
    subscriptionId: subscription.id,
    membershipRef,
    customerId,
    status: subscription.status,
    priceId: item.price.id || null,
    interval: interval === "month" || interval === "year" ? interval : null,
    quantity: item.quantity ?? 0,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    paidThroughAt: null,
  };
}

function paidInvoiceThroughAt(env: Env, invoice: Stripe.Invoice, subscriptionId: string): number | null {
  if (invoice.status !== "paid") return null;
  const allowedPrices = new Set<string>(
    [String(env.STRIPE_MONTHLY_PRICE_ID), String(env.STRIPE_ANNUAL_PRICE_ID)].filter(Boolean),
  );
  const matchingLines = invoice.lines.data.filter((line) => {
    const details = line.parent?.subscription_item_details;
    const lineSubscriptionId = details?.subscription ?? null;
    const priceId = expandableId(line.pricing?.price_details?.price);
    return lineSubscriptionId === subscriptionId
      && details?.proration === false
      && priceId !== null
      && allowedPrices.has(priceId)
      && line.quantity === 1
      && Number.isFinite(line.period.end);
  });
  return matchingLines.length === 1 ? matchingLines[0]!.period.end * 1000 : null;
}

function subscriptionIdFromEvent(event: Stripe.Event): string | null {
  if (event.type.startsWith("customer.subscription.")) {
    return (event.data.object as Stripe.Subscription).id;
  }
  if (event.type === "checkout.session.completed") {
    return expandableId((event.data.object as Stripe.Checkout.Session).subscription);
  }
  if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
    const invoice = event.data.object as Stripe.Invoice;
    return expandableId(invoice.parent?.subscription_details?.subscription);
  }
  return null;
}

export async function reconcileStripeEvent(env: Env, event: Stripe.Event): Promise<NormalizedStripeEvent> {
  const object = event.data.object as { id?: string };
  const normalized: NormalizedStripeEvent = {
    eventId: event.id,
    type: event.type,
    objectId: object.id ?? null,
    createdAt: event.created * 1000,
  };
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const membershipRef = session.metadata?.pond_keeper_ref ?? session.client_reference_id;
    if (membershipRef) {
      normalized.checkout = {
        membershipRef,
        customerId: expandableId(session.customer),
        subscriptionId: expandableId(session.subscription),
      };
    }
  }
  const invoice = event.type === "invoice.paid" || event.type === "invoice.payment_failed"
    ? event.data.object as Stripe.Invoice
    : null;
  normalized.invoicePaid = event.type === "invoice.paid" && invoice?.status === "paid";
  normalized.invoiceFailed = event.type === "invoice.payment_failed";
  const subscriptionId = subscriptionIdFromEvent(event);
  if (subscriptionId) {
    const subscription = await retrieveStripeSubscription(env, subscriptionId);
    normalized.subscription = normalizeStripeSubscription(subscription) ?? undefined;
    if (normalized.invoicePaid && normalized.subscription && invoice) {
      normalized.paidInvoiceThroughAt = paidInvoiceThroughAt(env, invoice, subscriptionId);
    }
  }
  return normalized;
}

export type { Stripe };
