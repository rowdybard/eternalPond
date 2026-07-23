import { DurableObject } from "cloudflare:workers";
import {
  MAX_CLIENT_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "@eternal-pond/shared";
import type {
  CoreBatchEntry,
  CoreConnectionAttachment,
} from "./core";

interface PendingEntry {
  sessionId: string;
  gatewayShard: number;
  message: Exclude<ClientMessage, { type: "hello" }>;
}

interface PendingAttachment extends CoreConnectionAttachment {
  initialized: boolean;
}

function initialAttachment(shard: number): PendingAttachment {
  const now = Date.now();
  return {
    initialized: false,
    connectionId: crypto.randomUUID(),
    sessionId: "",
    soulId: "",
    renderer: "webgl",
    gatewayShard: shard,
    connectedAt: now,
    rateWindowStartedAt: now,
    rateWindowCount: 0,
    rippleWindowStartedAt: now,
    rippleWindowCount: 0,
  };
}

function decodeMessage(message: string | ArrayBuffer): string | null {
  if (typeof message === "string") {
    return new TextEncoder().encode(message).byteLength <= MAX_CLIENT_MESSAGE_BYTES ? message : null;
  }
  if (message.byteLength > MAX_CLIENT_MESSAGE_BYTES) return null;
  return new TextDecoder().decode(message);
}

export class PondGatewayV2 extends DurableObject<Env> {
  private pendingEntries: PendingEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private core() {
    return this.env.POND_CORE.getByName("canonical-world");
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    const url = new URL(request.url);
    const shard = Math.max(0, Math.min(15, Number.parseInt(url.searchParams.get("shard") ?? "0", 10) || 0));
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [`shard:${shard}`]);
    server.serializeAttachment(initialAttachment(shard));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(webSocket: WebSocket, incoming: string | ArrayBuffer): Promise<void> {
    const raw = decodeMessage(incoming);
    if (raw === null) {
      this.send(webSocket, {
        v: PROTOCOL_VERSION,
        type: "error",
        requestId: "error_message_size",
        code: "bad_message",
        message: "That gesture was too large for the pond.",
      });
      return;
    }
    const parsed = parseClientMessage(raw);
    if (!parsed.ok || !parsed.message) {
      this.send(webSocket, {
        v: PROTOCOL_VERSION,
        type: "error",
        requestId: "error_bad_message",
        code: "bad_message",
        message: parsed.error ?? "The pond could not read that gesture.",
      });
      return;
    }

    let attachment = webSocket.deserializeAttachment() as PendingAttachment | null;
    attachment ??= initialAttachment(0);
    const now = Date.now();
    if (now - attachment.rateWindowStartedAt >= 10_000) {
      attachment.rateWindowStartedAt = now;
      attachment.rateWindowCount = 0;
    }
    if (now - attachment.rippleWindowStartedAt >= 10_000) {
      attachment.rippleWindowStartedAt = now;
      attachment.rippleWindowCount = 0;
    }
    if (parsed.message.type === "rippleBatch") attachment.rippleWindowCount++;
    else attachment.rateWindowCount++;
    webSocket.serializeAttachment(attachment);
    if (parsed.message.type === "rippleBatch" && attachment.rippleWindowCount > 100) return;
    if (parsed.message.type !== "rippleBatch" && attachment.rateWindowCount > 40) {
      this.send(webSocket, {
        v: PROTOCOL_VERSION,
        type: "error",
        requestId: parsed.message.requestId,
        code: "rate_limited",
        message: "That gesture needs a little more time.",
      });
      return;
    }

    if (parsed.message.type === "hello") {
      if (attachment.initialized) {
        this.send(webSocket, {
          v: PROTOCOL_VERSION,
          type: "error",
          requestId: parsed.message.requestId,
          code: "bad_message",
          message: "This soul is already known here.",
        });
        return;
      }
      try {
        const result = await this.core().connectSoul({
          requestId: parsed.message.requestId,
          token: parsed.message.token,
          renderer: parsed.message.renderer,
          reducedMotion: parsed.message.reducedMotion,
          gatewayShard: attachment.gatewayShard,
          visitId: parsed.message.visitId,
        });
        webSocket.serializeAttachment({ ...result.attachment, initialized: true } satisfies PendingAttachment);
        for (const message of result.messages) this.send(webSocket, message);
      } catch (error) {
        console.error("gateway hello failed", error);
        this.send(webSocket, {
          v: PROTOCOL_VERSION,
          type: "error",
          requestId: parsed.message.requestId,
          code: "internal",
          message: "The pond could not remember this soul yet.",
        });
      }
      return;
    }

    if (!attachment.initialized || !attachment.sessionId) {
      this.send(webSocket, {
        v: PROTOCOL_VERSION,
        type: "error",
        requestId: parsed.message.requestId,
        code: "not_ready",
        message: "Say hello to the pond first.",
      });
      return;
    }
    this.pendingEntries.push({
      sessionId: attachment.sessionId,
      gatewayShard: attachment.gatewayShard,
      message: parsed.message,
    });
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.ctx.waitUntil(this.flush());
    }, 50);
  }

  private async flush(): Promise<void> {
    const pending = this.pendingEntries.splice(0, 100);
    if (pending.length === 0) return;
    const byShard = new Map<number, CoreBatchEntry[]>();
    for (const entry of pending) {
      const entries = byShard.get(entry.gatewayShard) ?? [];
      entries.push({ sessionId: entry.sessionId, message: entry.message });
      byShard.set(entry.gatewayShard, entries);
    }
    try {
      for (const [gatewayShard, entries] of byShard) {
        const deliveries = await this.core().receiveBatch({ gatewayShard, entries });
        for (const delivery of deliveries) this.deliverToSession(delivery.sessionId, delivery.messages);
      }
    } catch (error) {
      console.error("gateway batch failed", error);
    }
    if (this.pendingEntries.length > 0) this.scheduleFlush();
  }

  async broadcastMessage(message: ServerMessage): Promise<number> {
    let delivered = 0;
    const serialized = JSON.stringify(message);
    for (const webSocket of this.ctx.getWebSockets()) {
      const attachment = webSocket.deserializeAttachment() as PendingAttachment | null;
      if (!attachment?.initialized) continue;
      if (this.sendSerialized(webSocket, serialized)) delivered++;
    }
    return delivered;
  }

  async deliverToSession(sessionId: string, messages: ServerMessage[]): Promise<boolean> {
    for (const webSocket of this.ctx.getWebSockets()) {
      const attachment = webSocket.deserializeAttachment() as PendingAttachment | null;
      if (attachment?.sessionId !== sessionId) continue;
      for (const message of messages) this.send(webSocket, message);
      return true;
    }
    return false;
  }

  private send(webSocket: WebSocket, message: ServerMessage): boolean {
    return this.sendSerialized(webSocket, JSON.stringify(message));
  }

  private sendSerialized(webSocket: WebSocket, message: string): boolean {
    try {
      webSocket.send(message);
      return true;
    } catch (error) {
      console.warn("websocket send failed", error);
      return false;
    }
  }

  async webSocketClose(webSocket: WebSocket): Promise<void> {
    const attachment = webSocket.deserializeAttachment() as PendingAttachment | null;
    if (attachment?.sessionId) await this.core().disconnectSoul(attachment.sessionId);
  }

  async webSocketError(webSocket: WebSocket, error: unknown): Promise<void> {
    console.warn("websocket connection error", error);
    const attachment = webSocket.deserializeAttachment() as PendingAttachment | null;
    if (attachment?.sessionId) await this.core().disconnectSoul(attachment.sessionId);
  }
}
