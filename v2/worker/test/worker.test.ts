import { SELF, env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  hashString32,
  type RitualAckMessage,
  type DeltaMessage,
  type NatureEvent,
  type ServerMessage,
  type SnapshotMessage,
  type WelcomeMessage,
} from "@eternal-pond/shared";
import type { PondCoreV2 } from "../src/core";
import worker from "../src/index";

describe("Eternal Pond canonical Worker", () => {
  it("serves health and rejects an untrusted origin", async () => {
    const health = await SELF.fetch("http://example.com/health");
    expect(health.status).toBe(200);
    const rejected = await SELF.fetch("http://example.com/api/v3/status", { headers: { Origin: "https://untrusted.example" } });
    expect(rejected.status).toBe(403);
  });

  it("accepts a hibernatable WebSocket hello through a gateway shard", async () => {
    const response = await SELF.fetch("http://example.com/ws/v3?connection=websocket-test", {
      headers: {
        Origin: "http://localhost:5173",
        Upgrade: "websocket",
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    expect(socket).not.toBeNull();
    socket?.accept();
    const welcome = new Promise<WelcomeMessage>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("welcome timeout")), 3000);
      socket?.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        if (message.type !== "welcome") return;
        clearTimeout(timeout);
        resolve(message);
      });
    });
    const delta = new Promise<DeltaMessage>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("delta timeout")), 3000);
      socket?.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        if (message.type !== "delta") return;
        clearTimeout(timeout);
        resolve(message);
      });
    });
    socket?.send(JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "hello",
      requestId: "hello_socket_test",
      renderer: "webgl",
      reducedMotion: false,
      clientTime: Date.now(),
    }));
    const message = await welcome;
    expect(message.identity.name.length).toBeGreaterThan(8);
    expect(message.token).toBeTruthy();
    const compact = await delta;
    expect(compact).not.toHaveProperty("entities");
    expect(Array.isArray(compact.upserts)).toBe(true);
    expect(Array.isArray(compact.motions)).toBe(true);
    expect(Array.isArray(compact.hiddenIds)).toBe(true);
    socket?.close(1000, "test complete");
  });

  it("routes by the non-secret connection and strips legacy URL tokens", async () => {
    const connection = "safe-connection-key";
    let gatewayName = "";
    let forwardedUrl = "";
    const fakeEnv = {
      ALLOWED_ORIGINS: "http://localhost:5173",
      POND_GATEWAY: {
        getByName(name: string) {
          gatewayName = name;
          return {
            fetch(request: Request) {
              forwardedUrl = request.url;
              return new Response(null, { status: 204 });
            },
          };
        },
      },
    } as unknown as Env;

    const response = await worker.fetch(new Request(
      `http://example.com/ws/v3?connection=${connection}&token=permanent-soul-secret`,
      { headers: { Origin: "http://localhost:5173", Upgrade: "websocket" } },
    ), fakeEnv);

    expect(response.status).toBe(204);
    expect(gatewayName).toBe(`v2-gateway-${hashString32(connection) % 16}`);
    const forwarded = new URL(forwardedUrl);
    expect(forwarded.searchParams.get("connection")).toBe(connection);
    expect(forwarded.searchParams.has("token")).toBe(false);
  });

  it("keeps legacy URL-token clients compatible through hello authentication", async () => {
    const firstResponse = await SELF.fetch("http://example.com/ws/v3?connection=legacy-first", {
      headers: { Origin: "http://localhost:5173", Upgrade: "websocket" },
    });
    const firstSocket = firstResponse.webSocket;
    firstSocket?.accept();
    const firstWelcome = new Promise<WelcomeMessage>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("first legacy welcome timeout")), 3000);
      firstSocket?.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        if (message.type !== "welcome") return;
        clearTimeout(timeout);
        resolve(message);
      });
    });
    firstSocket?.send(JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "hello",
      requestId: "hello_legacy_first",
      renderer: "webgl",
      reducedMotion: false,
      clientTime: Date.now(),
    }));
    const original = await firstWelcome;
    expect(original.token).toBeTruthy();
    firstSocket?.close(1000, "legacy reconnect test");

    const returnedResponse = await SELF.fetch(
      `http://example.com/ws/v3?connection=legacy-return&token=${encodeURIComponent(original.token ?? "")}`,
      { headers: { Origin: "http://localhost:5173", Upgrade: "websocket" } },
    );
    const returnedSocket = returnedResponse.webSocket;
    returnedSocket?.accept();
    const returnedWelcome = new Promise<WelcomeMessage>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("returned legacy welcome timeout")), 3000);
      returnedSocket?.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        if (message.type !== "welcome") return;
        clearTimeout(timeout);
        resolve(message);
      });
    });
    returnedSocket?.send(JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "hello",
      requestId: "hello_legacy_return",
      token: original.token,
      renderer: "webgl",
      reducedMotion: false,
      clientTime: Date.now(),
    }));
    const returned = await returnedWelcome;
    expect(returned.identity.id).toBe(original.identity.id);
    expect(returned.token).toBeUndefined();
    returnedSocket?.close(1000, "legacy reconnect complete");
  });

  it("restores a hibernated gateway socket from its serialized attachment", async () => {
    const connectionKey = "hibernate-socket-test";
    const response = await SELF.fetch(`http://example.com/ws/v3?connection=${connectionKey}`, {
      headers: { Origin: "http://localhost:5173", Upgrade: "websocket" },
    });
    const socket = response.webSocket;
    expect(socket).not.toBeNull();
    socket?.accept();
    const welcome = new Promise<WelcomeMessage>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("hibernation welcome timeout")), 3000);
      socket?.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        if (message.type !== "welcome") return;
        clearTimeout(timeout);
        resolve(message);
      });
    });
    socket?.send(JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "hello",
      requestId: "hello_hibernate_test",
      renderer: "webgl",
      reducedMotion: true,
      clientTime: Date.now(),
    }));
    await welcome;

    const shard = hashString32(connectionKey) % 16;
    await evictDurableObject(env.POND_GATEWAY.getByName(`v2-gateway-${shard}`));
    const rejection = new Promise<RitualAckMessage>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("hibernation ritual timeout")), 3000);
      socket?.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        if (message.type !== "ritualAck" || message.requestId !== "offer_after_hibernate") return;
        clearTimeout(timeout);
        resolve(message);
      });
    });
    socket?.send(JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "offer",
      requestId: "offer_after_hibernate",
      point: { x: 0.5, z: 0.5 },
      offering: "food",
    }));
    expect((await rejection).reason).toBe("unborn");
    socket?.close(1000, "hibernation test complete");
  });

  it("initializes founding ripples idempotently in SQLite", async () => {
    const stub = env.POND_CORE.getByName("canonical-world");
    const first = await stub.getPublicStatus();
    const second = await stub.getPublicStatus();
    expect(first.foundingRipples).toBe(149);
    expect(second.foundingRipples).toBe(149);
    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      const count = state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM founding_ripples").one().count;
      expect(count).toBe(149);
      const version = state.storage.sql.exec<{ version: number }>("SELECT MAX(version) AS version FROM schema_migrations").one().version;
      expect(version).toBe(9);
    });
  });

  it("seeds the sparse canonical ecology with capacity for at least 100 souls", async () => {
    const stub = env.POND_CORE.getByName("ecology-capacity");
    const status = await stub.getPublicStatus();
    expect(status.capacity.limit).toBeGreaterThanOrEqual(100);
    expect(status.capacity.limit).toBeLessThanOrEqual(200);
    expect(status.ecology.canonicalNpcs).toBe(61);
    expect(status.ecology.detailedNpcs).toBeGreaterThanOrEqual(13);
    expect(status.ecology.detailedNpcs).toBeLessThanOrEqual(15);

    const connection = await stub.connectSoul({
      requestId: "hello_ecology",
      renderer: "canvas",
      reducedMotion: true,
      gatewayShard: 0,
    });
    const snapshot = connection.messages.find((message) => message.type === "snapshot") as SnapshotMessage;
    const detailedNpcs = snapshot.snapshot.entities.filter((entity) => entity.soulId === null);
    const backgroundWildlife = snapshot.snapshot.backgroundCohorts
      .filter((cohort) => cohort.kind === "wild")
      .reduce((sum, cohort) => sum + cohort.populationCount, 0);
    expect(detailedNpcs.filter((entity) => entity.kind === "wildFish").length).toBeLessThanOrEqual(3);
    expect(detailedNpcs.filter((entity) => entity.kind === "bird")).toHaveLength(6);
    expect(detailedNpcs.filter((entity) => entity.kind === "lily")).toHaveLength(5);
    expect(detailedNpcs.filter((entity) => entity.kind === "frog")).toHaveLength(2);
    expect(backgroundWildlife).toBe(48);
    await stub.disconnectSoul(connection.attachment.sessionId);
  });

  it("restores the same opaque soul and enforces offering cadence", async () => {
    const stub = env.POND_CORE.getByName("soul-persistence");
    const first = await stub.connectSoul({
      requestId: "hello_first",
      renderer: "webgl",
      reducedMotion: false,
      gatewayShard: 0,
    });
    const welcome = first.messages.find((message) => message.type === "welcome") as WelcomeMessage;
    expect(welcome.token).toBeTruthy();
    await stub.receiveBatch({
      gatewayShard: 0,
      entries: [{
        sessionId: first.attachment.sessionId,
        message: {
          v: PROTOCOL_VERSION,
          type: "incarnate",
          requestId: "birth_first",
          point: { x: 0.5, z: 0.5 },
        },
      }],
    });
    const firstOffer = await stub.receiveBatch({
      gatewayShard: 0,
      entries: [{
        sessionId: first.attachment.sessionId,
        message: {
          v: PROTOCOL_VERSION,
          type: "offer",
          requestId: "offer_first",
          point: { x: 0.5, z: 0.5 },
          offering: "food",
        },
      }],
    });
    const accepted = firstOffer[0]?.messages[0] as RitualAckMessage;
    expect(accepted.accepted).toBe(true);
    const secondOffer = await stub.receiveBatch({
      gatewayShard: 0,
      entries: [{
        sessionId: first.attachment.sessionId,
        message: {
          v: PROTOCOL_VERSION,
          type: "offer",
          requestId: "offer_again",
          point: { x: 0.5, z: 0.5 },
          offering: "seed",
        },
      }],
    });
    const cooledDown = secondOffer[0]?.messages[0] as RitualAckMessage;
    expect(cooledDown.accepted).toBe(false);
    expect(cooledDown.reason).toBe("cooldown");
    await stub.disconnectSoul(first.attachment.sessionId);

    const returned = await stub.connectSoul({
      requestId: "hello_return",
      token: welcome.token,
      renderer: "webgl",
      reducedMotion: false,
      gatewayShard: 0,
    });
    const returnedWelcome = returned.messages.find((message) => message.type === "welcome") as WelcomeMessage;
    expect(returnedWelcome.identity.id).toBe(welcome.identity.id);
    expect(returnedWelcome.token).toBeUndefined();
    await stub.disconnectSoul(returned.attachment.sessionId);
  });

  it("keeps offerings unborn-only while accepting rapid ripple batches silently", async () => {
    const stub = env.POND_CORE.getByName("ritual-protections-v3");
    const connection = await stub.connectSoul({
      requestId: "hello_rituals_v3",
      renderer: "webgl",
      reducedMotion: false,
      gatewayShard: 0,
    });
    const unborn = await stub.receiveBatch({
      gatewayShard: 0,
      entries: [{
        sessionId: connection.attachment.sessionId,
        message: {
          v: PROTOCOL_VERSION,
          type: "offer",
          requestId: "offer_unborn_v3",
          point: { x: 0.5, z: 0.5 },
          offering: "food",
        },
      }],
    });
    const unbornAck = unborn[0]?.messages[0] as RitualAckMessage;
    expect(unbornAck.accepted).toBe(false);
    expect(unbornAck.reason).toBe("unborn");

    const rippleEntries = Array.from({ length: 20 }, (_, index) => ({
      sessionId: connection.attachment.sessionId,
      message: {
        v: PROTOCOL_VERSION,
        type: "rippleBatch" as const,
        requestId: `ripples_v3_${String(index).padStart(2, "0")}`,
        points: [{ x: 0.45 + (index % 4) * 0.01, z: 0.48 + (index % 3) * 0.01 }],
      },
    }));
    const ripples = await stub.receiveBatch({ gatewayShard: 0, entries: rippleEntries });
    expect(ripples).toEqual([]);
    await stub.disconnectSoul(connection.attachment.sessionId);
  });

  it("persists deterministic visitor lilies without replacing baseline pads", async () => {
    const stub = env.POND_CORE.getByName("visitor-lily-lifecycle-v3");
    const connection = await stub.connectSoul({
      requestId: "hello_lily_v3",
      renderer: "webgl",
      reducedMotion: false,
      gatewayShard: 0,
    });
    await stub.receiveBatch({
      gatewayShard: 0,
      entries: [{
        sessionId: connection.attachment.sessionId,
        message: { v: PROTOCOL_VERSION, type: "incarnate", requestId: "birth_lily_v3", point: { x: 0.52, z: 0.48 } },
      }],
    });
    await stub.receiveBatch({
      gatewayShard: 0,
      entries: [{
        sessionId: connection.attachment.sessionId,
        message: { v: PROTOCOL_VERSION, type: "offer", requestId: "seed_lily_v3", point: { x: 0.58, z: 0.52 }, offering: "seed" },
      }],
    });
    await runInDurableObject(stub, async (_instance: PondCoreV2, state) => {
      const lilies = state.storage.sql.exec<{ state_json: string; born_at: number | null; ends_at: number | null }>(
        "SELECT state_json, born_at, ends_at FROM entities WHERE kind = 'lily'",
      ).toArray().map((row) => ({
        ...row,
        runtime: JSON.parse(row.state_json) as { source?: string },
      }));
      expect(lilies.filter((item) => item.runtime.source === "baseline")).toHaveLength(5);
      const offering = lilies.find((item) => item.runtime.source === "offering");
      expect(offering).toBeTruthy();
      expect((offering?.ends_at ?? 0) - (offering?.born_at ?? 0)).toBe(72 * 60 * 60 * 1000);
    });
    await stub.disconnectSoul(connection.attachment.sessionId);
  });

  it("publishes synchronized frog feeding with explicit frog, insect, path, and timing", async () => {
    const stub = env.POND_CORE.getByName("frog-feed-event-v3");
    const now = Date.now();
    await runInDurableObject(stub, async (instance: PondCoreV2) => {
      const beginFeed = instance as unknown as { beginFrogFeed(at: number, seed: number): void };
      beginFeed.beginFrogFeed(now, 90210);
    });
    const connection = await stub.connectSoul({
      requestId: "hello_frog_event_v3",
      renderer: "canvas",
      reducedMotion: true,
      gatewayShard: 0,
    });
    const snapshot = connection.messages.find((message) => message.type === "snapshot") as SnapshotMessage;
    const event = snapshot.snapshot.natureEvents.find((item) => item.kind === "frog_feed") as NatureEvent | undefined;
    expect(event?.frogId).toMatch(/^wild_frog_/);
    expect(event?.insectId).toMatch(/^insect_/);
    expect(event?.targetIds).toContain(event?.frogId);
    expect(event?.targetIds).toContain(event?.insectId);
    expect(event?.from).toBeTruthy();
    expect(event?.to).toBeTruthy();
    expect((event?.endsAt ?? 0) - (event?.startsAt ?? 0)).toBe(3200);
    await stub.disconnectSoul(connection.attachment.sessionId);
  });
});
