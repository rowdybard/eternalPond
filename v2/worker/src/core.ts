import { DurableObject } from "cloudflare:workers";
import {
  OFFERING_COOLDOWN_MS,
  ORBIT_PERIOD_MS,
  PROTOCOL_VERSION,
  clampNormalizedPoint,
  hashString32,
  mulberry32,
  orbitPhaseAt,
  poeticAge,
  type BackgroundCohort,
  type CapacityState,
  type ClientMessage,
  type DomeMemory,
  type EntityMotion,
  type EntityKind,
  type EntityState,
  type NatureEvent,
  type NatureEventKind,
  type NormalizedPoint,
  type QueueMessage,
  type RecentLifeRecord,
  type RendererKind,
  type RitualEvent,
  type ServerMessage,
  type SnapshotMessage,
  type SoulIdentity,
  type WelcomeMessage,
  type WorldSnapshot,
} from "@eternal-pond/shared";
import {
  BIRD_PERCH_ANCHORS,
  FROG_HABITAT_ANCHORS,
  applyFrogFeed,
  advanceEntity,
  applySchooling,
  canBePredated,
  createSoulFish,
  createWildEntity,
  fastForwardEntity,
  isLegendaryWindow,
  isNaturalLifeComplete,
  type SimEntity,
} from "./simulation";
import { insertReturningFirstFifo } from "./queue";

interface SoulRow {
  [key: string]: SqlStorageValue;
  id: string;
  poetic_name: string;
  tint: number;
  completed_lives: number;
  last_seen_at: number;
}

interface EntityRow {
  [key: string]: SqlStorageValue;
  id: string;
  soul_id: string | null;
  life_id: string | null;
  label: string | null;
  kind: EntityKind;
  x: number;
  z: number;
  depth: number;
  heading: number;
  speed: number;
  size: number;
  tint: number;
  age_ratio: number;
  born_at: number | null;
  ends_at: number | null;
  refuge_until: number | null;
  life_kind: "mortal" | "memorial" | null;
  memorial_phase: "water" | "dome" | null;
  is_foreground: number;
  seed: number;
  updated_at: number;
  state_json: string;
}

interface ScheduledEventRow {
  [key: string]: SqlStorageValue;
  id: string;
  event_kind: string;
  due_at: number;
  payload_json: string;
}

interface SessionRecord {
  sessionId: string;
  soulId: string;
  gatewayShard: number;
  renderer: RendererKind;
  reducedMotion: boolean;
  entityId: string | null;
  connectedAt: number;
}

interface QueueEntry {
  sessionId: string;
  soulId: string;
  gatewayShard: number;
  requestedAt: number;
  requestId: string;
  point: NormalizedPoint;
  returningLife: boolean;
}

export interface CoreConnectInput {
  requestId: string;
  token?: string;
  renderer: RendererKind;
  reducedMotion: boolean;
  gatewayShard: number;
}

export interface CoreConnectionAttachment {
  connectionId: string;
  sessionId: string;
  soulId: string;
  renderer: RendererKind;
  gatewayShard: number;
  connectedAt: number;
  rateWindowStartedAt: number;
  rateWindowCount: number;
  rippleWindowStartedAt: number;
  rippleWindowCount: number;
}

export interface CoreConnectResult {
  attachment: CoreConnectionAttachment;
  messages: ServerMessage[];
}

export interface CoreBatchEntry {
  sessionId: string;
  message: Exclude<ClientMessage, { type: "hello" }>;
}

export interface CoreDelivery {
  sessionId: string;
  messages: ServerMessage[];
}

export interface PublicPondStatus {
  world: string;
  protocol: number;
  sequence: number;
  serverTime: number;
  capacity: CapacityState;
  orbit: { epoch: number; periodMs: number; phase: number };
  foundingRipples: number;
  ecology: { canonicalNpcs: number; detailedNpcs: number; backgroundCohorts: number };
}

const SCHEMA_VERSION = 3;
const CORE_NAME = "canonical-world";
const CHECKPOINT_INTERVAL_MS = 15_000;
const LEGENDARY_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const WILD_FISH_TARGET = 48;
const BIRD_TARGET = 6;
const FROG_TARGET = 2;
const BASELINE_LILY_TARGET = 5;
const MAX_ACTIVE_LILIES = 24;
const FROG_RECOVERY_MS = 10 * 60 * 1000;
const FROG_HUNT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const SOUL_PREDATION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const LILY_LIFESPAN_MS = 72 * 60 * 60 * 1000;
const LILY_RETURN_MS = 8_000;
const MICRO_EVENT_MIN_MS = 45_000;
const MICRO_EVENT_MAX_MS = 75_000;
const BIRD_HUNT_MIN_MS = 12 * 60 * 1000;
const BIRD_HUNT_MAX_MS = 18 * 60 * 1000;
const SOUL_TINTS = [0x71c9bd, 0xe7a8a4, 0xe8c477, 0x9fb7df, 0xb8cf89, 0xc9a9dc, 0x86b8ca, 0xd7a48c];
const NAME_ADJECTIVES = [
  "Quiet", "Silver", "Mossy", "Patient", "Tender", "Faint", "Amber", "Blue",
  "Still", "Distant", "Soft", "Lunar", "Pale", "Rainlit", "Hidden", "Warm",
  "Brisk", "Gentle", "Clouded", "Golden", "Dewy", "Wandering", "Small", "Old",
  "New", "Velvet", "Shaded", "Listening", "Bright", "Hushed", "Deep", "Wakeful",
  "Starry", "Leafy", "Kind", "Slow", "Glassy", "Wild", "Resting", "Drifting",
  "Twilit", "Green", "Rosy", "Clear", "Secret", "Falling", "Returning", "Open",
];
const NAME_NOUNS = [
  "Reed", "Current", "Minnow", "Rain", "Ripple", "Fern", "Pebble", "Willow",
  "Tide", "Moth", "Lily", "Mist", "Echo", "Shore", "Pool", "Orbit",
  "Heron", "Brook", "Moon", "Comet", "Clover", "Stone", "Pine", "Lotus",
  "Stream", "Fin", "Dawn", "Dusk", "Shadow", "Glimmer", "Cloud", "Harbor",
  "Meadow", "Cattail", "Wren", "Petal", "Raindrop", "Acorn", "Star", "Murmur",
  "Hollow", "Thistle", "Flame", "Sprout", "Drift", "Lagoon", "Sky", "Memory",
];
const NAME_ENDINGS = [
  "at Dawn", "under Glass", "after Rain", "by Moonlight", "in Reeds", "at Rest",
  "of the Deep", "beneath Earth", "near Home", "in Quiet Water", "at Dusk", "in Orbit",
  "before Morning", "under Stars", "beside Stone", "among Lilies", "after Thunder", "near the Shore",
  "beneath the Moon", "with the Current", "beyond the Ferns", "under Old Light", "in Clear Water", "at First Light",
  "between Worlds", "past the Willow", "under a Small Sky", "near the Cattails", "after the Long Night", "in the Shallows",
  "beneath a Blue Earth", "with Falling Leaves", "at the Waterline", "inside the Quiet", "under Turning Stars", "before the Rain",
];

function asNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rowToEntity(row: EntityRow): SimEntity {
  let state: EntityState["state"] = {};
  try { state = JSON.parse(row.state_json || "{}") as EntityState["state"]; }
  catch { state = {}; }
  return {
    id: row.id,
    kind: row.kind,
    soulId: row.soul_id,
    lifeId: row.life_id,
    label: row.label,
    x: row.x,
    z: row.z,
    depth: row.depth,
    heading: row.heading,
    speed: row.speed,
    size: row.size,
    tint: row.tint,
    ageRatio: row.age_ratio,
    bornAt: row.born_at,
    endsAt: row.ends_at,
    refugeUntil: row.refuge_until,
    lifeKind: row.life_kind,
    memorialPhase: row.memorial_phase,
    state,
    foreground: row.is_foreground === 1,
    seed: row.seed,
    updatedAt: row.updated_at,
  };
}

function entityForWire(entity: SimEntity): EntityState {
  const { foreground: _foreground, seed: _seed, updatedAt: _updatedAt, ...wire } = entity;
  return wire;
}

function wildOrdinal(entity: SimEntity): number {
  const match = /_(\d+)$/u.exec(entity.id);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function encodeToken(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function makeToken(): string {
  return encodeToken(crypto.getRandomValues(new Uint8Array(32)));
}

export class PondCoreV2 extends DurableObject<Env> {
  private readonly entities = new Map<string, SimEntity>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly queue: QueueEntry[] = [];
  private readonly pendingRituals: RitualEvent[] = [];
  private readonly pendingRippleCells = new Map<string, RitualEvent>();
  private readonly activeNatureEvents = new Map<string, NatureEvent>();
  private readonly removedSinceDelta = new Set<string>();
  private readonly lastWireEntities = new Map<string, EntityState>();
  private readonly actionTimes = new Map<string, Map<string, number>>();
  private readonly activeGatewayShards = new Set<number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickRunning = false;
  private sequence = 0;
  private orbitEpoch = 0;
  private pondBornAt = 0;
  private lastTickAt = 0;
  private lastCheckpointAt = 0;
  private lastPresenceAt = 0;
  private lastLegendaryAt = 0;
  private nextMicroAt = 0;
  private nextBirdHuntAt = 0;
  private lastFrogHuntAt = 0;
  private lastSoulPredationAt = 0;
  private ecologicalEnergy = 0;
  private foundingRipples = 0;
  private readonly capacityLimit: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.capacityLimit = Math.max(1, Math.min(200, asNumber(env.WORLD_CAPACITY, 128)));
    this.ctx.blockConcurrencyWhile(async () => {
      this.installSchema();
      this.loadWorld();
    });
  }

  private installSchema(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);
    const current = sql.exec<{ version: number }>("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").one().version;
    if (current >= SCHEMA_VERSION) return;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS souls (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        poetic_name TEXT NOT NULL UNIQUE,
        tint INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        completed_lives INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS lives (
        id TEXT PRIMARY KEY,
        soul_id TEXT,
        life_kind TEXT NOT NULL CHECK (life_kind IN ('mortal', 'memorial')),
        started_at INTEGER NOT NULL,
        ends_at INTEGER,
        ended_at INTEGER,
        poetic_record TEXT,
        memorial_phase TEXT CHECK (memorial_phase IN ('water', 'dome') OR memorial_phase IS NULL),
        memorial_name TEXT,
        owner_soul_id TEXT,
        billing_reference TEXT,
        FOREIGN KEY (soul_id) REFERENCES souls(id)
      );
      CREATE INDEX IF NOT EXISTS lives_soul_active ON lives(soul_id, ended_at);
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        soul_id TEXT,
        life_id TEXT,
        label TEXT,
        kind TEXT NOT NULL,
        x REAL NOT NULL,
        z REAL NOT NULL,
        depth REAL NOT NULL,
        heading REAL NOT NULL,
        speed REAL NOT NULL,
        size REAL NOT NULL,
        tint INTEGER NOT NULL,
        age_ratio REAL NOT NULL,
        born_at INTEGER,
        ends_at INTEGER,
        refuge_until INTEGER,
        life_kind TEXT,
        memorial_phase TEXT,
        is_foreground INTEGER NOT NULL DEFAULT 0,
        seed INTEGER NOT NULL,
        state_json TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (soul_id) REFERENCES souls(id),
        FOREIGN KEY (life_id) REFERENCES lives(id)
      );
      CREATE INDEX IF NOT EXISTS entities_soul ON entities(soul_id);
      CREATE INDEX IF NOT EXISTS entities_foreground ON entities(is_foreground, kind);
      CREATE TABLE IF NOT EXISTS background_cohorts (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        count INTEGER NOT NULL,
        seed INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        soul_id TEXT,
        life_id TEXT,
        display_name TEXT NOT NULL,
        tint INTEGER NOT NULL,
        life_kind TEXT NOT NULL,
        completed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memories_completed ON memories(completed_at DESC);
      CREATE TABLE IF NOT EXISTS scheduled_events (
        id TEXT PRIMARY KEY,
        event_kind TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        completed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS world_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS founding_ripples (
        id TEXT PRIMARY KEY,
        seed INTEGER NOT NULL,
        intensity REAL NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS offerings (
        id TEXT PRIMARY KEY,
        soul_id TEXT NOT NULL,
        offering_kind TEXT NOT NULL,
        accepted_at INTEGER NOT NULL,
        x REAL NOT NULL,
        z REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS offerings_soul_time ON offerings(soul_id, accepted_at DESC);
      CREATE INDEX IF NOT EXISTS offerings_kind_time ON offerings(offering_kind, accepted_at DESC);
      CREATE TABLE IF NOT EXISTS analytics_daily (
        day TEXT NOT NULL,
        event TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        quality_sum REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (day, event)
      );
    `);
    if (current < 1) sql.exec("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)", Date.now());
    if (current < 2) {
      const columns = sql.exec<{ [key: string]: SqlStorageValue; name: string }>("PRAGMA table_info(entities)").toArray();
      if (!columns.some((column) => column.name === "label")) sql.exec("ALTER TABLE entities ADD COLUMN label TEXT");
      sql.exec("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, ?)", Date.now());
    }
    if (current < 3) {
      const columns = sql.exec<{ [key: string]: SqlStorageValue; name: string }>("PRAGMA table_info(entities)").toArray();
      if (!columns.some((column) => column.name === "state_json")) {
        sql.exec("ALTER TABLE entities ADD COLUMN state_json TEXT NOT NULL DEFAULT '{}'");
      }
      sql.exec("CREATE INDEX IF NOT EXISTS offerings_kind_time ON offerings(offering_kind, accepted_at DESC)");
      sql.exec("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, ?)", Date.now());
    }
  }

  private readMeta(key: string): string | null {
    const rows = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM world_meta WHERE key = ?", key).toArray();
    return rows[0]?.value ?? null;
  }

  private writeMeta(key: string, value: string | number): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO world_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      String(value),
    );
  }

  private loadWorld(): void {
    const now = Date.now();
    this.pondBornAt = asNumber(this.readMeta("pond_born_at") ?? undefined, now);
    this.orbitEpoch = asNumber(this.readMeta("orbit_epoch") ?? undefined, Math.floor(now / ORBIT_PERIOD_MS) * ORBIT_PERIOD_MS);
    this.sequence = asNumber(this.readMeta("sequence") ?? undefined, 0);
    this.lastTickAt = asNumber(this.readMeta("last_tick_at") ?? undefined, now);
    this.lastLegendaryAt = asNumber(this.readMeta("last_legendary_at") ?? undefined, 0);
    this.nextMicroAt = asNumber(this.readMeta("next_micro_at") ?? undefined, this.nextNatureTime("micro", now, MICRO_EVENT_MIN_MS, MICRO_EVENT_MAX_MS));
    this.nextBirdHuntAt = asNumber(this.readMeta("next_bird_hunt_at") ?? undefined, this.nextNatureTime("hunt", now, BIRD_HUNT_MIN_MS, BIRD_HUNT_MAX_MS));
    this.lastFrogHuntAt = asNumber(this.readMeta("last_frog_hunt_at") ?? undefined, 0);
    this.lastSoulPredationAt = asNumber(this.readMeta("last_soul_predation_at") ?? undefined, 0);
    this.writeMeta("pond_born_at", this.pondBornAt);
    this.writeMeta("orbit_epoch", this.orbitEpoch);

    const rows = this.ctx.storage.sql.exec<EntityRow>("SELECT * FROM entities").toArray();
    for (const row of rows) {
      let entity = rowToEntity(row);
      if (entity.soulId) entity.foreground = false;
      entity = fastForwardEntity(entity, now);
      if (entity.kind === "legendaryPenguin" && entity.endsAt !== null && entity.endsAt <= now) {
        this.ctx.storage.sql.exec("DELETE FROM entities WHERE id = ?", entity.id);
        continue;
      }
      if (isNaturalLifeComplete(entity, now)) {
        this.completeLife(entity, now);
        continue;
      }
      this.entities.set(entity.id, entity);
      this.persistEntity(entity);
    }

    this.migrateCanonicalEcology(now);
    this.loadScheduledNature(now);
    this.initializeFoundingRipples(asNumber(this.env.FOUNDING_RIPPLES, 149));
    this.foundingRipples = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM founding_ripples").one().count;
    this.lastTickAt = now;
    this.lastCheckpointAt = now;
    this.checkpoint();
  }

  private migrateCanonicalEcology(now: number): void {
    const generation = asNumber(this.readMeta("ecology_generation") ?? undefined, 0);
    if (generation >= 4) return;

    if (generation < 3) {
      for (const entity of [...this.entities.values()]) {
        if (entity.soulId || entity.kind === "legendaryPenguin") continue;
        this.entities.delete(entity.id);
        this.ctx.storage.sql.exec("DELETE FROM entities WHERE id = ?", entity.id);
      }
      const wildlife: SimEntity[] = [];
      for (let index = 0; index < WILD_FISH_TARGET; index++) wildlife.push(createWildEntity("wildFish", index, now));
      for (let index = 0; index < BIRD_TARGET; index++) wildlife.push(createWildEntity("bird", index, now));
      for (let index = 0; index < BASELINE_LILY_TARGET; index++) wildlife.push(createWildEntity("lily", index, now));
      for (let index = 0; index < FROG_TARGET; index++) wildlife.push(createWildEntity("frog", index, now));
      for (const entity of wildlife) {
        if (this.entities.has(entity.id)) continue;
        this.entities.set(entity.id, entity);
        this.persistEntity(entity);
      }
    } else {
      for (const entity of this.entities.values()) {
        if (entity.kind !== "bird" && entity.kind !== "frog") continue;
        const index = Math.max(0, Number.parseInt(entity.id.split("_").pop() ?? "0", 10) || 0);
        const {
          transitionFrom: _transitionFrom,
          transitionTo: _transitionTo,
          transitionStartedAt: _transitionStartedAt,
          transitionEndsAt: _transitionEndsAt,
          ...rest
        } = entity.state;
        if (entity.kind === "bird") {
          const mode = rest.mode === "foraging" || rest.mode === "perched" ? rest.mode : "circling";
          const targetAnchor = index % BIRD_PERCH_ANCHORS.length;
          entity.state = { ...rest, mode, targetAnchor };
          if (mode === "perched") {
            const anchor = BIRD_PERCH_ANCHORS[targetAnchor] ?? BIRD_PERCH_ANCHORS[0];
            entity.x = anchor.x;
            entity.z = anchor.z;
          } else {
            const moved = advanceEntity(entity, this.sequence, 0, now);
            entity.x = moved.x;
            entity.z = moved.z;
            entity.heading = moved.heading;
          }
        } else {
          const mode = rest.mode ?? "floating";
          const pool = mode === "shore" ? [2, 3] : mode === "ground" ? [4, 5] : [0, 1];
          const targetAnchor = Number(pool[index % pool.length] ?? pool[0] ?? 0);
          const anchor = FROG_HABITAT_ANCHORS[targetAnchor] ?? FROG_HABITAT_ANCHORS[0];
          entity.state = { ...rest, mode, targetAnchor };
          entity.x = anchor.x;
          entity.z = anchor.z;
        }
        entity.updatedAt = now;
        this.persistEntity(entity);
      }
    }
    this.writeMeta("ecology_generation", 4);
    this.writeMeta("next_micro_at", this.nextMicroAt);
    this.writeMeta("next_bird_hunt_at", this.nextBirdHuntAt);
  }

  private loadScheduledNature(now: number): void {
    const rows = this.ctx.storage.sql.exec<ScheduledEventRow>(
      "SELECT id, event_kind, due_at, payload_json FROM scheduled_events WHERE completed_at IS NULL AND due_at > ? ORDER BY due_at LIMIT 64",
      now - 60_000,
    ).toArray();
    for (const row of rows) {
      if (row.event_kind !== "nature_visible") continue;
      try {
        const event = JSON.parse(row.payload_json) as NatureEvent;
        if (event.endsAt > now) this.activeNatureEvents.set(event.id, event);
      } catch { /* Ignore legacy or malformed temporary events. */ }
    }
  }

  private initializeFoundingRipples(requestedCount: number): void {
    const existing = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM founding_ripples").one().count;
    if (existing > 0) return;
    const count = Math.max(0, Math.min(100_000, Math.round(requestedCount)));
    const now = Date.now();
    for (let index = 0; index < count; index++) {
      const seed = hashString32(`founding-ripple:${index}`);
      const random = mulberry32(seed);
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO founding_ripples(id, seed, intensity, created_at) VALUES (?, ?, ?, ?)",
        `founding_${index}`,
        seed,
        0.25 + random() * 0.75,
        now,
      );
    }
  }

  private persistEntity(entity: SimEntity): void {
    this.ctx.storage.sql.exec(`
      INSERT INTO entities(
        id, soul_id, life_id, label, kind, x, z, depth, heading, speed, size, tint,
        age_ratio, born_at, ends_at, refuge_until, life_kind, memorial_phase,
        is_foreground, seed, state_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        soul_id = excluded.soul_id,
        life_id = excluded.life_id,
        label = excluded.label,
        kind = excluded.kind,
        x = excluded.x,
        z = excluded.z,
        depth = excluded.depth,
        heading = excluded.heading,
        speed = excluded.speed,
        size = excluded.size,
        tint = excluded.tint,
        age_ratio = excluded.age_ratio,
        born_at = excluded.born_at,
        ends_at = excluded.ends_at,
        refuge_until = excluded.refuge_until,
        life_kind = excluded.life_kind,
        memorial_phase = excluded.memorial_phase,
        is_foreground = excluded.is_foreground,
        seed = excluded.seed,
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `,
    entity.id, entity.soulId, entity.lifeId, entity.label, entity.kind, entity.x, entity.z, entity.depth,
    entity.heading, entity.speed, entity.size, entity.tint, entity.ageRatio, entity.bornAt,
    entity.endsAt, entity.refugeUntil, entity.lifeKind, entity.memorialPhase,
    entity.foreground ? 1 : 0, entity.seed, JSON.stringify(entity.state), entity.updatedAt);
  }

  private identityForSoul(row: SoulRow): SoulIdentity {
    return { id: row.id, name: row.poetic_name, tint: row.tint, completedLives: row.completed_lives };
  }

  private findSoulByTokenHash(tokenHash: string): SoulRow | null {
    return this.ctx.storage.sql.exec<SoulRow>(
      "SELECT id, poetic_name, tint, completed_lives, last_seen_at FROM souls WHERE token_hash = ?",
      tokenHash,
    ).toArray()[0] ?? null;
  }

  private createPoeticName(soulId: string): string {
    const seed = hashString32(soulId);
    const adjective = NAME_ADJECTIVES[seed % NAME_ADJECTIVES.length] ?? "Quiet";
    const noun = NAME_NOUNS[(seed >>> 7) % NAME_NOUNS.length] ?? "Ripple";
    const ending = NAME_ENDINGS[(seed >>> 14) % NAME_ENDINGS.length] ?? "under Glass";
    const candidate = `${adjective} ${noun} ${ending}`;
    const exists = this.ctx.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM souls WHERE poetic_name = ?",
      candidate,
    ).one().count;
    return exists === 0 ? candidate : `${candidate} ${String((seed % 89) + 11)}`;
  }

  private createSoul(tokenHash: string, now: number): SoulRow {
    const id = crypto.randomUUID();
    const seed = hashString32(id);
    const poeticName = this.createPoeticName(id);
    const tint = SOUL_TINTS[seed % SOUL_TINTS.length] ?? 0x71c9bd;
    this.ctx.storage.sql.exec(
      "INSERT INTO souls(id, token_hash, poetic_name, tint, created_at, last_seen_at, completed_lives) VALUES (?, ?, ?, ?, ?, ?, 0)",
      id, tokenHash, poeticName, tint, now, now,
    );
    return { id, poetic_name: poeticName, tint, completed_lives: 0, last_seen_at: now };
  }

  private findSoulEntity(soulId: string): SimEntity | null {
    for (const entity of this.entities.values()) if (entity.soulId === soulId && entity.kind === "soulFish") return entity;
    return null;
  }

  private foregroundSoulCount(): number {
    let count = 0;
    for (const entity of this.entities.values()) if (entity.kind === "soulFish" && entity.foreground) count++;
    return count;
  }

  private connectedSoulCount(): number {
    return new Set([...this.sessions.values()].map((session) => session.soulId)).size;
  }

  private capacity(): CapacityState {
    const embodied = this.foregroundSoulCount();
    return {
      embodied,
      limit: this.capacityLimit,
      spectators: Math.max(0, this.sessions.size - embodied),
      queued: this.queue.length,
    };
  }

  private orbit(now: number) {
    return {
      epoch: this.orbitEpoch,
      periodMs: ORBIT_PERIOD_MS,
      phase: orbitPhaseAt(now, this.orbitEpoch),
    };
  }

  private getBackgroundCohorts(): BackgroundCohort[] {
    const groups = new Map<string, SimEntity[]>();
    for (const entity of this.entities.values()) {
      let kind: BackgroundCohort["kind"];
      let key: string;
      if (entity.soulId) {
        if (entity.foreground) continue;
        kind = entity.lifeKind === "memorial" ? "memorial" : "mortal";
        key = `${kind}:${Math.abs(entity.tint) % 4}`;
      } else {
        if (entity.kind !== "wildFish") continue;
        kind = "wild";
        key = `wild:${entity.tint.toString(16)}`;
      }
      const list = groups.get(key) ?? [];
      list.push(entity);
      groups.set(key, list);
    }
    return [...groups.entries()].map(([key, entities]) => ({
      id: `cohort_${key}`,
      kind: key.startsWith("wild") ? "wild" as const : key.startsWith("memorial") ? "memorial" as const : "mortal" as const,
      populationCount: entities.length,
      x: entities.reduce((sum, entity) => sum + entity.x, 0) / entities.length,
      z: entities.reduce((sum, entity) => sum + entity.z, 0) / entities.length,
      tint: entities[0]?.tint ?? 0x71c9bd,
      seed: hashString32(key),
    }));
  }

  private recentLifeRecord(soulId: string, since: number): RecentLifeRecord | undefined {
    const row = this.ctx.storage.sql.exec<{
      memory_id: string;
      poetic_record: string | null;
      completed_at: number;
    }>(`
      SELECT memories.id AS memory_id, lives.poetic_record, memories.completed_at
      FROM memories JOIN lives ON lives.id = memories.life_id
      WHERE memories.soul_id = ? AND memories.completed_at > ?
      ORDER BY memories.completed_at DESC LIMIT 1
    `, soulId, since).toArray()[0];
    if (!row) return undefined;
    return {
      memoryId: row.memory_id,
      ageText: row.poetic_record ?? "one remembered passage",
      completedAt: row.completed_at,
    };
  }

  private idleWildIds(now: number): Set<string> {
    const phase = orbitPhaseAt(now, this.orbitEpoch);
    const count = phase > 0.18 && phase < 0.82 ? 2 : phase > 0.08 && phase < 0.92 ? 1 : 0;
    const wild = [...this.entities.values()]
      .filter((entity) => entity.kind === "wildFish")
      .sort((a, b) => a.id.localeCompare(b.id));
    const offset = wild.length === 0 ? 0 : Math.floor(now / 45_000) % wild.length;
    const visible = new Set<string>();
    for (let index = 0; index < count; index++) {
      const entity = wild[(offset + index * 13) % wild.length];
      if (entity) visible.add(entity.id);
    }
    for (const event of this.activeNatureEvents.values()) {
      if (event.endsAt <= now) continue;
      for (const id of event.targetIds) if (this.entities.get(id)?.kind === "wildFish") visible.add(id);
    }
    return visible;
  }

  private wireEntities(now: number): SimEntity[] {
    const visibleWild = this.idleWildIds(now);
    return [...this.entities.values()].filter((entity) => {
      if (entity.soulId) return entity.foreground;
      if (entity.kind === "wildFish") return visibleWild.has(entity.id);
      return true;
    });
  }

  private getMemories(): DomeMemory[] {
    return this.ctx.storage.sql.exec<{
      id: string;
      soul_id: string | null;
      display_name: string;
      tint: number;
      completed_at: number;
      life_kind: "mortal" | "memorial";
    }>("SELECT id, soul_id, display_name, tint, completed_at, life_kind FROM memories ORDER BY completed_at DESC LIMIT 120")
      .toArray()
      .map((row) => ({
        id: row.id,
        soulId: row.soul_id,
        name: row.display_name,
        tint: row.tint,
        completedAt: row.completed_at,
        lifeKind: row.life_kind,
      }));
  }

  private snapshot(now = Date.now()): WorldSnapshot {
    const entities = this.wireEntities(now).map(entityForWire);
    return {
      serverTime: now,
      orbit: this.orbit(now),
      sequence: this.sequence,
      entities,
      backgroundCohorts: this.getBackgroundCohorts(),
      natureEvents: [...this.activeNatureEvents.values()].filter((event) => event.endsAt > now),
      memories: this.getMemories(),
      foundingRipples: this.foundingRipples,
      pondBornAt: this.pondBornAt,
      capacity: this.capacity(),
      connectedSouls: this.connectedSoulCount(),
    };
  }

  async connectSoul(input: CoreConnectInput): Promise<CoreConnectResult> {
    const now = Date.now();
    let issuedToken: string | undefined;
    let soul: SoulRow | null = null;
    let recentLifeRecord: RecentLifeRecord | undefined;
    if (input.token && input.token.length >= 20 && input.token.length <= 256) {
      soul = this.findSoulByTokenHash(await hashToken(input.token));
    }
    if (!soul) {
      issuedToken = makeToken();
      soul = this.createSoul(await hashToken(issuedToken), now);
      this.track("new_soul");
    } else {
      recentLifeRecord = this.recentLifeRecord(soul.id, soul.last_seen_at);
      this.ctx.storage.sql.exec("UPDATE souls SET last_seen_at = ? WHERE id = ?", now, soul.id);
    }

    const sessionId = crypto.randomUUID();
    const session: SessionRecord = {
      sessionId,
      soulId: soul.id,
      gatewayShard: input.gatewayShard,
      renderer: input.renderer,
      reducedMotion: input.reducedMotion,
      entityId: null,
      connectedAt: now,
    };
    this.sessions.set(sessionId, session);
    this.activeGatewayShards.add(input.gatewayShard);
    const existingEntity = this.findSoulEntity(soul.id);
    const messages: ServerMessage[] = [];

    if (input.renderer === "canvas") {
      this.track("renderer_fallback");
    } else if (existingEntity) {
      if (this.foregroundSoulCount() < this.capacityLimit || existingEntity.foreground) {
        existingEntity.foreground = true;
        existingEntity.updatedAt = now;
        session.entityId = existingEntity.id;
        this.persistEntity(existingEntity);
        this.track("return");
      } else {
        this.enqueue({
          sessionId,
          soulId: soul.id,
          gatewayShard: input.gatewayShard,
          requestedAt: now,
          requestId: input.requestId,
          point: { x: existingEntity.x, z: existingEntity.z },
          returningLife: true,
        });
      }
    }

    const welcome: WelcomeMessage = {
      v: PROTOCOL_VERSION,
      type: "welcome",
      requestId: input.requestId,
      serverTime: now,
      token: issuedToken,
      sessionId,
      identity: this.identityForSoul(soul),
      ownedEntityId: session.entityId ?? existingEntity?.id ?? null,
      renderer: input.renderer,
      recentLifeRecord,
    };
    const snapshot: SnapshotMessage = {
      v: PROTOCOL_VERSION,
      type: "snapshot",
      requestId: input.requestId,
      snapshot: this.snapshot(now),
    };
    messages.push(welcome, snapshot);
    const queued = this.queue.find((entry) => entry.sessionId === sessionId);
    if (queued) messages.push(this.queueMessage(queued, input.requestId));

    this.track("connection");
    this.startSimulation();
    return {
      attachment: {
        connectionId: crypto.randomUUID(),
        sessionId,
        soulId: soul.id,
        renderer: input.renderer,
        gatewayShard: input.gatewayShard,
        connectedAt: now,
        rateWindowStartedAt: now,
        rateWindowCount: 0,
        rippleWindowStartedAt: now,
        rippleWindowCount: 0,
      },
      messages,
    };
  }

  private enqueue(entry: QueueEntry): void {
    if (this.queue.some((queued) => queued.sessionId === entry.sessionId)) return;
    insertReturningFirstFifo(this.queue, entry);
    this.track("queue");
  }

  private queueMessage(entry: QueueEntry, requestId: string): QueueMessage {
    return {
      v: PROTOCOL_VERSION,
      type: "queue",
      requestId,
      position: Math.max(1, this.queue.indexOf(entry) + 1),
      capacity: this.capacity(),
      returningLife: entry.returningLife,
    };
  }

  async receiveBatch(input: { gatewayShard: number; entries: CoreBatchEntry[] }): Promise<CoreDelivery[]> {
    const deliveries: CoreDelivery[] = [];
    for (const entry of input.entries.slice(0, 100)) {
      const session = this.sessions.get(entry.sessionId);
      if (!session || session.gatewayShard !== input.gatewayShard) {
        deliveries.push({
          sessionId: entry.sessionId,
          messages: [{
            v: PROTOCOL_VERSION,
            type: "error",
            requestId: entry.message.requestId,
            code: "not_ready",
            message: "The pond needs to know this soul again.",
          }],
        });
        continue;
      }
      const messages = this.handleMessage(session, entry.message);
      if (messages.length > 0) deliveries.push({ sessionId: entry.sessionId, messages });
    }
    return deliveries;
  }

  private actionAllowed(soulId: string, kind: string, now: number, minimumGapMs: number): boolean {
    const actions = this.actionTimes.get(soulId) ?? new Map<string, number>();
    const previous = actions.get(kind) ?? 0;
    if (now - previous < minimumGapMs) return false;
    actions.set(kind, now);
    this.actionTimes.set(soulId, actions);
    return true;
  }

  private handleMessage(session: SessionRecord, message: Exclude<ClientMessage, { type: "hello" }>): ServerMessage[] {
    const now = Date.now();
    switch (message.type) {
      case "incarnate":
        return this.handleIncarnate(session, message.requestId, message.point, now);
      case "rippleBatch":
        this.handleRippleBatch(session, message.requestId, message.points, now);
        return [];
      case "offer":
        return this.handleOffer(session, message.requestId, message.point, message.offering, now);
      case "focus":
        if (message.entityId && message.entityId === session.entityId) this.track("ride");
        return [];
      case "leave":
        this.ctx.waitUntil(this.disconnectSoul(session.sessionId));
        return [];
    }
  }

  private handleIncarnate(session: SessionRecord, requestId: string, point: NormalizedPoint, now: number): ServerMessage[] {
    if (session.renderer === "canvas") {
      return [{
        v: PROTOCOL_VERSION,
        type: "ritualAck",
        requestId,
        accepted: false,
        reason: "spectator",
      }];
    }
    if (!this.actionAllowed(session.soulId, "incarnate", now, 1000)) {
      return [{ v: PROTOCOL_VERSION, type: "error", requestId, code: "rate_limited", message: "The water is still settling." }];
    }
    const existing = this.findSoulEntity(session.soulId);
    if (existing) {
      if (this.foregroundSoulCount() < this.capacityLimit || existing.foreground) {
        existing.foreground = true;
        existing.updatedAt = now;
        session.entityId = existing.id;
        this.persistEntity(existing);
        return [{ v: PROTOCOL_VERSION, type: "snapshot", requestId, snapshot: this.snapshot(now) }];
      }
      const queued: QueueEntry = {
        sessionId: session.sessionId,
        soulId: session.soulId,
        gatewayShard: session.gatewayShard,
        requestedAt: now,
        requestId,
        point: { x: existing.x, z: existing.z },
        returningLife: true,
      };
      this.enqueue(queued);
      return [this.queueMessage(queued, requestId)];
    }
    const safePoint = clampNormalizedPoint(point, 0.08);
    if (this.foregroundSoulCount() >= this.capacityLimit) {
      const queued: QueueEntry = {
        sessionId: session.sessionId,
        soulId: session.soulId,
        gatewayShard: session.gatewayShard,
        requestedAt: now,
        requestId,
        point: safePoint,
        returningLife: false,
      };
      this.enqueue(queued);
      return [this.queueMessage(queued, requestId)];
    }
    this.birthSoulFish(session, safePoint, now);
    this.pendingRituals.push(this.ritual("birth", safePoint, session.soulId, now, 0.8));
    return [
      { v: PROTOCOL_VERSION, type: "ritualAck", requestId, accepted: true, sampledPoint: safePoint },
      { v: PROTOCOL_VERSION, type: "snapshot", requestId, snapshot: this.snapshot(now) },
      {
        v: PROTOCOL_VERSION,
        type: "presence",
        requestId,
        connectedSouls: this.connectedSoulCount(),
        capacity: this.capacity(),
      },
    ];
  }

  private birthSoulFish(session: SessionRecord, point: NormalizedPoint, now: number): SimEntity {
    const soul = this.ctx.storage.sql.exec<SoulRow>(
      "SELECT id, poetic_name, tint, completed_lives, last_seen_at FROM souls WHERE id = ?",
      session.soulId,
    ).one();
    const lifeId = crypto.randomUUID();
    const entityId = crypto.randomUUID();
    const entity = createSoulFish({ entityId, soulId: soul.id, lifeId, label: soul.poetic_name, x: point.x, z: point.z, tint: soul.tint, now });
    this.ctx.storage.sql.exec(
      "INSERT INTO lives(id, soul_id, life_kind, started_at, ends_at, memorial_phase, owner_soul_id) VALUES (?, ?, 'mortal', ?, ?, NULL, ?)",
      lifeId, soul.id, now, entity.endsAt, soul.id,
    );
    this.entities.set(entity.id, entity);
    this.persistEntity(entity);
    session.entityId = entity.id;
    this.track("birth");
    return entity;
  }

  private samplePoint(point: NormalizedPoint, soulId: string, requestId: string): NormalizedPoint {
    const random = mulberry32(hashString32(`${soulId}:${requestId}:${this.sequence}`));
    const angle = random() * Math.PI * 2;
    const radius = Math.sqrt(random()) * 0.006;
    return clampNormalizedPoint({ x: point.x + Math.cos(angle) * radius, z: point.z + Math.sin(angle) * radius }, 0.04);
  }

  private ritual(kind: RitualEvent["kind"], point: NormalizedPoint, soulId: string | null, now: number, strength: number): RitualEvent {
    return { id: crypto.randomUUID(), kind, x: point.x, z: point.z, strength, createdAt: now, soulId };
  }

  private handleRippleBatch(
    session: SessionRecord,
    requestId: string,
    points: NormalizedPoint[],
    now: number,
  ): void {
    for (const [index, point] of points.slice(0, 12).entries()) {
      const sampledPoint = this.samplePoint(point, session.soulId, `${requestId}_${index}`);
      const cellX = Math.max(0, Math.min(11, Math.floor(sampledPoint.x * 12)));
      const cellZ = Math.max(0, Math.min(11, Math.floor(sampledPoint.z * 12)));
      const key = `${cellX}:${cellZ}`;
      const existing = this.pendingRippleCells.get(key);
      if (existing) {
        const weight = Math.min(8, Math.max(1, Math.round(existing.strength / 0.12)));
        existing.x = (existing.x * weight + sampledPoint.x) / (weight + 1);
        existing.z = (existing.z * weight + sampledPoint.z) / (weight + 1);
        existing.strength = Math.min(1, existing.strength + 0.12);
        existing.createdAt = now;
      } else if (this.pendingRippleCells.size < 48) {
        this.pendingRippleCells.set(key, this.ritual("ripple", sampledPoint, session.soulId, now, 0.34));
      }
      this.reactToRipple(sampledPoint, now);
    }
    this.ecologicalEnergy = Math.min(1, this.ecologicalEnergy + Math.min(0.08, points.length * 0.006));
  }

  private handleOffer(
    session: SessionRecord,
    requestId: string,
    point: NormalizedPoint,
    offering: "food" | "seed",
    now: number,
  ): ServerMessage[] {
    if (session.renderer === "canvas") {
      return [{ v: PROTOCOL_VERSION, type: "ritualAck", requestId, accepted: false, reason: "spectator" }];
    }
    if (!session.entityId || !this.entities.has(session.entityId)) {
      return [{ v: PROTOCOL_VERSION, type: "ritualAck", requestId, accepted: false, reason: "unborn" }];
    }
    const recent = this.ctx.storage.sql.exec<{ accepted_at: number }>(
      "SELECT accepted_at FROM offerings WHERE soul_id = ? ORDER BY accepted_at DESC LIMIT 1",
      session.soulId,
    ).toArray()[0];
    const nextOfferingAt = (recent?.accepted_at ?? 0) + OFFERING_COOLDOWN_MS;
    if (now < nextOfferingAt) {
      return [{ v: PROTOCOL_VERSION, type: "ritualAck", requestId, accepted: false, reason: "cooldown", nextOfferingAt }];
    }
    const sampledPoint = this.samplePoint(point, session.soulId, requestId);
    this.ctx.storage.sql.exec(
      "INSERT INTO offerings(id, soul_id, offering_kind, accepted_at, x, z) VALUES (?, ?, ?, ?, ?, ?)",
      crypto.randomUUID(), session.soulId, offering, now, sampledPoint.x, sampledPoint.z,
    );
    this.pendingRituals.push(this.ritual(offering, sampledPoint, session.soulId, now, offering === "food" ? 0.7 : 0.55));
    if (offering === "food") this.createFoodAttractor(sampledPoint, now);
    else this.createVisitorLily(sampledPoint, session.soulId, now);
    this.ecologicalEnergy = Math.min(1, this.ecologicalEnergy + 0.12);
    this.track("offering");
    return [{
      v: PROTOCOL_VERSION,
      type: "ritualAck",
      requestId,
      accepted: true,
      sampledPoint,
      nextOfferingAt: now + OFFERING_COOLDOWN_MS,
    }];
  }

  private nextNatureTime(label: string, now: number, minimum: number, maximum: number): number {
    const bucket = Math.floor(now / Math.max(1, minimum));
    const random = mulberry32(hashString32(`${CORE_NAME}:${label}:${bucket}:${this.sequence}`));
    return now + minimum + random() * Math.max(0, maximum - minimum);
  }

  private natureEvent(
    kind: NatureEventKind,
    point: NormalizedPoint,
    now: number,
    durationMs: number,
    targetIds: string[] = [],
    strength = 0.6,
    from?: NormalizedPoint,
    to?: NormalizedPoint,
  ): NatureEvent {
    const id = crypto.randomUUID();
    return {
      id,
      kind,
      startsAt: now,
      endsAt: now + durationMs,
      x: point.x,
      z: point.z,
      strength,
      seed: hashString32(id),
      targetIds,
      from,
      to,
    };
  }

  private activateNature(event: NatureEvent, persist = false): void {
    this.activeNatureEvents.set(event.id, event);
    if (!persist) return;
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO scheduled_events(id, event_kind, due_at, payload_json, completed_at) VALUES (?, 'nature_visible', ?, ?, NULL)",
      `visible_${event.id}`, event.endsAt, JSON.stringify(event),
    );
  }

  private scheduleNature(eventKind: string, dueAt: number, payload: Record<string, unknown>): string {
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      "INSERT INTO scheduled_events(id, event_kind, due_at, payload_json, completed_at) VALUES (?, ?, ?, ?, NULL)",
      id, eventKind, dueAt, JSON.stringify(payload),
    );
    return id;
  }

  private createFoodAttractor(point: NormalizedPoint, now: number): void {
    const fish = [...this.entities.values()]
      .filter((entity) => entity.kind === "wildFish")
      .sort((a, b) => Math.hypot(a.x - point.x, a.z - point.z) - Math.hypot(b.x - point.x, b.z - point.z))
      .slice(0, 6);
    const event = this.natureEvent("food_gathering", point, now, 60_000, fish.map((entity) => entity.id), 0.85);
    this.activateNature(event, true);
    for (const entity of fish) {
      entity.heading = Math.atan2(point.z - entity.z, point.x - entity.x);
      entity.depth = Math.max(0.12, entity.depth - 0.12);
      entity.updatedAt = now;
    }
  }

  private createVisitorLily(point: NormalizedPoint, soulId: string, now: number): void {
    const lilies = [...this.entities.values()].filter((entity) => entity.kind === "lily");
    if (lilies.length >= MAX_ACTIVE_LILIES) {
      const oldest = lilies
        .filter((entity) => entity.state.source === "offering")
        .sort((a, b) => (a.bornAt ?? 0) - (b.bornAt ?? 0))[0];
      if (oldest) {
        oldest.state = { ...oldest.state, mode: "returning", returningAt: now };
        oldest.endsAt = now + LILY_RETURN_MS;
        oldest.updatedAt = now;
        this.persistEntity(oldest);
        this.activateNature(this.natureEvent("lily_return", { x: oldest.x, z: oldest.z }, now, LILY_RETURN_MS, [oldest.id], 0.45), true);
        this.scheduleNature("lily_remove", oldest.endsAt, { entityId: oldest.id });
      }
    }
    const lily = createWildEntity("lily", hashString32(`${soulId}:${now}`) % 10_000, now);
    lily.id = `lily_offering_${crypto.randomUUID()}`;
    lily.x = point.x;
    lily.z = point.z;
    lily.size = 0.82 + (hashString32(lily.id) % 26) / 100;
    lily.bornAt = now;
    lily.endsAt = now + LILY_LIFESPAN_MS;
    lily.ageRatio = 0;
    lily.state = {
      source: "offering",
      ownerSoulId: soulId,
      returningAt: lily.endsAt - ORBIT_PERIOD_MS,
    };
    lily.updatedAt = now;
    this.entities.set(lily.id, lily);
    this.persistEntity(lily);
    this.scheduleNature("lily_remove", lily.endsAt, { entityId: lily.id });
    this.activateNature(this.natureEvent("lily_movement", point, now, 5_000, [lily.id], 0.55), true);
  }

  private reactToRipple(point: NormalizedPoint, now: number): void {
    for (const entity of this.entities.values()) {
      const dx = entity.x - point.x;
      const dz = entity.z - point.z;
      const distance = Math.hypot(dx, dz);
      if (distance > 0.11) continue;
      if (entity.kind === "wildFish" || entity.kind === "soulFish" || entity.kind === "legendaryPenguin") {
        entity.heading = Math.atan2(dz, dx);
        entity.depth = Math.min(0.72, entity.depth + 0.025);
      } else if (entity.kind === "frog" && entity.state.mode !== "feeding") {
        const target = clampNormalizedPoint({ x: entity.x + dx * 0.35, z: entity.z + dz * 0.35 }, 0.1);
        entity.state = {
          ...entity.state,
          mode: "floating",
          transitionFrom: { x: entity.x, z: entity.z },
          transitionTo: target,
          transitionStartedAt: now,
          transitionEndsAt: now + 900,
        };
      } else if (entity.kind === "bird" && entity.state.mode !== "circling") {
        entity.state = { ...entity.state, mode: "circling", transitionStartedAt: now, transitionEndsAt: now + 1_800 };
      }
      entity.updatedAt = now;
    }
  }

  private selectEntity(kind: EntityKind, seed: number): SimEntity | null {
    const matches = [...this.entities.values()].filter((entity) => entity.kind === kind).sort((a, b) => a.id.localeCompare(b.id));
    return matches.length > 0 ? matches[seed % matches.length] ?? null : null;
  }

  private beginFrogFeed(now: number, seed: number): void {
    const frog = this.selectEntity("frog", seed);
    if (!frog) return;
    const previousMode = frog.state.mode ?? "floating";
    const angle = ((seed >>> 5) % 6283) / 1000;
    const reach = 0.035 + ((seed >>> 17) % 20) / 1000;
    const insect = clampNormalizedPoint({ x: frog.x + Math.cos(angle) * reach, z: frog.z + Math.sin(angle) * reach }, 0.04);
    frog.state = { ...frog.state, mode: "feeding", nextActionAt: now + 2_300 };
    frog.updatedAt = now;
    const insectId = `insect_${seed}`;
    const event: NatureEvent = {
      ...this.natureEvent("frog_feed", { x: frog.x, z: frog.z }, now, 3_200, [frog.id, insectId], 0.9, insect, { x: frog.x, z: frog.z }),
      frogId: frog.id,
      insectId,
    };
    this.activateNature(event, true);
    this.scheduleNature("frog_feed_resolve", now + 2_300, {
      frogId: frog.id,
      previousMode,
      targetAnchor: frog.state.targetAnchor ?? 0,
    });
  }

  private transitionFrog(now: number, seed: number): void {
    const frog = this.selectEntity("frog", seed);
    if (!frog || frog.state.mode === "feeding") return;
    const modes = ["swimming", "floating", "lily", "shore", "ground"] as const;
    const mode = modes[(seed >>> 4) % modes.length] ?? "floating";
    const anchorPool = mode === "shore" ? [2, 3] : mode === "ground" ? [4, 5] : [0, 1];
    const anchorIndex = Number(anchorPool[(seed >>> 11) % anchorPool.length] ?? anchorPool[0] ?? 0);
    const anchor = FROG_HABITAT_ANCHORS[anchorIndex] ?? FROG_HABITAT_ANCHORS[0];
    const duration = mode === "ground" || mode === "shore" ? 2_400 : 1_400;
    frog.state = {
      ...frog.state,
      mode,
      targetAnchor: anchorIndex,
      transitionFrom: { x: frog.x, z: frog.z },
      transitionTo: anchor,
      transitionStartedAt: now,
      transitionEndsAt: now + duration,
    };
    frog.updatedAt = now;
    this.activateNature(this.natureEvent("frog_hop", { x: frog.x, z: frog.z }, now, duration, [frog.id], 0.6, { x: frog.x, z: frog.z }, anchor), true);
  }

  private transitionBird(now: number, seed: number): void {
    const bird = this.selectEntity("bird", seed);
    if (!bird) return;
    const current = bird.state.mode ?? "circling";
    const nextMode = current === "circling" ? "foraging" : current === "foraging" ? "perched" : "circling";
    const anchorIndex = (seed >>> 9) % BIRD_PERCH_ANCHORS.length;
    let target: NormalizedPoint = BIRD_PERCH_ANCHORS[anchorIndex] ?? BIRD_PERCH_ANCHORS[0];
    if (nextMode === "foraging") {
      const angle = ((seed >>> 3) % 6283) / 1000;
      target = { x: 0.5 + Math.cos(angle) * 0.472, z: 0.5 + Math.sin(angle) * 0.472 };
    } else if (nextMode === "circling") {
      const radius = 0.34 + ((bird.seed >>> 6) % 55) / 1000;
      const angle = (now / 1000) * (0.055 + bird.speed * 6) + (bird.seed % 6283) / 1000;
      target = { x: 0.5 + Math.cos(angle) * radius, z: 0.5 + Math.sin(angle) * radius };
    }
    const duration = 3_400;
    bird.state = {
      ...bird.state,
      mode: nextMode,
      targetAnchor: anchorIndex,
      transitionFrom: { x: bird.x, z: bird.z },
      transitionTo: target,
      transitionStartedAt: now,
      transitionEndsAt: now + duration,
    };
    bird.updatedAt = now;
    this.activateNature(this.natureEvent("bird_transition", { x: bird.x, z: bird.z }, now, duration, [bird.id], 0.55, { x: bird.x, z: bird.z }, target), true);
  }

  private maybeStartSoulPredation(now: number, seed: number): void {
    if (now - this.lastSoulPredationAt < SOUL_PREDATION_COOLDOWN_MS) return;
    const random = mulberry32(seed ^ 0x74a6c9d1);
    if (random() > 0.012) return;
    const connectedSouls = new Set([...this.sessions.values()].map((session) => session.soulId));
    const prey = [...this.entities.values()]
      .filter((entity) => entity.soulId !== null && connectedSouls.has(entity.soulId) && canBePredated(entity, now))
      .sort((a, b) => a.id.localeCompare(b.id))[seed % Math.max(1, connectedSouls.size)];
    const predators = [...this.entities.values()].filter((entity) => entity.kind === "wildFish" && entity.size >= 0.95);
    const predator = predators[seed % Math.max(1, predators.length)];
    if (!prey || !predator) return;
    const event = this.natureEvent("predator_warning", { x: prey.x, z: prey.z }, now, 8_000, [predator.id, prey.id], 0.75);
    this.activateNature(event, true);
    this.scheduleNature("soul_predation_resolve", event.endsAt, { preyId: prey.id, predatorId: predator.id });
    this.lastSoulPredationAt = now;
    this.writeMeta("last_soul_predation_at", now);
  }

  private maybeStartMicroEvent(now: number): void {
    if (now < this.nextMicroAt) return;
    const seed = hashString32(`micro:${Math.floor(now / 1000)}:${this.sequence}`);
    const point = clampNormalizedPoint({
      x: 0.18 + ((seed >>> 8) % 640) / 1000,
      z: 0.18 + ((seed >>> 18) % 640) / 1000,
    }, 0.08);
    const orbitPhase = orbitPhaseAt(now, this.orbitEpoch);
    const daylight = Math.max(0, Math.sin(orbitPhase * Math.PI * 2));
    let choice = seed % 9;
    if (choice === 5 && daylight < 0.18) choice = 6;
    if (choice === 0) {
      const fish = this.selectEntity("wildFish", seed);
      if (fish) this.activateNature(this.natureEvent("fish_glint", { x: fish.x, z: fish.z }, now, 4_500, [fish.id], 0.5), true);
    } else if (choice === 1) {
      const frog = this.selectEntity("frog", seed);
      if (frog) this.activateNature(this.natureEvent("frog_call", { x: frog.x, z: frog.z }, now, 2_200, [frog.id], 0.52), true);
    } else if (choice === 2) {
      this.beginFrogFeed(now, seed);
    } else if (choice === 3) {
      this.transitionFrog(now, seed);
    } else if (choice === 4) {
      this.transitionBird(now, seed);
    } else if (choice === 5) {
      const from = { x: 0.08, z: point.z };
      const to = { x: 0.92, z: 1 - point.z };
      this.activateNature(this.natureEvent("dragonfly_pass", point, now, 7_000, [], 0.5, from, to), true);
    } else if (choice === 6) {
      this.activateNature(this.natureEvent("reed_gust", point, now, 4_500, [], 0.45), true);
    } else if (choice === 7) {
      const lily = this.selectEntity("lily", seed);
      if (lily) this.activateNature(this.natureEvent("lily_movement", { x: lily.x, z: lily.z }, now, 4_000, [lily.id], 0.5), true);
    } else {
      this.activateNature(this.natureEvent("water_disturbance", point, now, 4_000, [], 0.45), true);
    }
    this.maybeStartSoulPredation(now, seed);
    this.nextMicroAt = this.nextNatureTime("micro", now, MICRO_EVENT_MIN_MS, MICRO_EVENT_MAX_MS);
    this.writeMeta("next_micro_at", this.nextMicroAt);
  }

  private maybeStartBirdHunt(now: number): void {
    if (now < this.nextBirdHuntAt) return;
    const seed = hashString32(`bird-hunt:${Math.floor(now / 1000)}:${this.sequence}`);
    const random = mulberry32(seed);
    const frogs = [...this.entities.values()].filter((entity) => entity.kind === "frog").sort((a, b) => a.id.localeCompare(b.id));
    const wildFish = [...this.entities.values()].filter((entity) => entity.kind === "wildFish").sort((a, b) => a.id.localeCompare(b.id));
    const mayTakeFrog = frogs.length > 1 && now - this.lastFrogHuntAt >= FROG_HUNT_COOLDOWN_MS && random() < 0.08;
    const target = mayTakeFrog ? frogs[seed % frogs.length] : wildFish[seed % Math.max(1, wildFish.length)];
    const birds = [...this.entities.values()].filter((entity) => entity.kind === "bird").sort((a, b) => a.id.localeCompare(b.id));
    if (target && birds.length > 0) {
      const event = this.natureEvent("bird_hunt", { x: target.x, z: target.z }, now, 8_000, [...birds.map((bird) => bird.id), target.id], 0.9);
      this.activateNature(event, true);
      this.scheduleNature("bird_hunt_resolve", event.endsAt, { targetId: target.id });
    }
    this.nextBirdHuntAt = this.nextNatureTime("hunt", now, BIRD_HUNT_MIN_MS, BIRD_HUNT_MAX_MS);
    this.writeMeta("next_bird_hunt_at", this.nextBirdHuntAt);
  }

  private recoverWildFish(now: number): void {
    const count = [...this.entities.values()].filter((entity) => entity.kind === "wildFish").length;
    if (count >= WILD_FISH_TARGET) return;
    let index = 0;
    while (this.entities.has(`wild_wildFish_${index}`) && index < WILD_FISH_TARGET) index++;
    const fish = createWildEntity("wildFish", index, now);
    fish.state = { source: "recovery" };
    this.entities.set(fish.id, fish);
    this.persistEntity(fish);
  }

  private recoverFrog(now: number): void {
    const count = [...this.entities.values()].filter((entity) => entity.kind === "frog").length;
    if (count >= FROG_TARGET) return;
    let index = 0;
    while (this.entities.has(`wild_frog_${index}`) && index < FROG_TARGET) index++;
    const frog = createWildEntity("frog", index, now);
    frog.state = { ...frog.state, source: "recovery", growthScale: 1, feedCount: 0 };
    this.entities.set(frog.id, frog);
    this.persistEntity(frog);
  }

  private processScheduledNature(now: number): Array<{ entity: SimEntity; message: ServerMessage | null }> {
    const completedLives: Array<{ entity: SimEntity; message: ServerMessage | null }> = [];
    const due = this.ctx.storage.sql.exec<ScheduledEventRow>(
      "SELECT id, event_kind, due_at, payload_json FROM scheduled_events WHERE completed_at IS NULL AND due_at <= ? ORDER BY due_at LIMIT 64",
      now,
    ).toArray();
    for (const row of due) {
      this.ctx.storage.sql.exec("UPDATE scheduled_events SET completed_at = ? WHERE id = ? AND completed_at IS NULL", now, row.id);
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(row.payload_json) as Record<string, unknown>; }
      catch { payload = {}; }
      if (row.event_kind === "nature_visible") {
        const event = payload as unknown as NatureEvent;
        if (event.id) this.activeNatureEvents.delete(event.id);
      } else if (row.event_kind === "frog_feed_resolve") {
        const frog = this.entities.get(String(payload.frogId ?? ""));
        if (frog?.kind === "frog") {
          const fed = applyFrogFeed(
            frog,
            now,
            (payload.previousMode as EntityState["state"]["mode"]) ?? "floating",
            Number(payload.targetAnchor ?? frog.state.targetAnchor ?? 0),
          );
          this.entities.set(fed.id, fed);
          this.persistEntity(fed);
        }
      } else if (row.event_kind === "bird_hunt_resolve") {
        const target = this.entities.get(String(payload.targetId ?? ""));
        if (target?.kind === "frog") {
          const frogs = [...this.entities.values()].filter((entity) => entity.kind === "frog");
          if (frogs.length > 1 && now - this.lastFrogHuntAt >= FROG_HUNT_COOLDOWN_MS) {
            this.removeWildEntity(target.id);
            this.lastFrogHuntAt = now;
            this.writeMeta("last_frog_hunt_at", now);
            this.scheduleNature("frog_recover", now + FROG_RECOVERY_MS, {});
          }
        } else if (target?.kind === "wildFish") {
          this.removeWildEntity(target.id);
          const delay = this.nextNatureTime(`fish-recovery:${target.id}`, now, 30 * 60 * 1000, 90 * 60 * 1000) - now;
          this.scheduleNature("wild_recover", now + delay, {});
        }
      } else if (row.event_kind === "wild_recover") {
        this.recoverWildFish(now);
      } else if (row.event_kind === "frog_recover") {
        this.recoverFrog(now);
      } else if (row.event_kind === "soul_predation_resolve") {
        const prey = this.entities.get(String(payload.preyId ?? ""));
        const connected = prey?.soulId && [...this.sessions.values()].some((session) => session.soulId === prey.soulId);
        if (prey && connected && canBePredated(prey, now)) completedLives.push({ entity: prey, message: this.completeLife(prey, now) });
      } else if (row.event_kind === "lily_remove") {
        const lily = this.entities.get(String(payload.entityId ?? ""));
        if (lily?.kind === "lily" && lily.state.source !== "baseline") this.removeWildEntity(lily.id);
      }
    }
    return completedLives;
  }

  async disconnectSoul(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    const queueIndex = this.queue.findIndex((entry) => entry.sessionId === sessionId);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
    const hasAnotherSession = [...this.sessions.values()].some((candidate) => candidate.soulId === session.soulId);
    if (!hasAnotherSession) {
      const entity = this.findSoulEntity(session.soulId);
      if (entity) {
        entity.foreground = false;
        entity.updatedAt = Date.now();
        this.persistEntity(entity);
        this.pendingRituals.push(this.ritual("departure", { x: entity.x, z: entity.z }, session.soulId, Date.now(), 0.2));
      }
    }
    this.rebuildGatewaySet();
    await this.processQueue();
    if (this.sessions.size === 0) await this.sleepWorld();
  }

  private rebuildGatewaySet(): void {
    this.activeGatewayShards.clear();
    for (const session of this.sessions.values()) this.activeGatewayShards.add(session.gatewayShard);
  }

  private startSimulation(): void {
    if (this.timer !== null) return;
    this.lastTickAt = Date.now();
    this.timer = setInterval(() => {
      if (this.tickRunning) return;
      this.tickRunning = true;
      this.ctx.waitUntil(this.runTick().finally(() => { this.tickRunning = false; }));
    }, 100);
  }

  private async runTick(): Promise<void> {
    const now = Date.now();
    const dtSeconds = Math.max(0.05, Math.min(0.25, (now - this.lastTickAt) / 1000));
    this.lastTickAt = now;
    this.sequence++;
    this.ecologicalEnergy *= 0.9994;
    const completed: Array<{ entity: SimEntity; message: ServerMessage | null }> = [];

    for (const [id, event] of this.activeNatureEvents) if (event.endsAt <= now) this.activeNatureEvents.delete(id);
    completed.push(...this.processScheduledNature(now));
    this.maybeStartMicroEvent(now);
    this.maybeStartBirdHunt(now);

    const advanced: SimEntity[] = [];
    for (const entity of this.entities.values()) {
      if (entity.soulId && !entity.foreground) continue;
      advanced.push(advanceEntity(entity, this.sequence, dtSeconds, now));
    }

    for (const next of applySchooling(advanced, this.sequence, dtSeconds, now)) {
      this.entities.set(next.id, next);
      if (isNaturalLifeComplete(next, now)) completed.push({ entity: next, message: this.completeLife(next, now) });
      if (next.kind === "legendaryPenguin" && next.endsAt !== null && next.endsAt <= now) this.removeWildEntity(next.id);
    }

    await this.deliverLifeEndings(completed);
    this.maybeCreateLegendary(now);

    if (this.sequence % 2 === 0) await this.broadcastDelta(now);
    if (now - this.lastPresenceAt >= 1000) {
      this.lastPresenceAt = now;
      await this.broadcastPresence(now);
    }
    if (now - this.lastCheckpointAt >= CHECKPOINT_INTERVAL_MS) this.checkpoint();
  }

  private completeLife(entity: SimEntity, now: number): ServerMessage | null {
    if (!entity.lifeId || !entity.soulId || entity.lifeKind !== "mortal") {
      this.removeWildEntity(entity.id);
      return null;
    }
    const life = this.ctx.storage.sql.exec<{
      started_at: number;
      ended_at: number | null;
    }>("SELECT started_at, ended_at FROM lives WHERE id = ?", entity.lifeId).toArray()[0];
    if (!life || life.ended_at !== null) return null;
    const soul = this.ctx.storage.sql.exec<SoulRow>(
      "SELECT id, poetic_name, tint, completed_lives FROM souls WHERE id = ?",
      entity.soulId,
    ).one();
    const record = poeticAge(life.started_at, now);
    const memoryId = crypto.randomUUID();
    this.ctx.storage.sql.exec("UPDATE lives SET ended_at = ?, poetic_record = ? WHERE id = ? AND ended_at IS NULL", now, record, entity.lifeId);
    this.ctx.storage.sql.exec("UPDATE souls SET completed_lives = completed_lives + 1 WHERE id = ?", entity.soulId);
    this.ctx.storage.sql.exec(
      "INSERT INTO memories(id, soul_id, life_id, display_name, tint, life_kind, completed_at) VALUES (?, ?, ?, ?, ?, 'mortal', ?)",
      memoryId, entity.soulId, entity.lifeId, soul.poetic_name, soul.tint, now,
    );
    this.ctx.storage.sql.exec("DELETE FROM entities WHERE id = ?", entity.id);
    this.entities.delete(entity.id);
    this.removedSinceDelta.add(entity.id);
    for (const session of this.sessions.values()) if (session.entityId === entity.id) session.entityId = null;
    this.track("death");
    return {
      v: PROTOCOL_VERSION,
      type: "lifeEnded",
      requestId: `life_${this.sequence}_${entity.id.slice(0, 8)}`,
      lifeId: entity.lifeId,
      entityId: entity.id,
      completedAt: now,
      ageText: record,
      memoryId,
    };
  }

  private removeWildEntity(entityId: string): void {
    if (!this.entities.has(entityId)) return;
    this.entities.delete(entityId);
    this.ctx.storage.sql.exec("DELETE FROM entities WHERE id = ?", entityId);
    this.removedSinceDelta.add(entityId);
  }

  private async deliverLifeEndings(completed: Array<{ entity: SimEntity; message: ServerMessage | null }>): Promise<void> {
    for (const { entity, message } of completed) {
      if (!message || !entity.soulId) continue;
      const sessions = [...this.sessions.values()].filter((session) => session.soulId === entity.soulId);
      await Promise.all(sessions.map((session) => this.gateway(session.gatewayShard).deliverToSession(session.sessionId, [message])));
    }
    if (completed.length > 0) await this.processQueue();
  }

  private maybeCreateLegendary(now: number): void {
    if (now - this.lastLegendaryAt < LEGENDARY_COOLDOWN_MS) return;
    if ([...this.entities.values()].some((entity) => entity.kind === "legendaryPenguin")) return;
    const wildCount = [...this.entities.values()].filter((entity) => entity.kind === "wildFish").length;
    const ecologicalSignal = Math.min(1, wildCount / 24 * 0.65 + this.ecologicalEnergy * 0.35);
    if (!isLegendaryWindow(orbitPhaseAt(now, this.orbitEpoch), ecologicalSignal)) return;
    const legendary = createWildEntity("legendaryPenguin", Math.floor(now / 1000), now);
    legendary.id = `legendary_${now}`;
    legendary.seed = hashString32(legendary.id);
    this.entities.set(legendary.id, legendary);
    this.persistEntity(legendary);
    this.lastLegendaryAt = now;
    this.writeMeta("last_legendary_at", now);
    this.ecologicalEnergy *= 0.35;
    this.track("legendary_appearance");
  }

  private gateway(shard: number) {
    return this.env.POND_GATEWAY.getByName(`v2-gateway-${shard}`);
  }

  private async broadcastDelta(now: number): Promise<void> {
    if (this.activeGatewayShards.size === 0) return;
    const current = new Map(this.wireEntities(now).map((entity) => [entity.id, entityForWire(entity)]));
    const upserts: EntityState[] = [];
    const motions: EntityMotion[] = [];
    for (const [id, entity] of current) {
      if (!this.lastWireEntities.has(id)) upserts.push(entity);
      else motions.push({
        id,
        x: entity.x,
        z: entity.z,
        depth: entity.depth,
        heading: entity.heading,
        size: entity.size,
        ageRatio: entity.ageRatio,
        state: entity.state,
      });
      this.lastWireEntities.set(id, entity);
    }
    const hiddenIds: string[] = [];
    for (const id of [...this.lastWireEntities.keys()]) {
      if (current.has(id) || this.removedSinceDelta.has(id)) continue;
      hiddenIds.push(id);
      this.lastWireEntities.delete(id);
    }
    for (const id of this.removedSinceDelta) this.lastWireEntities.delete(id);
    const ripples = [...this.pendingRippleCells.values()]
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 48);
    this.pendingRippleCells.clear();
    const message: ServerMessage = {
      v: PROTOCOL_VERSION,
      type: "delta",
      requestId: `delta_${this.sequence}`,
      serverTime: now,
      sequence: this.sequence,
      upserts,
      motions,
      backgroundCohorts: this.getBackgroundCohorts(),
      hiddenIds,
      removedIds: [...this.removedSinceDelta],
      rituals: [...this.pendingRituals.splice(0), ...ripples],
      natureEvents: [...this.activeNatureEvents.values()].filter((event) => event.endsAt > now),
      orbitPhase: orbitPhaseAt(now, this.orbitEpoch),
    };
    this.removedSinceDelta.clear();
    await Promise.all([...this.activeGatewayShards].map((shard) => this.gateway(shard).broadcastMessage(message)));
  }

  private async broadcastPresence(_now: number): Promise<void> {
    if (this.activeGatewayShards.size === 0) return;
    const message: ServerMessage = {
      v: PROTOCOL_VERSION,
      type: "presence",
      requestId: `presence_${this.sequence}`,
      connectedSouls: this.connectedSoulCount(),
      capacity: this.capacity(),
    };
    await Promise.all([...this.activeGatewayShards].map((shard) => this.gateway(shard).broadcastMessage(message)));
  }

  private async processQueue(): Promise<void> {
    while (this.foregroundSoulCount() < this.capacityLimit && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry) break;
      const session = this.sessions.get(entry.sessionId);
      if (!session || session.renderer === "canvas") continue;
      const existing = this.findSoulEntity(entry.soulId);
      if (existing) {
        existing.foreground = true;
        existing.updatedAt = Date.now();
        session.entityId = existing.id;
        this.persistEntity(existing);
      } else {
        const born = this.birthSoulFish(session, entry.point, Date.now());
        this.pendingRituals.push(this.ritual("birth", { x: born.x, z: born.z }, entry.soulId, Date.now(), 0.8));
      }
      await this.gateway(entry.gatewayShard).deliverToSession(entry.sessionId, [{
        v: PROTOCOL_VERSION,
        type: "snapshot",
        requestId: entry.requestId,
        snapshot: this.snapshot(),
      }]);
    }
    await Promise.all(this.queue.map((entry) => this.gateway(entry.gatewayShard).deliverToSession(entry.sessionId, [this.queueMessage(entry, entry.requestId)])));
  }

  private checkpoint(): void {
    for (const entity of this.entities.values()) this.persistEntity(entity);
    this.writeMeta("sequence", this.sequence);
    this.writeMeta("last_tick_at", this.lastTickAt);
    this.writeMeta("next_micro_at", this.nextMicroAt);
    this.writeMeta("next_bird_hunt_at", this.nextBirdHuntAt);
    this.writeMeta("last_frog_hunt_at", this.lastFrogHuntAt);
    this.writeMeta("last_soul_predation_at", this.lastSoulPredationAt);
    this.rebuildBackgroundCohorts();
    this.lastCheckpointAt = Date.now();
  }

  private rebuildBackgroundCohorts(): void {
    const cohorts = this.getBackgroundCohorts();
    this.ctx.storage.sql.exec("DELETE FROM background_cohorts");
    for (const school of cohorts) {
      this.ctx.storage.sql.exec(
        "INSERT INTO background_cohorts(id, kind, count, seed, state_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        school.id, school.kind, school.populationCount, school.seed, JSON.stringify({ x: school.x, z: school.z, tint: school.tint }), Date.now(),
      );
    }
  }

  private async sleepWorld(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.checkpoint();
    const now = Date.now();
    const nextLifeEnd = [...this.entities.values()]
      .map((entity) => entity.endsAt)
      .filter((value): value is number => value !== null && value > now)
      .sort((a, b) => a - b)[0];
    const nextScheduled = this.ctx.storage.sql.exec<{ due_at: number }>(
      "SELECT due_at FROM scheduled_events WHERE completed_at IS NULL AND due_at > ? ORDER BY due_at LIMIT 1",
      now,
    ).toArray()[0]?.due_at;
    const alarmAt = Math.min(nextLifeEnd ?? Number.MAX_SAFE_INTEGER, nextScheduled ?? Number.MAX_SAFE_INTEGER, now + 6 * 60 * 60 * 1000);
    await this.ctx.storage.setAlarm(Math.max(now + 60_000, alarmAt));
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const completed: Array<{ entity: SimEntity; message: ServerMessage | null }> = [];
    completed.push(...this.processScheduledNature(now));
    for (const [id, entity] of this.entities) {
      const next = fastForwardEntity(entity, now);
      this.entities.set(id, next);
      if (isNaturalLifeComplete(next, now)) completed.push({ entity: next, message: this.completeLife(next, now) });
      if (next.kind === "legendaryPenguin" && next.endsAt !== null && next.endsAt <= now) this.removeWildEntity(next.id);
    }
    await this.deliverLifeEndings(completed);
    this.lastTickAt = now;
    this.checkpoint();
    if (this.sessions.size === 0) await this.sleepWorld();
  }

  private track(event: string, quality = 0): void {
    const day = new Date().toISOString().slice(0, 10);
    this.ctx.storage.sql.exec(`
      INSERT INTO analytics_daily(day, event, count, quality_sum) VALUES (?, ?, 1, ?)
      ON CONFLICT(day, event) DO UPDATE SET count = count + 1, quality_sum = quality_sum + excluded.quality_sum
    `, day, event, quality);
  }

  async getPublicStatus(): Promise<PublicPondStatus> {
    const npcs = [...this.entities.values()].filter((entity) => entity.soulId === null);
    const cohorts = this.getBackgroundCohorts();
    return {
      world: CORE_NAME,
      protocol: PROTOCOL_VERSION,
      sequence: this.sequence,
      serverTime: Date.now(),
      capacity: this.capacity(),
      orbit: this.orbit(Date.now()),
      foundingRipples: this.foundingRipples,
      ecology: {
        canonicalNpcs: npcs.length,
        detailedNpcs: this.wireEntities(Date.now()).filter((entity) => entity.soulId === null).length,
        backgroundCohorts: cohorts.length,
      },
    };
  }

}
