import { hashString32 } from "@eternal-pond/shared";
import {
  createKeeperCheckout,
  createKeeperPortal,
  keeperBillingConfigured,
  keeperPortalConfigured,
  reconcileStripeEvent,
  retrieveKeeperCheckout,
  verifyStripeWebhook,
  type KeeperInterval,
} from "./billing";
import { PondCoreV2 } from "./core";
import { timingSafeStringEqual } from "./crypto";
import { verifyResendWebhook } from "./email";
import { PondGatewayV2 } from "./gateway";
import { isPublicSlug, normalizeDedication, validatedDateRange } from "./growth-utils";
import type { PublicSoulView } from "./growth-types";

export { PondCoreV2, PondGatewayV2 };

const CONNECTION_KEY_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const PUBLIC_SOUL_PREFIX = "/api/v3/public/souls/";
const MAX_JSON_BODY_BYTES = 8 * 1024;
const MAX_WEBHOOK_BODY_BYTES = 128 * 1024;
const MAX_CREDENTIAL_LENGTH = 512;

class HttpRequestError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

function configuredOrigins(env: Env): Set<string> {
  return new Set(env.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean));
}

function isAllowedOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get("Origin");
  const requestHost = new URL(request.url).hostname;
  if (!origin) return requestHost === "localhost" || requestHost === "127.0.0.1";
  return configuredOrigins(env).has(origin);
}

function hasAllowedBrowserOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get("Origin");
  return origin !== null && configuredOrigins(env).has(origin);
}

function responseHeaders(request: Request, env: Env): Headers {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
  });
  const origin = request.headers.get("Origin");
  if (origin && configuredOrigins(env).has(origin)) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

function jsonResponse(request: Request, env: Env, body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = responseHeaders(request, env);
  if (extraHeaders) new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  return Response.json(body, { status, headers });
}

function errorResponse(request: Request, env: Env, status: number, code: string, extraHeaders?: HeadersInit): Response {
  return jsonResponse(request, env, { error: code }, status, extraHeaders);
}

function methodNotAllowed(request: Request, env: Env, methods: string[]): Response {
  return errorResponse(request, env, 405, "method_not_allowed", { Allow: methods.join(", ") });
}

function bearerCredential(request: Request): string | null {
  const authorization = request.headers.get("Authorization");
  if (!authorization) return null;
  const match = /^Bearer ([\x21-\x7e]+)$/u.exec(authorization);
  if (!match?.[1] || match[1].length > MAX_CREDENTIAL_LENGTH) return null;
  return match[1];
}

function requireOwnerRequest(request: Request, env: Env): string {
  if (!hasAllowedBrowserOrigin(request, env)) throw new HttpRequestError(403, "origin_rejected");
  const token = bearerCredential(request);
  if (!token || !/^[A-Za-z0-9_-]+$/u.test(token)) throw new HttpRequestError(401, "unauthorized");
  return token;
}

async function readBoundedBody(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > maximumBytes) {
    throw new HttpRequestError(413, "body_too_large");
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel("body_too_large");
      throw new HttpRequestError(413, "body_too_large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonRecord(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new HttpRequestError(415, "json_required");
  const body = await readBoundedBody(request, MAX_JSON_BODY_BYTES);
  if (body.byteLength === 0) throw new HttpRequestError(400, "invalid_json");
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
    if (!isJsonRecord(value)) throw new HttpRequestError(400, "invalid_json");
    return value;
  } catch (error) {
    if (error instanceof HttpRequestError) throw error;
    throw new HttpRequestError(400, "invalid_json");
  }
}

async function readRawText(request: Request): Promise<string> {
  const body = await readBoundedBody(request, MAX_WEBHOOK_BODY_BYTES);
  if (body.byteLength === 0) throw new HttpRequestError(400, "empty_body");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body);
  } catch {
    throw new HttpRequestError(400, "invalid_utf8");
  }
}

function requiredClaim(value: unknown): string {
  if (typeof value !== "string" || value.length < 20 || value.length > MAX_CREDENTIAL_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new HttpRequestError(400, "invalid_claim");
  }
  return value;
}

function optionalSoulToken(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 20 || value.length > MAX_CREDENTIAL_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new HttpRequestError(400, "invalid_current_token");
  }
  return value;
}

function keeperPreparationError(request: Request, env: Env, reason: string | undefined): Response {
  switch (reason) {
    case "unauthorized": return errorResponse(request, env, 401, "unauthorized");
    case "not_eligible": return errorResponse(request, env, 403, "not_eligible");
    case "email_required": return errorResponse(request, env, 409, "email_required");
    case "already_active": return errorResponse(request, env, 409, "already_active");
    case "invalid_interval": return errorResponse(request, env, 400, "invalid_interval");
    case "checkout_in_progress": return errorResponse(request, env, 409, "checkout_in_progress");
    case "not_configured": return errorResponse(request, env, 409, "not_configured");
    default: return errorResponse(request, env, 500, "keeper_preparation_failed");
  }
}

function publicSoulResponse(view: PublicSoulView): PublicSoulView {
  const publicView: PublicSoulView = {
    slug: view.slug,
    name: view.name,
    tint: view.tint,
    status: view.status,
    completedLives: view.completedLives,
  };
  if (view.dedication !== undefined) publicView.dedication = view.dedication;
  if (view.currentLife) {
    publicView.currentLife = {
      kind: view.currentLife.kind,
      ageText: view.currentLife.ageText,
      presentation: {
        x: view.currentLife.presentation.x,
        z: view.currentLife.presentation.z,
        depth: view.currentLife.presentation.depth,
        heading: view.currentLife.presentation.heading,
        size: view.currentLife.presentation.size,
        ageRatio: view.currentLife.presentation.ageRatio,
      },
    };
    if (view.currentLife.remainingPassageText !== undefined) {
      publicView.currentLife.remainingPassageText = view.currentLife.remainingPassageText;
    }
  }
  if (view.latestMemorial) {
    publicView.latestMemorial = {
      completedAt: view.latestMemorial.completedAt,
      ageText: view.latestMemorial.ageText,
      rippleAnchor: {
        x: view.latestMemorial.rippleAnchor.x,
        z: view.latestMemorial.rippleAnchor.z,
      },
    };
  }
  return publicView;
}

async function handlePublicSoul(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(request, env, ["GET"]);
  const slug = url.pathname.slice(PUBLIC_SOUL_PREFIX.length).toLowerCase();
  if (!isPublicSlug(slug)) return errorResponse(request, env, 404, "not_found");
  const publicSoul = await env.POND_CORE.getByName("canonical-world").getPublicSoul({ slug });
  return publicSoul
    ? jsonResponse(request, env, publicSoulResponse(publicSoul))
    : errorResponse(request, env, 404, "not_found");
}

async function handleRetention(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(request, env, ["GET"]);
  const origin = request.headers.get("Origin");
  if (origin && !configuredOrigins(env).has(origin)) return errorResponse(request, env, 403, "origin_rejected");
  if (!env.ANALYTICS_BEARER_TOKEN) return errorResponse(request, env, 503, "analytics_not_configured");
  const authorized = await timingSafeStringEqual(bearerCredential(request) ?? "", env.ANALYTICS_BEARER_TOKEN);
  if (!authorized) return errorResponse(request, env, 401, "unauthorized");
  const range = validatedDateRange(url.searchParams.get("from"), url.searchParams.get("to"));
  if (!range) return errorResponse(request, env, 400, "invalid_date_range");
  const report = await env.POND_CORE.getByName("canonical-world").getRetentionReport(range);
  return jsonResponse(request, env, report);
}

async function handleLinkRequest(request: Request, env: Env, redeem: boolean): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request, env, ["POST"]);
  if (!hasAllowedBrowserOrigin(request, env)) return errorResponse(request, env, 403, "origin_rejected");
  const body = await readJsonRecord(request);
  const claim = requiredClaim(body.claim);
  const core = env.POND_CORE.getByName("canonical-world");
  if (!redeem) return jsonResponse(request, env, await core.inspectSecureLink({ claim }));
  const currentToken = optionalSoulToken(body.currentToken);
  return jsonResponse(request, env, await core.redeemSecureLink({ claim, currentToken }));
}

async function handleCredentialRevoke(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request, env, ["POST"]);
  const ownerToken = requireOwnerRequest(request, env);
  const body = await readJsonRecord(request);
  if (Object.keys(body).some((key) => key !== "token")) return errorResponse(request, env, 400, "unknown_field");
  const targetToken = optionalSoulToken(body.token);
  if (!targetToken) return errorResponse(request, env, 400, "invalid_token");
  const revoked = await env.POND_CORE.getByName("canonical-world").revokeCredential({ ownerToken, targetToken });
  if (revoked === null) return errorResponse(request, env, 401, "unauthorized");
  if (!revoked) return errorResponse(request, env, 404, "credential_not_found");
  return jsonResponse(request, env, { revoked: true });
}

async function handleKeeperGet(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(request, env, ["GET"]);
  const token = requireOwnerRequest(request, env);
  const summary = await env.POND_CORE.getByName("canonical-world").getKeeperSummary({
    token,
    billingConfigured: keeperBillingConfigured(env),
  });
  return summary
    ? jsonResponse(request, env, summary)
    : errorResponse(request, env, 401, "unauthorized");
}

async function handleKeeperCheckout(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request, env, ["POST"]);
  const token = requireOwnerRequest(request, env);
  if (!keeperBillingConfigured(env)) return errorResponse(request, env, 503, "keeper_billing_not_configured");
  const body = await readJsonRecord(request);
  if (Object.keys(body).some((key) => key !== "interval")) return errorResponse(request, env, 400, "unknown_field");
  const interval = body.interval;
  if (interval !== "month" && interval !== "year") return errorResponse(request, env, 400, "invalid_interval");
  const core = env.POND_CORE.getByName("canonical-world");
  const preparation = await core.prepareKeeperCheckout({ token, interval });
  if (!preparation.ok) return keeperPreparationError(request, env, preparation.reason);
  if (preparation.existingSessionId) {
    try {
      const session = await retrieveKeeperCheckout(env, preparation.existingSessionId);
      return jsonResponse(request, env, { ok: true, url: session.url, expiresAt: session.expiresAt });
    } catch {
      return errorResponse(request, env, 502, "checkout_retrieval_failed");
    }
  }
  if (!preparation.attemptId || !preparation.membershipRef || !preparation.idempotencyKey) {
    return errorResponse(request, env, 500, "keeper_preparation_failed");
  }
  try {
    const session = await createKeeperCheckout(env, {
      membershipRef: preparation.membershipRef,
      interval: interval satisfies KeeperInterval,
      customerId: preparation.customerId,
      idempotencyKey: preparation.idempotencyKey,
    });
    await core.recordKeeperCheckout({
      attemptId: preparation.attemptId,
      sessionId: session.id,
      expiresAt: session.expiresAt,
    });
    return jsonResponse(request, env, { ok: true, url: session.url, expiresAt: session.expiresAt });
  } catch {
    return errorResponse(request, env, 502, "checkout_creation_failed");
  }
}

async function handleKeeperPortal(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request, env, ["POST"]);
  const token = requireOwnerRequest(request, env);
  if (!keeperPortalConfigured(env)) return errorResponse(request, env, 503, "keeper_portal_not_configured");
  const preparation = await env.POND_CORE.getByName("canonical-world").prepareKeeperPortal({ token });
  if (!preparation.ok || !preparation.customerId) return keeperPreparationError(request, env, preparation.reason);
  try {
    return jsonResponse(request, env, { ok: true, ...(await createKeeperPortal(env, preparation.customerId)) });
  } catch {
    return errorResponse(request, env, 502, "portal_creation_failed");
  }
}

async function handleKeeperPatch(request: Request, env: Env): Promise<Response> {
  if (request.method !== "PATCH") return methodNotAllowed(request, env, ["PATCH"]);
  const token = requireOwnerRequest(request, env);
  const body = await readJsonRecord(request);
  const hasDedication = Object.hasOwn(body, "dedication");
  const hasWeeklyLetters = Object.hasOwn(body, "weeklyLetters");
  if (!hasDedication && !hasWeeklyLetters) return errorResponse(request, env, 400, "empty_update");
  if (Object.keys(body).some((key) => key !== "dedication" && key !== "weeklyLetters")) {
    return errorResponse(request, env, 400, "unknown_field");
  }
  let dedication: string | undefined;
  if (hasDedication) {
    if (typeof body.dedication !== "string") return errorResponse(request, env, 400, "invalid_dedication");
    dedication = normalizeDedication(body.dedication) ?? undefined;
    if (dedication === undefined) return errorResponse(request, env, 400, "invalid_dedication");
  }
  let weeklyLetters: boolean | undefined;
  if (hasWeeklyLetters) {
    if (typeof body.weeklyLetters !== "boolean") return errorResponse(request, env, 400, "invalid_weekly_letters");
    weeklyLetters = body.weeklyLetters;
  }
  const summary = await env.POND_CORE.getByName("canonical-world").updateKeeperPreferences({
    token, dedication, weeklyLetters,
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message === "email_required") {
      throw new HttpRequestError(409, "email_required");
    }
    throw error;
  });
  return summary
    ? jsonResponse(request, env, summary)
    : errorResponse(request, env, 401, "unauthorized");
}

async function handleResendWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request, env, ["POST"]);
  if (!env.RESEND_WEBHOOK_SECRET) return errorResponse(request, env, 503, "resend_webhook_not_configured");
  const id = request.headers.get("svix-id");
  const timestamp = request.headers.get("svix-timestamp");
  const signature = request.headers.get("svix-signature");
  if (!id || id.length > 256 || !timestamp || timestamp.length > 128 || !signature || signature.length > 4096) {
    return errorResponse(request, env, 400, "invalid_webhook_headers");
  }
  const payload = await readRawText(request);
  let event: ReturnType<typeof verifyResendWebhook>;
  try {
    event = verifyResendWebhook(env, payload, { id, timestamp, signature });
  } catch {
    return errorResponse(request, env, 400, "invalid_webhook_signature");
  }
  const providerId = "email_id" in event.data && typeof event.data.email_id === "string"
    ? event.data.email_id
    : null;
  const bounceType = event.type === "email.bounced"
    && "bounce" in event.data
    && typeof event.data.bounce === "object"
    && event.data.bounce !== null
    && "type" in event.data.bounce
    && typeof event.data.bounce.type === "string"
      ? event.data.bounce.type
      : null;
  const eventCreatedAt = Date.parse(event.created_at);
  const receivedAt = Date.now();
  const result = await env.POND_CORE.getByName("canonical-world").applyResendWebhook({
    webhookId: id,
    eventType: event.type,
    providerId,
    eventCreatedAt: Number.isFinite(eventCreatedAt) ? eventCreatedAt : receivedAt,
    receivedAt,
    bounceType,
  });
  return jsonResponse(request, env, { received: true, duplicate: result.duplicate });
}

async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request, env, ["POST"]);
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    return errorResponse(request, env, 503, "stripe_webhook_not_configured");
  }
  const signature = request.headers.get("Stripe-Signature");
  if (!signature || signature.length > 4096) return errorResponse(request, env, 400, "invalid_webhook_headers");
  const payload = await readRawText(request);
  let event;
  try {
    event = await verifyStripeWebhook(env, payload, signature);
  } catch {
    return errorResponse(request, env, 400, "invalid_webhook_signature");
  }
  const normalized = await reconcileStripeEvent(env, event);
  const result = await env.POND_CORE.getByName("canonical-world").applyStripeEvent(normalized);
  return jsonResponse(request, env, { received: true, duplicate: result.duplicate });
}

async function handleApiRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname.startsWith(PUBLIC_SOUL_PREFIX)) return handlePublicSoul(request, env, url);
  if (url.pathname === "/api/v3/analytics/retention") return handleRetention(request, env, url);
  if (url.pathname === "/api/v3/links/inspect") return handleLinkRequest(request, env, false);
  if (url.pathname === "/api/v3/links/redeem") return handleLinkRequest(request, env, true);
  if (url.pathname === "/api/v3/credentials/revoke") return handleCredentialRevoke(request, env);
  if ((url.pathname === "/api/v3/keeper"
      || url.pathname === "/api/v3/keeper/checkout"
      || url.pathname === "/api/v3/keeper/portal"
      || url.pathname === "/api/v3/stripe/webhook")
    && String(env.KEEPER_BILLING_ENABLED) !== "true") {
    return errorResponse(request, env, 404, "not_found");
  }
  if (url.pathname === "/api/v3/keeper") {
    if (request.method !== "GET" && request.method !== "PATCH") return methodNotAllowed(request, env, ["GET", "PATCH"]);
    if (request.method === "PATCH") return handleKeeperPatch(request, env);
    return handleKeeperGet(request, env);
  }
  if (url.pathname === "/api/v3/keeper/checkout") return handleKeeperCheckout(request, env);
  if (url.pathname === "/api/v3/keeper/portal") return handleKeeperPortal(request, env);
  if (url.pathname === "/api/v3/resend/webhook") return handleResendWebhook(request, env);
  if (url.pathname === "/api/v3/stripe/webhook") return handleStripeWebhook(request, env);
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      if (!hasAllowedBrowserOrigin(request, env)) return errorResponse(request, env, 403, "origin_rejected");
      const headers = responseHeaders(request, env);
      headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
      headers.set("Access-Control-Max-Age", "600");
      headers.delete("Content-Type");
      return new Response(null, { status: 204, headers });
    }

    if (url.pathname === "/health") {
      return jsonResponse(request, env, { ok: true, service: "eternal-pond-canonical", protocol: 3, now: Date.now() });
    }

    if (url.pathname === "/api/v3/status" || url.pathname === "/api/v2/status") {
      if (!isAllowedOrigin(request, env)) return errorResponse(request, env, 403, "origin_rejected");
      const core = env.POND_CORE.getByName("canonical-world");
      return jsonResponse(request, env, await core.getPublicStatus());
    }

    try {
      const apiResponse = await handleApiRequest(request, env, url);
      if (apiResponse) return apiResponse;
    } catch (error) {
      if (error instanceof HttpRequestError) return errorResponse(request, env, error.status, error.code);
      console.error(JSON.stringify({ event: "api_request_failed", path: url.pathname }));
      return errorResponse(request, env, 500, "internal_error");
    }

    if (url.pathname !== "/ws/v3" && url.pathname !== "/ws/v2") {
      return errorResponse(request, env, 404, "not_found");
    }
    if (!isAllowedOrigin(request, env)) return errorResponse(request, env, 403, "origin_rejected");
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return errorResponse(request, env, 426, "websocket_upgrade_required");
    }

    const connection = url.searchParams.get("connection");
    const routingKey = connection && CONNECTION_KEY_PATTERN.test(connection)
      ? connection
      : crypto.randomUUID();
    const shard = hashString32(routingKey) % 16;
    url.searchParams.delete("token");
    url.searchParams.set("shard", String(shard));
    const gateway = env.POND_GATEWAY.getByName(`v2-gateway-${shard}`);
    return gateway.fetch(new Request(url, request));
  },
} satisfies ExportedHandler<Env>;
