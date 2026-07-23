import { Resend, type WebhookEventPayload } from "resend";

export interface PondEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
  tags?: Array<{ name: string; value: string }>;
}

export interface PondEmailResult {
  providerId: string;
}

export function emailConfigured(env: Env): boolean {
  return Boolean(env.RESEND_API_KEY && env.RESEND_FROM && env.PUBLIC_APP_ORIGIN);
}

export async function sendPondEmail(env: Env, message: PondEmail): Promise<PondEmailResult> {
  if (!emailConfigured(env)) throw new Error("pond_email_not_configured");
  const resend = new Resend(env.RESEND_API_KEY);
  const result = await resend.emails.send({
    from: env.RESEND_FROM,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    tags: message.tags,
  }, { idempotencyKey: message.idempotencyKey });
  if (result.error || !result.data?.id) throw new Error(result.error?.message ?? "resend_send_failed");
  return { providerId: result.data.id };
}

export function verifyResendWebhook(
  env: Env,
  payload: string,
  headers: { id: string; timestamp: string; signature: string },
): WebhookEventPayload {
  if (!env.RESEND_WEBHOOK_SECRET) throw new Error("resend_webhook_not_configured");
  const resend = new Resend(env.RESEND_API_KEY || "re_unconfigured");
  return resend.webhooks.verify({ payload, headers, webhookSecret: env.RESEND_WEBHOOK_SECRET });
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

