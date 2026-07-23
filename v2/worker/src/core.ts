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
  type CurrentLifeSummary,
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
  startBirdTakeoff,
  type SimEntity,
} from "./simulation";
import { insertReturningFirstFifo } from "./queue";
import { GROWTH_SCHEMA_VERSION, installGrowthSchema } from "./growth-schema";
import {
  addUtcDays,
  approximateLifeAge,
  deterministicMemorialPoint,
  fraction,
  isPublicSlug,
  normalizeDedication,
  publicSlugBase,
  remainingPassage,
  utcDay,
  utcDayStart,
  GROWTH_DAY_MS,
} from "./growth-utils";
import {
  decryptText,
  encryptText,
  keyedEmailHash,
  maskEmail,
  normalizeEmail,
  randomToken,
  sha256Hex,
} from "./crypto";
import { emailConfigured, escapeHtml, sendPondEmail } from "./email";
import { keeperBillingConfigured } from "./billing";
import type {
  KeeperCheckoutPreparation,
  KeeperPortalPreparation,
  KeeperSummary,
  LetterPreferenceSummary,
  LinkInspection,
  LinkRedemption,
  NormalizedStripeEvent,
  PublicSoulView,
  RetentionCohort,
  RetentionReport,
  SharingSummary,
} from "./growth-types";

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

interface LetterPreferenceRow {
  [key: string]: SqlStorageValue;
  soul_id: string;
  email_ciphertext: string | null;
  email_iv: string | null;
  email_hash: string | null;
  email_masked: string | null;
  encryption_version: number;
  status: "pending" | "confirmed" | "unsubscribed" | "suppressed";
  consent_version: number;
  mortal_letters_enabled: number;
  keeper_letters_enabled: number;
  requested_at: number;
  confirmed_at: number | null;
  unsubscribed_at: number | null;
  last_confirmation_sent_at: number | null;
}

interface EmailDeliveryRow {
  [key: string]: SqlStorageValue;
  id: string;
  dedupe_key: string;
  soul_id: string;
  delivery_kind: "confirmation" | "mortal_death" | "keeper_weekly";
  life_id: string | null;
  membership_id: string | null;
  status: string;
  due_at: number;
  provider_id: string | null;
  email_hash: string | null;
  consent_version: number | null;
}

interface SessionRecord {
  sessionId: string;
  soulId: string;
  gatewayShard: number;
  renderer: RendererKind;
  reducedMotion: boolean;
  entityId: string | null;
  connectedAt: number;
  observedSoulId: string | null;
  observedSlug: string | null;
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
  visitId?: string;
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

const SCHEMA_VERSION = GROWTH_SCHEMA_VERSION;
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
    installGrowthSchema(sql, current, Date.now());
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
    this.ctx.storage.sql.exec(
      "UPDATE email_deliveries SET status = 'unknown', failure_code = 'ambiguous_restart' WHERE status = 'sending'",
    );
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
    if (generation >= 5) return;

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
          const moved = advanceEntity(entity, this.sequence, 0, now);
          entity.x = moved.x;
          entity.z = moved.z;
          entity.heading = moved.heading;
          entity.state = moved.state;
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
    this.writeMeta("ecology_generation", 5);
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
    return this.ctx.storage.sql.exec<SoulRow>(`
      SELECT souls.id, souls.poetic_name, souls.tint, souls.completed_lives, souls.last_seen_at
      FROM soul_credentials
      JOIN souls ON souls.id = soul_credentials.soul_id
      WHERE soul_credentials.token_hash = ? AND soul_credentials.revoked_at IS NULL
      LIMIT 1
    `, tokenHash).toArray()[0] ?? null;
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
    this.ctx.storage.sql.exec(
      "INSERT INTO soul_credentials(id, soul_id, token_hash, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)",
      crypto.randomUUID(), id, tokenHash, now, now,
    );
    this.recordSoulEvent(id, "credential_created", now);
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
        if (entity.foreground || entity.memorialPhase === "dome") continue;
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
        AND memories.life_kind = 'mortal' AND lives.ended_at IS NOT NULL
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
      if (entity.soulId) {
        if (entity.memorialPhase === "dome") return false;
        return entity.foreground;
      }
      if (entity.kind === "wildFish") return visibleWild.has(entity.id);
      return true;
    });
  }

  private currentLifeSummary(soulId: string): CurrentLifeSummary | null {
    const entity = this.findSoulEntity(soulId);
    if (!entity?.lifeId || !entity.label || entity.bornAt === null) return null;
    return {
      lifeId: entity.lifeId,
      entityId: entity.id,
      name: entity.label,
      lifeKind: entity.lifeKind === "memorial" ? "eternal" : "mortal",
      status: entity.memorialPhase === "dome" ? "resting" : "living",
      bornAt: entity.bornAt,
      endsAt: entity.endsAt,
      memorialPhase: entity.memorialPhase ?? undefined,
    };
  }

  private sharingSummary(soulId: string): SharingSummary {
    const row = this.ctx.storage.sql.exec<{ slug: string; disabled_at: number | null }>(
      "SELECT slug, disabled_at FROM public_souls WHERE soul_id = ?",
      soulId,
    ).toArray()[0];
    if (!row || row.disabled_at !== null) return { enabled: false };
    const origin = String(this.env.PUBLIC_APP_ORIGIN || "").replace(/\/$/u, "");
    return {
      enabled: true,
      slug: row.slug,
      url: origin ? `${origin}/s/${row.slug}` : `/s/${row.slug}`,
    };
  }

  private letterPreferenceSummary(soulId: string): LetterPreferenceSummary {
    const row = this.ctx.storage.sql.exec<{
      status: LetterPreferenceSummary["status"];
      email_masked: string | null;
      mortal_letters_enabled: number;
      keeper_letters_enabled: number;
    }>(`
      SELECT status, email_masked, mortal_letters_enabled, keeper_letters_enabled
      FROM pond_letter_preferences WHERE soul_id = ?
    `, soulId).toArray()[0];
    return {
      available: emailConfigured(this.env) && Boolean(this.env.EMAIL_ENCRYPTION_KEY),
      status: row?.status ?? "none",
      maskedEmail: row?.email_masked ?? undefined,
      mortalLetters: row?.mortal_letters_enabled === 1,
      keeperLetters: row?.keeper_letters_enabled === 1,
    };
  }

  private keeperEligible(soulId: string): boolean {
    const soul = this.ctx.storage.sql.exec<{ completed_lives: number }>(
      "SELECT completed_lives FROM souls WHERE id = ?",
      soulId,
    ).toArray()[0];
    if ((soul?.completed_lives ?? 0) > 0) return true;
    const distinctVisitDays = this.ctx.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM soul_visits WHERE soul_id = ?",
      soulId,
    ).one().count;
    return distinctVisitDays >= 2;
  }

  private keeperSummary(soulId: string, configured = keeperBillingConfigured(this.env)): KeeperSummary {
    const now = Date.now();
    const preference = this.letterPreferenceSummary(soulId);
    const row = this.ctx.storage.sql.exec<{
      stripe_status: string | null;
      billing_interval: "month" | "year" | null;
      cancel_at_period_end: number;
      paid_through_at: number | null;
      activated_at: number | null;
      rested_at: number | null;
      dedication: string | null;
      weekly_letters_enabled: number;
    }>(`
      SELECT stripe_status, billing_interval, cancel_at_period_end, paid_through_at,
        activated_at, rested_at, dedication, weekly_letters_enabled
      FROM keeper_memberships WHERE soul_id = ?
    `, soulId).toArray()[0];
    const eligible = this.keeperEligible(soulId);
    let state: KeeperSummary["state"] = eligible ? "eligible" : "none";
    if (row) {
      const paid = row.paid_through_at !== null && row.paid_through_at > now;
      const checkoutPending = row.activated_at === null && this.ctx.storage.sql.exec<{ count: number }>(`
        SELECT COUNT(*) AS count FROM keeper_checkout_attempts
        WHERE membership_id = (SELECT id FROM keeper_memberships WHERE soul_id = ?)
          AND state IN ('pending', 'created') AND expires_at > ?
      `, soulId, now).one().count > 0;
      if (row.activated_at === null) state = checkoutPending ? "pending" : eligible ? "eligible" : "none";
      else if (row.rested_at !== null && !paid) state = "resting";
      else if (row.stripe_status === "past_due" && paid) state = "past_due";
      else if ((row.cancel_at_period_end === 1 || row.stripe_status === "canceled") && paid) state = "canceling";
      else if (paid) state = "active";
      else state = "resting";
    }
    const entity = this.findSoulEntity(soulId);
    return {
      // A disabled billing flag must hide acquisition without erasing an
      // already-activated Keeper's state and recovery controls.
      configured: configured || row?.activated_at != null,
      eligible,
      requiresConfirmedEmail: preference.status !== "confirmed",
      state,
      interval: row?.billing_interval ?? undefined,
      paidThroughAt: row?.paid_through_at ?? undefined,
      fishPhase: entity?.lifeKind === "memorial" ? (entity.memorialPhase ?? "water") : undefined,
      dedication: row?.dedication ?? undefined,
      weeklyLetters: row?.weekly_letters_enabled === 1 && preference.keeperLetters,
    };
  }

  private recordVisit(soulId: string, now: number): void {
    this.ctx.storage.sql.exec(`
      INSERT INTO soul_visits(soul_id, day, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(soul_id, day) DO UPDATE SET last_seen_at = MAX(last_seen_at, excluded.last_seen_at)
    `, soulId, utcDay(now), now, now);
  }

  private recordPageVisit(soulId: string, visitId: string, now: number, countVisit: boolean): boolean {
    const inserted = this.ctx.storage.sql.exec(`
      INSERT OR IGNORE INTO soul_page_visits(soul_id, visit_id, day, first_seen_at, counted)
      VALUES (?, ?, ?, ?, ?)
      RETURNING visit_id
    `, soulId, visitId, utcDay(now), now, countVisit ? 1 : 0).toArray();
    if (inserted.length === 0 || !countVisit) return false;
    this.recordVisit(soulId, now);
    return true;
  }

  private recordSoulEvent(soulId: string, eventKind: string, eventAt: number, payload: Record<string, unknown> = {}): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO soul_events(id, soul_id, event_kind, event_at, payload_json) VALUES (?, ?, ?, ?, ?)",
      crypto.randomUUID(), soulId, eventKind, eventAt, JSON.stringify(payload),
    );
  }

  private getMemories(): DomeMemory[] {
    return this.ctx.storage.sql.exec<{
      id: string;
      soul_id: string | null;
      display_name: string;
      tint: number;
      completed_at: number;
      life_kind: "mortal" | "memorial";
      x: number | null;
      z: number | null;
    }>(`
      SELECT memories.id, memories.soul_id, memories.display_name, memories.tint,
        memories.completed_at, memories.life_kind, memories.x, memories.z
      FROM memories
      LEFT JOIN lives ON lives.id = memories.life_id
      WHERE memories.life_kind != 'memorial' OR lives.memorial_phase = 'dome'
      ORDER BY memories.completed_at DESC LIMIT 120
    `)
      .toArray()
      .map((row) => ({
        id: row.id,
        soulId: row.soul_id,
        name: row.display_name,
        tint: row.tint,
        completedAt: row.completed_at,
        lifeKind: row.life_kind,
        x: row.x ?? undefined,
        z: row.z ?? undefined,
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
    let presentedTokenHash: string | null = null;
    let returningConnection = false;
    let createdSoul = false;
    if (input.token && input.token.length >= 20 && input.token.length <= 256) {
      presentedTokenHash = await hashToken(input.token);
      soul = this.findSoulByTokenHash(presentedTokenHash);
    }
    if (!soul) {
      issuedToken = makeToken();
      soul = this.createSoul(await hashToken(issuedToken), now);
      createdSoul = true;
      this.track("new_soul");
    } else {
      const alreadyPresent = [...this.sessions.values()].some((session) => session.soulId === soul?.id);
      returningConnection = !alreadyPresent;
      if (!alreadyPresent) recentLifeRecord = this.recentLifeRecord(soul.id, soul.last_seen_at);
      if (presentedTokenHash) {
        this.ctx.storage.sql.exec(
          "UPDATE soul_credentials SET last_used_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
          now, presentedTokenHash,
        );
      }
    }

    let countedVisit = false;
    if (input.visitId) {
      countedVisit = this.recordPageVisit(soul.id, input.visitId, now, createdSoul || returningConnection);
    } else if (createdSoul) {
      this.recordVisit(soul.id, now);
      countedVisit = true;
    }
    if (!createdSoul && countedVisit) this.recordSoulEvent(soul.id, "authenticated_connection", now);

    const sessionId = crypto.randomUUID();
    const session: SessionRecord = {
      sessionId,
      soulId: soul.id,
      gatewayShard: input.gatewayShard,
      renderer: input.renderer,
      reducedMotion: input.reducedMotion,
      entityId: null,
      connectedAt: now,
      observedSoulId: null,
      observedSlug: null,
    };
    this.sessions.set(sessionId, session);
    this.activeGatewayShards.add(input.gatewayShard);
    const existingEntity = this.findSoulEntity(soul.id);
    const messages: ServerMessage[] = [];

    if (input.renderer === "canvas") {
      this.track("renderer_fallback");
    } else if (existingEntity?.lifeKind === "memorial" && existingEntity.memorialPhase === "dome") {
      this.track("return");
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
      ownedEntityId: session.entityId,
      renderer: input.renderer,
      recentLifeRecord,
      sharing: this.sharingSummary(soul.id),
      pondLetters: this.letterPreferenceSummary(soul.id),
      currentLife: this.currentLifeSummary(soul.id),
      keeper: this.keeperSummary(soul.id),
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
      const messages = await this.handleMessage(session, entry.message);
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

  private async handleMessage(session: SessionRecord, message: Exclude<ClientMessage, { type: "hello" }>): Promise<ServerMessage[]> {
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
      case "setSharing":
        return [this.handleSetSharing(session, message.requestId, message.enabled, now)];
      case "observePublicSoul":
        return [this.handleObservePublicSoul(session, message.requestId, message.slug)];
      case "leavePublicRipple":
        return [this.handlePublicRipple(session, message.requestId, message.slug, now)];
      case "setPondLetter":
        return [await this.handleSetPondLetter(session, message, now)];
      case "resendPondLetterConfirmation":
        return [await this.handleResendPondLetterConfirmation(session, message.requestId, now)];
      case "unsubscribePondLetters":
        return [this.handleUnsubscribePondLetters(session, message.requestId, now)];
      case "leave":
        this.ctx.waitUntil(this.disconnectSoul(session.sessionId));
        return [];
    }
  }

  private handleSetSharing(session: SessionRecord, requestId: string, enabled: boolean, now: number): ServerMessage {
    const existing = this.ctx.storage.sql.exec<{ slug: string }>(
      "SELECT slug FROM public_souls WHERE soul_id = ?",
      session.soulId,
    ).toArray()[0];
    if (enabled) {
      if (existing) {
        this.ctx.storage.sql.exec("UPDATE public_souls SET disabled_at = NULL WHERE soul_id = ?", session.soulId);
      } else {
        const soul = this.ctx.storage.sql.exec<{ poetic_name: string }>(
          "SELECT poetic_name FROM souls WHERE id = ?",
          session.soulId,
        ).one();
        const base = publicSlugBase(soul.poetic_name);
        let slug = base;
        for (let attempt = 0; attempt < 32; attempt++) {
          const collision = this.ctx.storage.sql.exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM public_souls WHERE slug = ? COLLATE NOCASE",
            slug,
          ).one().count;
          if (collision === 0) break;
          const suffix = hashString32(`${session.soulId}:${attempt}`).toString(36).slice(0, 6);
          slug = `${base.slice(0, Math.max(3, 63 - suffix.length - 1))}-${suffix}`;
        }
        this.ctx.storage.sql.exec(
          "INSERT INTO public_souls(soul_id, slug, enabled_at, disabled_at) VALUES (?, ?, ?, NULL)",
          session.soulId, slug, now,
        );
      }
      this.recordSoulEvent(session.soulId, "sharing_enabled", now);
    } else if (existing) {
      this.ctx.storage.sql.exec("UPDATE public_souls SET disabled_at = ? WHERE soul_id = ?", now, session.soulId);
      for (const observer of this.sessions.values()) {
        if (observer.observedSoulId !== session.soulId) continue;
        observer.observedSoulId = null;
        observer.observedSlug = null;
      }
      this.recordSoulEvent(session.soulId, "sharing_disabled", now);
    }
    return {
      v: PROTOCOL_VERSION,
      type: "sharingAck",
      requestId,
      accepted: true,
      sharing: this.sharingSummary(session.soulId),
    };
  }

  private handleObservePublicSoul(session: SessionRecord, requestId: string, slug: string): ServerMessage {
    const soul = this.publicSoulView(slug);
    session.observedSoulId = soul ? this.publicSoulId(slug) : null;
    session.observedSlug = soul ? slug : null;
    return { v: PROTOCOL_VERSION, type: "publicSoulContext", requestId, soul };
  }

  private handlePublicRipple(session: SessionRecord, requestId: string, slug: string, now: number): ServerMessage {
    const targetSoulId = session.observedSlug === slug ? session.observedSoulId : this.publicSoulId(slug);
    if (!targetSoulId || !this.publicSoulView(slug)) {
      return { v: PROTOCOL_VERSION, type: "ritualAck", requestId, accepted: false, reason: "invalid" };
    }
    const previousRipple = this.ctx.storage.sql.exec<{ last_at: number }>(`
      SELECT last_at FROM public_ripple_limits WHERE visitor_soul_id = ? AND slug = ? COLLATE NOCASE
    `, session.soulId, slug).toArray()[0]?.last_at;
    if (previousRipple !== undefined && now - previousRipple < 5 * 60 * 1000) {
      return {
        v: PROTOCOL_VERSION,
        type: "ritualAck",
        requestId,
        accepted: false,
        reason: "cooldown",
        nextOfferingAt: previousRipple + 5 * 60 * 1000,
      };
    }
    this.ctx.storage.sql.exec(`
      INSERT INTO public_ripple_limits(visitor_soul_id, slug, last_at) VALUES (?, ?, ?)
      ON CONFLICT(visitor_soul_id, slug) DO UPDATE SET last_at = excluded.last_at
    `, session.soulId, slug, now);
    const entity = this.findSoulEntity(targetSoulId);
    const memory = this.ctx.storage.sql.exec<{ x: number | null; z: number | null }>(`
      SELECT x, z FROM memories WHERE soul_id = ? ORDER BY completed_at DESC LIMIT 1
    `, targetSoulId).toArray()[0];
    const fallback = deterministicMemorialPoint(slug);
    const sampledPoint = clampNormalizedPoint({
      x: entity?.x ?? memory?.x ?? fallback.x,
      z: entity?.z ?? memory?.z ?? fallback.z,
    }, 0.08);
    this.pendingRituals.push(this.ritual("ripple", sampledPoint, null, now, 0.5));
    this.reactToRipple(sampledPoint, now);
    this.recordSoulEvent(targetSoulId, "public_ripple", now);
    this.recordSoulEvent(session.soulId, "public_ripple_left", now, { slug });
    return { v: PROTOCOL_VERSION, type: "ritualAck", requestId, accepted: true, sampledPoint };
  }

  private publicSoulId(slug: string): string | null {
    if (!isPublicSlug(slug)) return null;
    return this.ctx.storage.sql.exec<{ soul_id: string }>(
      "SELECT soul_id FROM public_souls WHERE slug = ? COLLATE NOCASE AND disabled_at IS NULL",
      slug,
    ).toArray()[0]?.soul_id ?? null;
  }

  private publicSoulView(slug: string): PublicSoulView | null {
    const row = this.ctx.storage.sql.exec<{
      soul_id: string;
      slug: string;
      poetic_name: string;
      tint: number;
      completed_lives: number;
      dedication: string | null;
    }>(`
      SELECT public_souls.soul_id, public_souls.slug, souls.poetic_name, souls.tint,
        souls.completed_lives,
        CASE WHEN keeper_memberships.activated_at IS NOT NULL THEN keeper_memberships.dedication END AS dedication
      FROM public_souls
      JOIN souls ON souls.id = public_souls.soul_id
      LEFT JOIN keeper_memberships ON keeper_memberships.soul_id = souls.id
      WHERE public_souls.slug = ? COLLATE NOCASE AND public_souls.disabled_at IS NULL
      LIMIT 1
    `, slug).toArray()[0];
    if (!row) return null;
    const now = Date.now();
    const entity = this.findSoulEntity(row.soul_id);
    const memory = this.ctx.storage.sql.exec<{
      completed_at: number;
      poetic_record: string | null;
      x: number | null;
      z: number | null;
    }>(`
      SELECT memories.completed_at, lives.poetic_record, memories.x, memories.z
      FROM memories JOIN lives ON lives.id = memories.life_id
      WHERE memories.soul_id = ? ORDER BY memories.completed_at DESC LIMIT 1
    `, row.soul_id).toArray()[0];
    const status: PublicSoulView["status"] = entity
      ? entity.memorialPhase === "dome" ? "resting" : "alive"
      : "remembered";
    const result: PublicSoulView = {
      slug: row.slug,
      name: row.poetic_name,
      tint: row.tint,
      status,
      completedLives: row.completed_lives,
      dedication: row.dedication ?? undefined,
    };
    if (entity && entity.memorialPhase !== "dome" && entity.bornAt !== null) {
      const point = clampNormalizedPoint({ x: entity.x, z: entity.z }, 0.04);
      result.currentLife = {
        kind: entity.lifeKind === "memorial" ? "eternal" : "mortal",
        ageText: approximateLifeAge(entity.bornAt, now),
        remainingPassageText: remainingPassage(entity.endsAt, now),
        presentation: {
          x: point.x,
          z: point.z,
          depth: Math.max(-0.5, Math.min(0.5, entity.depth)),
          heading: entity.heading,
          size: entity.size,
          ageRatio: entity.ageRatio,
        },
      };
    }
    if (memory) {
      const fallback = deterministicMemorialPoint(row.slug);
      result.latestMemorial = {
        ageText: memory.poetic_record ?? "one remembered passage",
        rippleAnchor: clampNormalizedPoint({
          x: memory.x ?? fallback.x,
          z: memory.z ?? fallback.z,
        }, 0.04),
      };
    } else if (status === "resting") {
      result.latestMemorial = {
        ageText: entity?.bornAt ? approximateLifeAge(entity.bornAt, now) : "an eternal passage",
        rippleAnchor: deterministicMemorialPoint(row.slug),
      };
    }
    return result;
  }

  private letterPreferenceRow(soulId: string): LetterPreferenceRow | null {
    return this.ctx.storage.sql.exec<LetterPreferenceRow>(
      "SELECT * FROM pond_letter_preferences WHERE soul_id = ?",
      soulId,
    ).toArray()[0] ?? null;
  }

  private reservePondLetterSend(soulId: string, emailHash: string, now: number, cooldownMs: number): boolean {
    return this.ctx.storage.sql.exec(`
      INSERT INTO pond_letter_send_limits(soul_id, email_hash, last_reserved_at) VALUES (?, ?, ?)
      ON CONFLICT(soul_id) DO UPDATE SET
        email_hash = excluded.email_hash,
        last_reserved_at = excluded.last_reserved_at
      WHERE pond_letter_send_limits.last_reserved_at <= ?
      RETURNING soul_id
    `, soulId, emailHash, now, now - cooldownMs).toArray().length > 0;
  }

  private async handleSetPondLetter(
    session: SessionRecord,
    message: Extract<ClientMessage, { type: "setPondLetter" }>,
    now: number,
  ): Promise<ServerMessage> {
    const requestedEmail = message.email === undefined ? null : normalizeEmail(message.email);
    if (message.email !== undefined && requestedEmail === null) {
      return {
        v: PROTOCOL_VERSION,
        type: "pondLetterAck",
        requestId: message.requestId,
        accepted: false,
        preference: this.letterPreferenceSummary(session.soulId),
        reason: "invalid_email",
      };
    }
    if ((!emailConfigured(this.env) || !this.env.EMAIL_ENCRYPTION_KEY) && message.email !== undefined) {
      return {
        v: PROTOCOL_VERSION,
        type: "pondLetterAck",
        requestId: message.requestId,
        accepted: false,
        preference: this.letterPreferenceSummary(session.soulId),
        reason: "not_configured",
      };
    }

    let confirmationSent = false;
    if (requestedEmail !== null) {
      const encryptionKey = this.env.EMAIL_ENCRYPTION_KEY;
      if (!encryptionKey) {
        return {
          v: PROTOCOL_VERSION,
          type: "pondLetterAck",
          requestId: message.requestId,
          accepted: false,
          preference: this.letterPreferenceSummary(session.soulId),
          reason: "not_configured",
        };
      }
      const emailHash = await keyedEmailHash(requestedEmail, encryptionKey);
      const latest = this.letterPreferenceRow(session.soulId);
      const sameConfirmedEmail = latest?.email_hash === emailHash && latest.status === "confirmed";
      const samePendingEmail = latest?.email_hash === emailHash && latest.status === "pending";
      const globallySuppressed = this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM email_suppressions WHERE email_hash = ?",
        emailHash,
      ).one().count > 0;
      if (globallySuppressed || latest?.email_hash === emailHash && latest.status === "suppressed") {
        return {
          v: PROTOCOL_VERSION,
          type: "pondLetterAck",
          requestId: message.requestId,
          accepted: false,
          preference: this.letterPreferenceSummary(session.soulId),
          reason: "suppressed",
        };
      }
      const emailOwner = this.ctx.storage.sql.exec<{ soul_id: string }>(`
        SELECT soul_id FROM pond_letter_preferences
        WHERE email_hash = ? AND status IN ('pending', 'confirmed') AND soul_id != ? LIMIT 1
      `, emailHash, session.soulId).toArray()[0];
      if (emailOwner) {
        return {
          v: PROTOCOL_VERSION,
          type: "pondLetterAck",
          requestId: message.requestId,
          accepted: false,
          preference: this.letterPreferenceSummary(session.soulId),
          reason: "email_unavailable",
        };
      }
      if (samePendingEmail) {
        return {
          v: PROTOCOL_VERSION,
          type: "pondLetterAck",
          requestId: message.requestId,
          accepted: false,
          preference: this.letterPreferenceSummary(session.soulId),
          reason: "rate_limited",
        };
      }
      if (!sameConfirmedEmail) {
        if (!this.reservePondLetterSend(session.soulId, emailHash, now, 60 * 1000)) {
          return {
            v: PROTOCOL_VERSION,
            type: "pondLetterAck",
            requestId: message.requestId,
            accepted: false,
            preference: this.letterPreferenceSummary(session.soulId),
            reason: "rate_limited",
          };
        }
        const encrypted = await encryptText(requestedEmail, encryptionKey);
        const beforeWrite = this.letterPreferenceRow(session.soulId);
        if (latest && (!beforeWrite
          || beforeWrite.consent_version !== latest.consent_version
          || beforeWrite.status !== latest.status
          || beforeWrite.email_hash !== latest.email_hash)) {
          return {
            v: PROTOCOL_VERSION,
            type: "pondLetterAck",
            requestId: message.requestId,
            accepted: false,
            preference: this.letterPreferenceSummary(session.soulId),
            reason: "rate_limited",
          };
        }
        const consentVersion = (beforeWrite?.consent_version ?? 0) + 1;
        const mortalLetters = message.mortalLetters === undefined
          ? beforeWrite?.mortal_letters_enabled ?? 1
          : message.mortalLetters ? 1 : 0;
        const keeperLetters = message.keeperLetters === undefined
          ? beforeWrite?.keeper_letters_enabled ?? 0
          : message.keeperLetters ? 1 : 0;
        try {
          this.ctx.storage.sql.exec(`
            INSERT INTO pond_letter_preferences(
              soul_id, email_ciphertext, email_iv, email_hash, email_masked, encryption_version,
              status, consent_version, mortal_letters_enabled, keeper_letters_enabled,
              requested_at, confirmed_at, unsubscribed_at, last_confirmation_sent_at
            ) VALUES (?, ?, ?, ?, ?, 1, 'pending', ?, ?, ?, ?, NULL, NULL, ?)
            ON CONFLICT(soul_id) DO UPDATE SET
              email_ciphertext = excluded.email_ciphertext,
              email_iv = excluded.email_iv,
              email_hash = excluded.email_hash,
              email_masked = excluded.email_masked,
              encryption_version = 1,
              status = 'pending',
              consent_version = excluded.consent_version,
              mortal_letters_enabled = excluded.mortal_letters_enabled,
              keeper_letters_enabled = excluded.keeper_letters_enabled,
              requested_at = excluded.requested_at,
              confirmed_at = NULL,
              unsubscribed_at = NULL,
              last_confirmation_sent_at = excluded.last_confirmation_sent_at
          `,
          session.soulId, encrypted.ciphertext, encrypted.iv, emailHash, maskEmail(requestedEmail), consentVersion,
          mortalLetters,
          keeperLetters,
          now, now);
        } catch {
          return {
            v: PROTOCOL_VERSION,
            type: "pondLetterAck",
            requestId: message.requestId,
            accepted: false,
            preference: this.letterPreferenceSummary(session.soulId),
            reason: "email_unavailable",
          };
        }
        this.ctx.storage.sql.exec(
          `UPDATE secure_link_claims SET consumed_at = ?
           WHERE soul_id = ? AND purpose IN ('confirm_email', 'unsubscribe') AND consumed_at IS NULL`,
          now, session.soulId,
        );
        const { token } = await this.createSecureClaim(session.soulId, "confirm_email", consentVersion, null, now + GROWTH_DAY_MS, now);
        const deliveryId = this.createEmailDelivery(
          `confirmation:${session.soulId}:${consentVersion}:${now}`,
          session.soulId,
          "confirmation",
          null,
          null,
          "pending",
          now,
        );
        confirmationSent = await this.sendEmailDelivery(deliveryId, token);
      }
    }

    const current = this.letterPreferenceRow(session.soulId);
    if (current && (message.mortalLetters !== undefined || message.keeperLetters !== undefined)) {
      this.ctx.storage.sql.exec(`
        UPDATE pond_letter_preferences SET
          mortal_letters_enabled = COALESCE(?, mortal_letters_enabled),
          keeper_letters_enabled = COALESCE(?, keeper_letters_enabled)
        WHERE soul_id = ?
      `,
      message.mortalLetters === undefined ? null : message.mortalLetters ? 1 : 0,
      message.keeperLetters === undefined ? null : message.keeperLetters ? 1 : 0,
      session.soulId);
      if (message.keeperLetters !== undefined) {
        this.ctx.storage.sql.exec(
          "UPDATE keeper_memberships SET weekly_letters_enabled = ?, updated_at = ? WHERE soul_id = ?",
          message.keeperLetters ? 1 : 0, now, session.soulId,
        );
      }
    }
    return {
      v: PROTOCOL_VERSION,
      type: "pondLetterAck",
      requestId: message.requestId,
      accepted: true,
      preference: this.letterPreferenceSummary(session.soulId),
      confirmationSent,
      reason: requestedEmail === null && !current ? "unchanged" : undefined,
    };
  }

  private async handleResendPondLetterConfirmation(session: SessionRecord, requestId: string, now: number): Promise<ServerMessage> {
    const preference = this.letterPreferenceRow(session.soulId);
    if (!preference || preference.status !== "pending" || !preference.email_ciphertext) {
      return {
        v: PROTOCOL_VERSION,
        type: "pondLetterAck",
        requestId,
        accepted: false,
        preference: this.letterPreferenceSummary(session.soulId),
        reason: "unchanged",
      };
    }
    if (!preference.email_hash
      || !this.reservePondLetterSend(session.soulId, preference.email_hash, now, 10 * 60 * 1000)) {
      return {
        v: PROTOCOL_VERSION,
        type: "pondLetterAck",
        requestId,
        accepted: false,
        preference: this.letterPreferenceSummary(session.soulId),
        reason: "rate_limited",
      };
    }
    this.ctx.storage.sql.exec(
      "UPDATE secure_link_claims SET consumed_at = ? WHERE soul_id = ? AND purpose = 'confirm_email' AND consumed_at IS NULL",
      now, session.soulId,
    );
    this.ctx.storage.sql.exec(
      "UPDATE pond_letter_preferences SET last_confirmation_sent_at = ? WHERE soul_id = ?",
      now, session.soulId,
    );
    const { token } = await this.createSecureClaim(
      session.soulId,
      "confirm_email",
      preference.consent_version,
      null,
      now + GROWTH_DAY_MS,
      now,
    );
    const deliveryId = this.createEmailDelivery(
      `confirmation:${session.soulId}:${preference.consent_version}:${now}`,
      session.soulId,
      "confirmation",
      null,
      null,
      "pending",
      now,
    );
    const confirmationSent = await this.sendEmailDelivery(deliveryId, token);
    return {
      v: PROTOCOL_VERSION,
      type: "pondLetterAck",
      requestId,
      accepted: true,
      preference: this.letterPreferenceSummary(session.soulId),
      confirmationSent,
    };
  }

  private handleUnsubscribePondLetters(session: SessionRecord, requestId: string, now: number): ServerMessage {
    const current = this.letterPreferenceRow(session.soulId);
    if (current) {
      this.ctx.storage.sql.exec(`
        UPDATE pond_letter_preferences SET status = 'unsubscribed', consent_version = consent_version + 1,
          mortal_letters_enabled = 0, keeper_letters_enabled = 0, unsubscribed_at = ?
        WHERE soul_id = ?
      `, now, session.soulId);
      this.ctx.storage.sql.exec(
        `UPDATE secure_link_claims SET consumed_at = ?
         WHERE soul_id = ? AND purpose IN ('confirm_email', 'unsubscribe') AND consumed_at IS NULL`,
        now, session.soulId,
      );
      this.ctx.storage.sql.exec(
        "UPDATE email_deliveries SET status = 'skipped', failure_code = 'unsubscribed' WHERE soul_id = ? AND status IN ('pending', 'waiting_confirmation')",
        session.soulId,
      );
      this.ctx.storage.sql.exec(
        "UPDATE keeper_memberships SET weekly_letters_enabled = 0, updated_at = ? WHERE soul_id = ?",
        now, session.soulId,
      );
    }
    return {
      v: PROTOCOL_VERSION,
      type: "pondLetterAck",
      requestId,
      accepted: Boolean(current),
      preference: this.letterPreferenceSummary(session.soulId),
      reason: current ? undefined : "unchanged",
    };
  }

  private async createSecureClaim(
    soulId: string,
    purpose: "confirm_email" | "return_soul" | "unsubscribe",
    consentVersion: number,
    lifeId: string | null,
    expiresAt: number | null,
    now: number,
  ): Promise<{ token: string; tokenHash: string }> {
    const token = randomToken();
    const tokenHash = await sha256Hex(token);
    this.ctx.storage.sql.exec(`
      INSERT INTO secure_link_claims(token_hash, soul_id, purpose, consent_version, life_id, expires_at, consumed_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    `, tokenHash, soulId, purpose, consentVersion, lifeId, expiresAt, now);
    return { token, tokenHash };
  }

  private createEmailDelivery(
    dedupeKey: string,
    soulId: string,
    kind: EmailDeliveryRow["delivery_kind"],
    lifeId: string | null,
    membershipId: string | null,
    status: string,
    now: number,
  ): string {
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(`
      INSERT OR IGNORE INTO email_deliveries(
        id, dedupe_key, soul_id, delivery_kind, life_id, membership_id, status, due_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, id, dedupeKey, soulId, kind, lifeId, membershipId, status, now, now);
    return this.ctx.storage.sql.exec<{ id: string }>(
      "SELECT id FROM email_deliveries WHERE dedupe_key = ?",
      dedupeKey,
    ).one().id;
  }

  private queueMortalLetter(soulId: string, lifeId: string, now: number): void {
    const preference = this.letterPreferenceRow(soulId);
    let status = "skipped";
    if (preference?.mortal_letters_enabled === 1) {
      if (preference.status === "confirmed") status = "pending";
      else if (preference.status === "pending") status = "waiting_confirmation";
      else if (preference.status === "suppressed") status = "suppressed";
    }
    this.createEmailDelivery(
      `mortal-death:${lifeId}`,
      soulId,
      "mortal_death",
      lifeId,
      null,
      status,
      now,
    );
  }

  private emailLink(soulId: string, claim: string): string {
    const origin = String(this.env.PUBLIC_APP_ORIGIN || "").replace(/\/$/u, "");
    const sharing = this.sharingSummary(soulId);
    const path = sharing.enabled && sharing.slug ? `/s/${sharing.slug}` : "/";
    return `${origin}${path}#pond=${encodeURIComponent(claim)}`;
  }

  private async sendEmailDelivery(deliveryId: string, existingPrimaryClaim?: string): Promise<boolean> {
    const encryptionKey = this.env.EMAIL_ENCRYPTION_KEY;
    if (!emailConfigured(this.env) || !encryptionKey) return false;
    const row = this.ctx.storage.sql.exec<EmailDeliveryRow>(
      "SELECT * FROM email_deliveries WHERE id = ?",
      deliveryId,
    ).toArray()[0];
    if (!row || row.status !== "pending") return false;
    const preference = this.letterPreferenceRow(row.soul_id);
    const correctConsent = preference?.status === "confirmed"
      || (row.delivery_kind === "confirmation" && preference?.status === "pending");
    const kindEnabled = row.delivery_kind === "confirmation"
      || row.delivery_kind === "mortal_death" && preference?.mortal_letters_enabled === 1
      || row.delivery_kind === "keeper_weekly" && preference?.keeper_letters_enabled === 1;
    if (!preference?.email_ciphertext || !preference.email_iv || !correctConsent || !kindEnabled) {
      this.ctx.storage.sql.exec(
        "UPDATE email_deliveries SET status = ?, failure_code = ? WHERE id = ? AND status = 'pending'",
        preference?.status === "suppressed" ? "suppressed" : "skipped", "consent_inactive", row.id,
      );
      return false;
    }

    const now = Date.now();
    const marked = this.ctx.storage.sql.exec(`
      UPDATE email_deliveries SET status = 'sending', attempted_at = ?, email_hash = ?, consent_version = ?
      WHERE id = ? AND status = 'pending' RETURNING id
    `, now, preference.email_hash, preference.consent_version, row.id).toArray();
    if (marked.length === 0) return false;

    let providerCallStarted = false;
    try {
      let primaryClaim = existingPrimaryClaim;
      if (!primaryClaim) {
        const purpose = row.delivery_kind === "confirmation" ? "confirm_email" : "return_soul";
        const expiry = now + (purpose === "confirm_email" ? GROWTH_DAY_MS : 30 * GROWTH_DAY_MS);
        primaryClaim = (await this.createSecureClaim(
          row.soul_id,
          purpose,
          preference.consent_version,
          row.life_id,
          expiry,
          now,
        )).token;
      }
      const unsubscribeClaim = (await this.createSecureClaim(
        row.soul_id,
        "unsubscribe",
        preference.consent_version,
        null,
        null,
        now,
      )).token;
      const recipient = await decryptText({
        ciphertext: preference.email_ciphertext,
        iv: preference.email_iv,
        version: 1,
      }, encryptionKey);
      const soul = this.ctx.storage.sql.exec<{ poetic_name: string }>(
        "SELECT poetic_name FROM souls WHERE id = ?",
        row.soul_id,
      ).one();
      const primaryUrl = this.emailLink(row.soul_id, primaryClaim);
      const unsubscribeUrl = this.emailLink(row.soul_id, unsubscribeClaim);
      const safeName = escapeHtml(soul.poetic_name);
      let subject = "A letter from the Eternal Pond";
      let opening = `${soul.poetic_name} is remembered by the pond.`;
      if (row.delivery_kind === "confirmation") {
        subject = "Confirm your Pond Letters";
        opening = `Let the pond know where to write about ${soul.poetic_name}.`;
      } else if (row.delivery_kind === "keeper_weekly") {
        subject = `A quiet week with ${soul.poetic_name}`;
        opening = this.keeperWeeklyNote(row.soul_id);
      }
      const action = row.delivery_kind === "confirmation" ? "Confirm Pond Letters" : "Return to the pond";
      const currentPreference = this.letterPreferenceRow(row.soul_id);
      const currentConsent = currentPreference?.email_hash === preference.email_hash
        && currentPreference.consent_version === preference.consent_version
        && (row.delivery_kind === "confirmation"
          ? currentPreference.status === "pending"
          : currentPreference.status === "confirmed")
        && (row.delivery_kind !== "mortal_death" || currentPreference.mortal_letters_enabled === 1)
        && (row.delivery_kind !== "keeper_weekly" || currentPreference.keeper_letters_enabled === 1);
      const suppressed = preference.email_hash !== null && this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM email_suppressions WHERE email_hash = ?",
        preference.email_hash,
      ).one().count > 0;
      if (!currentConsent || suppressed) {
        this.ctx.storage.sql.exec(
          "UPDATE email_deliveries SET status = ?, failure_code = 'consent_changed' WHERE id = ? AND status = 'sending'",
          suppressed || currentPreference?.status === "suppressed" ? "suppressed" : "skipped", row.id,
        );
        return false;
      }
      providerCallStarted = true;
      const result = await sendPondEmail(this.env, {
        to: recipient,
        subject,
        text: `${opening}\n\n${action}: ${primaryUrl}\n\nStop Pond Letters: ${unsubscribeUrl}`,
        html: `<p>${escapeHtml(opening)}</p><p><a href="${escapeHtml(primaryUrl)}">${action}</a></p><p><small><a href="${escapeHtml(unsubscribeUrl)}">Stop Pond Letters</a></small></p><span style="display:none">${safeName}</span>`,
        idempotencyKey: row.dedupe_key,
        tags: [{ name: "kind", value: row.delivery_kind }],
      });
      this.ctx.storage.sql.exec(
        "UPDATE email_deliveries SET status = 'sent', sent_at = ?, provider_id = ? WHERE id = ? AND status = 'sending'",
        Date.now(), result.providerId, row.id,
      );
      const storedOutcome = this.ctx.storage.sql.exec<{
        event_type: string;
        event_created_at: number | null;
        received_at: number;
        bounce_type: string | null;
      }>(`
        SELECT event_type, event_created_at, received_at, bounce_type FROM resend_webhook_events
        WHERE provider_id = ? ORDER BY received_at DESC LIMIT 1
      `, result.providerId).toArray()[0];
      if (storedOutcome) {
        this.applyResendOutcome(
          result.providerId,
          storedOutcome.event_type,
          storedOutcome.event_created_at ?? storedOutcome.received_at,
          storedOutcome.bounce_type,
        );
      }
      return true;
    } catch {
      this.ctx.storage.sql.exec(
        "UPDATE email_deliveries SET status = 'failed', failure_code = ? WHERE id = ? AND status = 'sending'",
        providerCallStarted ? "provider_call_failed" : "delivery_preparation_failed", row.id,
      );
      return false;
    }
  }

  private keeperWeeklyNote(soulId: string): string {
    const recent = this.ctx.storage.sql.exec<{ event_kind: string; event_at: number }>(
      `SELECT event_kind, event_at FROM soul_events
       WHERE soul_id = ? AND event_at >= ?
         AND event_kind IN ('public_ripple', 'life_started', 'life_ended', 'keeper_consecrated', 'keeper_rested', 'sharing_enabled')
       ORDER BY event_at DESC LIMIT 1`,
      soulId, Date.now() - 7 * GROWTH_DAY_MS,
    ).toArray()[0];
    if (recent?.event_kind === "public_ripple") return "Someone left a quiet ripple beside this soul.";
    if (recent?.event_kind === "life_started") return "A new passage began for this soul in the pond.";
    if (recent?.event_kind === "life_ended") return "The pond carried this soul's mortal passage into memory.";
    if (recent?.event_kind === "keeper_consecrated") return "This soul entered its eternal passage without losing its place in the water.";
    if (recent?.event_kind === "keeper_rested") return "This eternal soul came to rest beneath the memorial dome.";
    if (recent?.event_kind === "sharing_enabled") return "A quiet path to this soul was opened beyond the pond.";
    const entity = this.findSoulEntity(soulId);
    if (entity?.memorialPhase === "dome") return "This eternal soul is resting beneath the memorial dome.";
    const phase = orbitPhaseAt(Date.now(), this.orbitEpoch);
    return phase > 0.2 && phase < 0.8
      ? "This eternal soul moved beneath a bright turning sky."
      : "This eternal soul moved through the pond under a dark turning sky.";
  }

  private async drainEmailOutbox(): Promise<void> {
    const due = this.ctx.storage.sql.exec<{ id: string }>(`
      SELECT id FROM email_deliveries WHERE status = 'pending' AND due_at <= ? ORDER BY due_at, created_at LIMIT 8
    `, Date.now()).toArray();
    for (const row of due) await this.sendEmailDelivery(row.id);
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
      if (existing.lifeKind === "memorial" && existing.memorialPhase === "dome") {
        return [{ v: PROTOCOL_VERSION, type: "ritualAck", requestId, accepted: false, reason: "keeper_resting" }];
      }
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
    const born = this.birthSoulFish(session, safePoint, now);
    this.pendingRituals.push(this.ritual("birth", safePoint, session.soulId, now, 0.8));
    return [
      { v: PROTOCOL_VERSION, type: "ritualAck", requestId, accepted: true, sampledPoint: safePoint },
      this.lifeStartedMessage(born, requestId),
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
    this.recordSoulEvent(soul.id, "life_started", now, { lifeKind: "mortal" });
    this.track("birth");
    return entity;
  }

  private lifeStartedMessage(entity: SimEntity, requestId: string): ServerMessage {
    const completedLives = this.ctx.storage.sql.exec<{ completed_lives: number }>(
      "SELECT completed_lives FROM souls WHERE id = ?",
      entity.soulId,
    ).toArray()[0]?.completed_lives ?? 0;
    return {
      v: PROTOCOL_VERSION,
      type: "lifeStarted",
      requestId,
      life: {
        lifeId: entity.lifeId ?? "",
        entityId: entity.id,
        name: entity.label ?? "A quiet soul",
        lifeKind: entity.lifeKind === "memorial" ? "eternal" : "mortal",
        status: entity.memorialPhase === "dome" ? "resting" : "living",
        bornAt: entity.bornAt ?? Date.now(),
        endsAt: entity.endsAt,
        memorialPhase: entity.memorialPhase ?? undefined,
      },
      reincarnation: completedLives > 0,
    };
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
      } else if (entity.kind === "bird") {
        const takingOff = startBirdTakeoff(entity, now);
        if (takingOff !== entity) {
          this.entities.set(takingOff.id, takingOff);
          this.persistEntity(takingOff);
        }
        continue;
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
      this.activateNature(this.natureEvent("water_disturbance", point, now, 4_000, [], 0.4), true);
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
      const disconnectedAt = Date.now();
      this.ctx.storage.sql.exec("UPDATE souls SET last_seen_at = ? WHERE id = ?", disconnectedAt, session.soulId);
      this.ctx.storage.sql.exec(
        "UPDATE soul_visits SET last_seen_at = MAX(last_seen_at, ?) WHERE soul_id = ? AND day = ?",
        disconnectedAt, session.soulId, utcDay(disconnectedAt),
      );
      const entity = this.findSoulEntity(session.soulId);
      if (entity) {
        entity.foreground = false;
        entity.updatedAt = disconnectedAt;
        this.persistEntity(entity);
        this.pendingRituals.push(this.ritual("departure", { x: entity.x, z: entity.z }, session.soulId, disconnectedAt, 0.2));
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
      if (isNaturalLifeComplete(entity, now)) {
        completed.push({ entity, message: this.completeLife(entity, now) });
        continue;
      }
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
    if (this.sequence % 600 === 0) {
      this.processKeeperStates(now);
      this.ctx.waitUntil(this.drainEmailOutbox());
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
      "INSERT INTO memories(id, soul_id, life_id, display_name, tint, life_kind, completed_at, x, z) VALUES (?, ?, ?, ?, ?, 'mortal', ?, ?, ?)",
      memoryId, entity.soulId, entity.lifeId, soul.poetic_name, soul.tint, now, entity.x, entity.z,
    );
    this.recordSoulEvent(entity.soulId, "life_ended", now, { lifeKind: "mortal" });
    this.queueMortalLetter(entity.soulId, entity.lifeId, now);
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
      memory: {
        id: memoryId,
        soulId: entity.soulId,
        name: soul.poetic_name,
        tint: soul.tint,
        completedAt: now,
        lifeKind: "mortal",
        x: entity.x,
        z: entity.z,
      },
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
    if (completed.length > 0) {
      await this.processQueue();
      this.ctx.waitUntil(this.drainEmailOutbox());
    }
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

  private async deliverKeeperUpdate(soulId: string): Promise<void> {
    const sessions = [...this.sessions.values()].filter((session) => session.soulId === soulId);
    if (sessions.length === 0) return;
    const message: ServerMessage = {
      v: PROTOCOL_VERSION,
      type: "keeperUpdated",
      requestId: `keeper_${this.sequence}_${Date.now()}`,
      keeper: this.keeperSummary(soulId),
      currentLife: this.currentLifeSummary(soulId),
    };
    await Promise.all(sessions.map((session) =>
      this.gateway(session.gatewayShard).deliverToSession(session.sessionId, [message])));
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
      let born: SimEntity | null = null;
      if (existing) {
        existing.foreground = true;
        existing.updatedAt = Date.now();
        session.entityId = existing.id;
        this.persistEntity(existing);
      } else {
        born = this.birthSoulFish(session, entry.point, Date.now());
        this.pendingRituals.push(this.ritual("birth", { x: born.x, z: born.z }, entry.soulId, Date.now(), 0.8));
      }
      const messages: ServerMessage[] = [];
      if (born) messages.push(this.lifeStartedMessage(born, entry.requestId));
      messages.push({
          v: PROTOCOL_VERSION,
          type: "snapshot",
          requestId: entry.requestId,
          snapshot: this.snapshot(),
        });
      await this.gateway(entry.gatewayShard).deliverToSession(entry.sessionId, messages);
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
    await this.rescheduleAlarm();
  }

  private async rescheduleAlarm(): Promise<void> {
    const now = Date.now();
    const nextLifeEnd = [...this.entities.values()]
      .map((entity) => entity.endsAt)
      .filter((value): value is number => value !== null && value > now)
      .sort((a, b) => a - b)[0];
    const nextScheduled = this.ctx.storage.sql.exec<{ due_at: number }>(
      "SELECT due_at FROM scheduled_events WHERE completed_at IS NULL AND due_at > ? ORDER BY due_at LIMIT 1",
      now,
    ).toArray()[0]?.due_at;
    const nextEmail = this.ctx.storage.sql.exec<{ due_at: number }>(
      "SELECT due_at FROM email_deliveries WHERE status = 'pending' ORDER BY due_at LIMIT 1",
    ).toArray()[0]?.due_at;
    const nextKeeper = this.ctx.storage.sql.exec<{ due_at: number }>(`
      SELECT MIN(due_at) AS due_at FROM (
        SELECT paid_through_at AS due_at FROM keeper_memberships
          WHERE activated_at IS NOT NULL AND rested_at IS NULL AND paid_through_at > ?
        UNION ALL
        SELECT next_weekly_letter_at AS due_at FROM keeper_memberships
          WHERE next_weekly_letter_at > ?
      )
    `, now, now).toArray()[0]?.due_at;
    const alarmAt = Math.min(
      nextLifeEnd ?? Number.MAX_SAFE_INTEGER,
      nextScheduled ?? Number.MAX_SAFE_INTEGER,
      nextEmail ?? Number.MAX_SAFE_INTEGER,
      nextKeeper ?? Number.MAX_SAFE_INTEGER,
      now + 6 * 60 * 60 * 1000,
    );
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
    this.processKeeperStates(now);
    await this.drainEmailOutbox();
    this.lastTickAt = now;
    this.checkpoint();
    if (this.sessions.size === 0) await this.sleepWorld();
    else await this.rescheduleAlarm();
  }

  private track(event: string, quality = 0): void {
    const day = new Date().toISOString().slice(0, 10);
    this.ctx.storage.sql.exec(`
      INSERT INTO analytics_daily(day, event, count, quality_sum) VALUES (?, ?, 1, ?)
      ON CONFLICT(day, event) DO UPDATE SET count = count + 1, quality_sum = quality_sum + excluded.quality_sum
    `, day, event, quality);
  }

  async getPublicSoul(input: { slug: string }): Promise<PublicSoulView | null> {
    return this.publicSoulView(input.slug);
  }

  async inspectSecureLink(input: { claim: string }): Promise<LinkInspection> {
    if (input.claim.length < 20 || input.claim.length > 256) return { valid: false };
    const tokenHash = await sha256Hex(input.claim);
    const row = this.ctx.storage.sql.exec<{
      purpose: "confirm_email" | "return_soul" | "unsubscribe";
      soul_id: string;
      expires_at: number | null;
      consent_version: number;
      consumed_at: number | null;
      poetic_name: string;
      current_consent_version: number | null;
      preference_status: LetterPreferenceSummary["status"] | null;
      slug: string | null;
      disabled_at: number | null;
    }>(`
      SELECT secure_link_claims.purpose, secure_link_claims.soul_id, secure_link_claims.expires_at,
        secure_link_claims.consent_version, secure_link_claims.consumed_at, souls.poetic_name,
        pond_letter_preferences.consent_version AS current_consent_version,
        pond_letter_preferences.status AS preference_status,
        public_souls.slug, public_souls.disabled_at
      FROM secure_link_claims
      JOIN souls ON souls.id = secure_link_claims.soul_id
      LEFT JOIN pond_letter_preferences ON pond_letter_preferences.soul_id = souls.id
      LEFT JOIN public_souls ON public_souls.soul_id = souls.id
      WHERE secure_link_claims.token_hash = ?
    `, tokenHash).toArray()[0];
    const now = Date.now();
    if (!row || row.consumed_at !== null || row.expires_at !== null && row.expires_at <= now) return { valid: false };
    if (row.purpose !== "return_soul" && row.current_consent_version !== row.consent_version) return { valid: false };
    if (row.purpose === "confirm_email" && row.preference_status !== "pending") return { valid: false };
    if (row.purpose === "unsubscribe" && row.preference_status !== "pending" && row.preference_status !== "confirmed") {
      return { valid: false };
    }
    return {
      valid: true,
      purpose: row.purpose,
      name: row.poetic_name,
      slug: row.disabled_at === null ? row.slug ?? undefined : undefined,
      expiresAt: row.expires_at ?? undefined,
    };
  }

  async redeemSecureLink(input: { claim: string; currentToken?: string }): Promise<LinkRedemption> {
    const inspected = await this.inspectSecureLink({ claim: input.claim });
    if (!inspected.valid) return { ok: false, message: "invalid_or_expired" };
    const tokenHash = await sha256Hex(input.claim);
    const claim = this.ctx.storage.sql.exec<{
      soul_id: string;
      purpose: "confirm_email" | "return_soul" | "unsubscribe";
      consent_version: number;
      expires_at: number | null;
    }>(`
      SELECT soul_id, purpose, consent_version, expires_at FROM secure_link_claims
      WHERE token_hash = ? AND consumed_at IS NULL
    `, tokenHash).toArray()[0];
    if (!claim) return { ok: false, message: "invalid_or_expired" };
    if (input.currentToken) {
      const currentSoul = this.findSoulByTokenHash(await sha256Hex(input.currentToken));
      if (currentSoul && currentSoul.id !== claim.soul_id) {
        return {
          ok: false,
          purpose: claim.purpose,
          name: inspected.name,
          slug: inspected.slug,
          message: "switch_required",
        };
      }
    }

    const now = Date.now();
    if (claim.expires_at !== null && claim.expires_at <= now) return { ok: false, message: "invalid_or_expired" };
    if (claim.purpose !== "return_soul") {
      const preference = this.ctx.storage.sql.exec<{ status: string; consent_version: number }>(
        "SELECT status, consent_version FROM pond_letter_preferences WHERE soul_id = ?",
        claim.soul_id,
      ).toArray()[0];
      const validStatus = claim.purpose === "confirm_email"
        ? preference?.status === "pending"
        : preference?.status === "pending" || preference?.status === "confirmed";
      if (!preference || preference.consent_version !== claim.consent_version || !validStatus) {
        return { ok: false, message: "invalid_or_expired" };
      }
    }
    let issuedToken: string | undefined;
    let issuedHash: string | undefined;
    if (claim.purpose === "return_soul") {
      issuedToken = makeToken();
      issuedHash = await sha256Hex(issuedToken);
    }
    const consumed = this.ctx.storage.sql.exec(`
      UPDATE secure_link_claims SET consumed_at = ?
      WHERE token_hash = ? AND consumed_at IS NULL
      RETURNING soul_id
    `, now, tokenHash).toArray();
    if (consumed.length === 0) return { ok: false, message: "already_used" };

    if (claim.purpose === "confirm_email") {
      const confirmed = this.ctx.storage.sql.exec(`
        UPDATE pond_letter_preferences SET status = 'confirmed', confirmed_at = ?, unsubscribed_at = NULL
        WHERE soul_id = ? AND consent_version = ? AND status = 'pending'
        RETURNING soul_id
      `, now, claim.soul_id, claim.consent_version);
      if (confirmed.toArray().length === 0) return { ok: false, message: "invalid_or_expired" };
      this.ctx.storage.sql.exec(`
        UPDATE email_deliveries SET status = 'pending', due_at = ?
        WHERE soul_id = ? AND status = 'waiting_confirmation' AND delivery_kind = 'mortal_death'
      `, now, claim.soul_id);
      this.recordSoulEvent(claim.soul_id, "email_confirmed", now);
      this.ctx.waitUntil(this.drainEmailOutbox());
    } else if (claim.purpose === "return_soul" && issuedToken && issuedHash) {
      this.ctx.storage.sql.exec(
        "INSERT INTO soul_credentials(id, soul_id, token_hash, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)",
        crypto.randomUUID(), claim.soul_id, issuedHash, now, now,
      );
      this.recordSoulEvent(claim.soul_id, "credential_recovered", now);
    } else if (claim.purpose === "unsubscribe") {
      const unsubscribed = this.ctx.storage.sql.exec(`
        UPDATE pond_letter_preferences SET status = 'unsubscribed', consent_version = consent_version + 1,
          mortal_letters_enabled = 0, keeper_letters_enabled = 0, unsubscribed_at = ?
        WHERE soul_id = ? AND consent_version = ? AND status IN ('pending', 'confirmed')
        RETURNING soul_id
      `, now, claim.soul_id, claim.consent_version);
      if (unsubscribed.toArray().length === 0) return { ok: false, message: "invalid_or_expired" };
      this.ctx.storage.sql.exec(
        "UPDATE email_deliveries SET status = 'skipped', failure_code = 'unsubscribed' WHERE soul_id = ? AND status IN ('pending', 'waiting_confirmation')",
        claim.soul_id,
      );
      this.ctx.storage.sql.exec(
        "UPDATE keeper_memberships SET weekly_letters_enabled = 0, updated_at = ? WHERE soul_id = ?",
        now, claim.soul_id,
      );
    }
    return {
      ok: true,
      purpose: claim.purpose,
      name: inspected.name,
      slug: inspected.slug,
      token: issuedToken,
    };
  }

  async applyResendWebhook(input: {
    webhookId: string;
    eventType: string;
    providerId: string | null;
    eventCreatedAt: number;
    receivedAt: number;
    bounceType?: string | null;
  }): Promise<{ duplicate: boolean }> {
    const duplicate = this.ctx.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM resend_webhook_events WHERE id = ?",
      input.webhookId,
    ).one().count > 0;
    if (duplicate) return { duplicate: true };
    this.ctx.storage.sql.exec(
      `INSERT INTO resend_webhook_events(
        id, event_type, provider_id, received_at, bounce_type, event_created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      input.webhookId, input.eventType, input.providerId, input.receivedAt,
      input.bounceType ?? null, input.eventCreatedAt,
    );
    if (input.providerId) {
      this.applyResendOutcome(input.providerId, input.eventType, input.eventCreatedAt, input.bounceType);
    }
    return { duplicate: false };
  }

  private applyResendOutcome(providerId: string, eventType: string, at: number, bounceType?: string | null): void {
    if (eventType === "email.delivered") {
      this.ctx.storage.sql.exec(
        "UPDATE email_deliveries SET status = 'delivered', delivered_at = ? WHERE provider_id = ? AND status IN ('sent', 'sending')",
        at, providerId,
      );
      return;
    }
    if (eventType !== "email.bounced" && eventType !== "email.complained") return;
    const delivery = this.ctx.storage.sql.exec<{
      soul_id: string;
      email_hash: string | null;
      consent_version: number | null;
    }>(
      "SELECT soul_id, email_hash, consent_version FROM email_deliveries WHERE provider_id = ?",
      providerId,
    ).toArray()[0];
    if (!delivery) return;
    const hardBounce = eventType === "email.bounced"
      && (bounceType === undefined || bounceType === null || bounceType.toLowerCase() === "permanent");
    const failureCode = eventType === "email.complained"
      ? "complaint"
      : hardBounce ? "hard_bounce" : "non_permanent_bounce";
    this.ctx.storage.sql.exec(
      "UPDATE email_deliveries SET status = 'failed', failure_code = ? WHERE provider_id = ?",
      failureCode, providerId,
    );
    if (eventType === "email.bounced" && !hardBounce) return;
    const suppressedEmail = delivery.email_hash;
    if (suppressedEmail) {
      this.ctx.storage.sql.exec(`
        INSERT INTO email_suppressions(email_hash, reason, suppressed_at) VALUES (?, ?, ?)
        ON CONFLICT(email_hash) DO UPDATE SET reason = excluded.reason, suppressed_at = excluded.suppressed_at
      `, suppressedEmail, failureCode, at);
    }
    this.ctx.storage.sql.exec(`
      UPDATE pond_letter_preferences SET status = 'suppressed', mortal_letters_enabled = 0,
        keeper_letters_enabled = 0 WHERE soul_id = ? AND email_hash = ?
    `, delivery.soul_id, suppressedEmail);
    if (suppressedEmail) {
      this.ctx.storage.sql.exec(
        `UPDATE email_deliveries SET status = 'suppressed', failure_code = ?
         WHERE soul_id = ? AND email_hash = ? AND status IN ('pending', 'waiting_confirmation')`,
        failureCode, delivery.soul_id, suppressedEmail,
      );
    }
  }

  async getRetentionReport(input: { from: string; to: string }): Promise<RetentionReport> {
    const fromStart = utcDayStart(input.from);
    const toStart = utcDayStart(input.to);
    if (fromStart === null || toStart === null || fromStart > toStart) throw new Error("invalid_date_range");
    const now = Date.now();
    const credentialRows = this.ctx.storage.sql.exec<{ soul_id: string; created_at: number }>(`
      SELECT soul_id, MIN(created_at) AS created_at FROM soul_credentials GROUP BY soul_id
    `).toArray();
    const lifeRows = this.ctx.storage.sql.exec<{
      soul_id: string;
      started_at: number;
      ended_at: number | null;
    }>(`
      SELECT lives.soul_id, lives.started_at, lives.ended_at FROM lives
      WHERE lives.soul_id IS NOT NULL
        AND lives.started_at = (SELECT MIN(first_life.started_at) FROM lives AS first_life WHERE first_life.soul_id = lives.soul_id)
      ORDER BY lives.started_at
    `).toArray();
    const visitRows = this.ctx.storage.sql.exec<{ soul_id: string; day: string }>(
      "SELECT soul_id, day FROM soul_visits",
    ).toArray();
    const connectionRows = this.ctx.storage.sql.exec<{ soul_id: string; event_at: number }>(`
      SELECT soul_id, event_at FROM soul_events WHERE event_kind = 'authenticated_connection'
    `).toArray();
    const deliveryRows = this.ctx.storage.sql.exec<{
      soul_id: string;
      delivered_at: number;
    }>(`
      SELECT soul_id, delivered_at FROM email_deliveries
      WHERE delivered_at IS NOT NULL AND delivery_kind IN ('mortal_death', 'keeper_weekly')
    `).toArray();

    const firstCredential = new Map<string, number>();
    const credentialsByDay = new Map<string, number>();
    for (const row of credentialRows) {
      firstCredential.set(row.soul_id, row.created_at);
      const day = utcDay(row.created_at);
      credentialsByDay.set(day, (credentialsByDay.get(day) ?? 0) + 1);
    }
    const firstBirth = new Map<string, { startedAt: number; endedAt: number | null }>();
    for (const row of lifeRows) {
      const existing = firstBirth.get(row.soul_id);
      if (!existing || row.started_at < existing.startedAt) {
        firstBirth.set(row.soul_id, { startedAt: row.started_at, endedAt: row.ended_at });
      }
    }
    const visitsBySoul = new Map<string, Set<string>>();
    for (const row of visitRows) {
      const days = visitsBySoul.get(row.soul_id) ?? new Set<string>();
      days.add(row.day);
      visitsBySoul.set(row.soul_id, days);
    }
    const deliveriesBySoul = new Map<string, number[]>();
    for (const row of deliveryRows) {
      const timestamps = deliveriesBySoul.get(row.soul_id) ?? [];
      timestamps.push(row.delivered_at);
      deliveriesBySoul.set(row.soul_id, timestamps);
    }
    const connectionsBySoul = new Map<string, number[]>();
    for (const row of connectionRows) {
      const timestamps = connectionsBySoul.get(row.soul_id) ?? [];
      timestamps.push(row.event_at);
      connectionsBySoul.set(row.soul_id, timestamps);
    }
    const soulsByBirthDay = new Map<string, string[]>();
    const birthCompletionsByCredentialDay = new Map<string, number>();
    for (const [soulId, birth] of firstBirth) {
      const day = utcDay(birth.startedAt);
      const soulIds = soulsByBirthDay.get(day) ?? [];
      soulIds.push(soulId);
      soulsByBirthDay.set(day, soulIds);
      const credentialAt = firstCredential.get(soulId);
      if (credentialAt !== undefined && birth.startedAt >= credentialAt
        && birth.startedAt <= credentialAt + GROWTH_DAY_MS) {
        const credentialDay = utcDay(credentialAt);
        birthCompletionsByCredentialDay.set(
          credentialDay,
          (birthCompletionsByCredentialDay.get(credentialDay) ?? 0) + 1,
        );
      }
    }

    const cohorts: RetentionCohort[] = [];
    for (let dayStart = fromStart; dayStart <= toStart; dayStart += GROWTH_DAY_MS) {
      const day = utcDay(dayStart);
      const soulIds = soulsByBirthDay.get(day) ?? [];
      const birthCompletions24h = birthCompletionsByCredentialDay.get(day) ?? 0;
      let eligibleSouls = 0;
      let returnedSouls = 0;
      let secondVisitSouls = 0;
      let deliveredLetters = 0;
      let eligibleDeliveredLetters = 0;
      let returnedAfterLetter = 0;
      for (const soulId of soulIds) {
        const visitDays = visitsBySoul.get(soulId) ?? new Set<string>();
        const laterVisit = [...visitDays].some((visitDay) => visitDay > day);
        if (laterVisit) secondVisitSouls++;
        const eligible = now >= dayStart + 9 * GROWTH_DAY_MS;
        if (eligible) {
          eligibleSouls++;
          const returned = [...visitDays].some((visitDay) => visitDay >= addUtcDays(day, 1) && visitDay <= addUtcDays(day, 8));
          if (returned) returnedSouls++;
        }
        for (const deliveredAt of deliveriesBySoul.get(soulId) ?? []) {
          deliveredLetters++;
          if (now < deliveredAt + 8 * GROWTH_DAY_MS) continue;
          eligibleDeliveredLetters++;
          const returned = (connectionsBySoul.get(soulId) ?? []).some((connectedAt) =>
            connectedAt > deliveredAt && connectedAt <= deliveredAt + 8 * GROWTH_DAY_MS);
          if (returned) returnedAfterLetter++;
        }
      }
      cohorts.push({
        day,
        newCredentials: credentialsByDay.get(day) ?? 0,
        firstBirths: soulIds.length,
        birthCompletions24h,
        birthCompletionRate: fraction(birthCompletions24h, credentialsByDay.get(day) ?? 0),
        eligibleSouls,
        returnedSouls,
        returnRate: fraction(returnedSouls, eligibleSouls),
        secondVisitSouls,
        secondVisitRate: fraction(secondVisitSouls, soulIds.length),
        deliveredLetters,
        eligibleDeliveredLetters,
        returnedAfterLetter,
        letterReturnRate: fraction(returnedAfterLetter, eligibleDeliveredLetters),
      });
    }
    const totals = cohorts.reduce((result, cohort) => ({
      eligibleSouls: result.eligibleSouls + cohort.eligibleSouls,
      returnedSouls: result.returnedSouls + cohort.returnedSouls,
      deliveredLetters: result.deliveredLetters + cohort.deliveredLetters,
      eligibleDeliveredLetters: result.eligibleDeliveredLetters + cohort.eligibleDeliveredLetters,
      returnedAfterLetter: result.returnedAfterLetter + cohort.returnedAfterLetter,
    }), {
      eligibleSouls: 0,
      returnedSouls: 0,
      deliveredLetters: 0,
      eligibleDeliveredLetters: 0,
      returnedAfterLetter: 0,
    });
    return {
      generatedAt: now,
      timezone: "UTC",
      cohortAnchor: "first_birth",
      returnWindow: { fromDay: 1, throughDay: 8 },
      from: input.from,
      to: input.to,
      totals: {
        ...totals,
        returnRate: fraction(totals.returnedSouls, totals.eligibleSouls),
        letterReturnRate: fraction(totals.returnedAfterLetter, totals.eligibleDeliveredLetters),
      },
      cohorts,
    };
  }

  private async authenticateToken(token: string): Promise<SoulRow | null> {
    if (token.length < 20 || token.length > 256) return null;
    return this.findSoulByTokenHash(await sha256Hex(token));
  }

  async revokeCredential(input: { ownerToken: string; targetToken: string }): Promise<boolean | null> {
    const owner = await this.authenticateToken(input.ownerToken);
    if (!owner) return null;
    if (input.targetToken.length < 20 || input.targetToken.length > 256) return false;
    const targetHash = await sha256Hex(input.targetToken);
    const revoked = this.ctx.storage.sql.exec(`
      UPDATE soul_credentials SET revoked_at = ?
      WHERE soul_id = ? AND token_hash = ? AND revoked_at IS NULL
      RETURNING id
    `, Date.now(), owner.id, targetHash).toArray();
    return revoked.length > 0;
  }

  async getKeeperSummary(input: { token: string; billingConfigured: boolean }): Promise<KeeperSummary | null> {
    const soul = await this.authenticateToken(input.token);
    return soul ? this.keeperSummary(soul.id, input.billingConfigured) : null;
  }

  async prepareKeeperCheckout(input: { token: string; interval: "month" | "year" }): Promise<KeeperCheckoutPreparation> {
    const soul = await this.authenticateToken(input.token);
    if (!soul) return { ok: false, reason: "unauthorized" };
    if (input.interval !== "month" && input.interval !== "year") return { ok: false, reason: "invalid_interval" };
    if (!this.keeperEligible(soul.id)) return { ok: false, reason: "not_eligible" };
    if (this.letterPreferenceRow(soul.id)?.status !== "confirmed") return { ok: false, reason: "email_required" };
    const summary = this.keeperSummary(soul.id);
    if (summary.state === "active" || summary.state === "canceling" || summary.state === "past_due") {
      return { ok: false, reason: "already_active" };
    }
    const now = Date.now();
    let membership = this.ctx.storage.sql.exec<{ id: string; stripe_customer_id: string | null }>(
      "SELECT id, stripe_customer_id FROM keeper_memberships WHERE soul_id = ?",
      soul.id,
    ).toArray()[0];
    if (!membership) {
      membership = { id: randomToken(18), stripe_customer_id: null };
      this.ctx.storage.sql.exec(`
        INSERT INTO keeper_memberships(id, soul_id, updated_at, weekly_letters_enabled)
        VALUES (?, ?, ?, 0)
      `, membership.id, soul.id, now);
    }
    this.ctx.storage.sql.exec(`
      UPDATE keeper_checkout_attempts SET state = 'expired', updated_at = ?
      WHERE membership_id = ? AND state IN ('pending', 'created') AND expires_at <= ?
    `, now, membership.id, now);
    const existing = this.ctx.storage.sql.exec<{
      id: string;
      idempotency_key: string;
      stripe_session_id: string | null;
      billing_interval: "month" | "year";
      customer_id: string | null;
    }>(`
      SELECT id, idempotency_key, stripe_session_id, billing_interval, customer_id FROM keeper_checkout_attempts
      WHERE membership_id = ? AND state IN ('pending', 'created') AND expires_at > ?
      ORDER BY created_at DESC LIMIT 1
    `, membership.id, now).toArray()[0];
    if (existing) {
      if (existing.billing_interval !== input.interval) return { ok: false, reason: "checkout_in_progress" };
      return {
        ok: true,
        attemptId: existing.id,
        membershipRef: membership.id,
        customerId: existing.customer_id ?? undefined,
        idempotencyKey: existing.idempotency_key,
        existingSessionId: existing.stripe_session_id ?? undefined,
        inProgress: existing.stripe_session_id === null,
      };
    }
    const attemptId = crypto.randomUUID();
    const idempotencyKey = `keeper-checkout:${randomToken(20)}`;
    this.ctx.storage.sql.exec(`
      INSERT INTO keeper_checkout_attempts(
        id, membership_id, idempotency_key, billing_interval, state, expires_at, created_at, updated_at, customer_id
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `, attemptId, membership.id, idempotencyKey, input.interval, now + 30 * 60 * 1000,
    now, now, membership.stripe_customer_id);
    return {
      ok: true,
      attemptId,
      membershipRef: membership.id,
      customerId: membership.stripe_customer_id ?? undefined,
      idempotencyKey,
    };
  }

  async recordKeeperCheckout(input: { attemptId: string; sessionId: string; expiresAt: number }): Promise<void> {
    this.ctx.storage.sql.exec(`
      UPDATE keeper_checkout_attempts SET state = 'created', stripe_session_id = ?, expires_at = ?, updated_at = ?
      WHERE id = ? AND state = 'pending'
    `, input.sessionId, input.expiresAt, Date.now(), input.attemptId);
  }

  async failKeeperCheckout(input: { attemptId: string; code: string }): Promise<void> {
    this.ctx.storage.sql.exec(`
      UPDATE keeper_checkout_attempts SET state = 'failed', updated_at = ? WHERE id = ? AND state = 'pending'
    `, Date.now(), input.attemptId);
  }

  async prepareKeeperPortal(input: { token: string }): Promise<KeeperPortalPreparation> {
    const soul = await this.authenticateToken(input.token);
    if (!soul) return { ok: false, reason: "unauthorized" };
    const customer = this.ctx.storage.sql.exec<{ stripe_customer_id: string | null }>(
      "SELECT stripe_customer_id FROM keeper_memberships WHERE soul_id = ?",
      soul.id,
    ).toArray()[0];
    if (!customer?.stripe_customer_id) return { ok: false, reason: "not_configured" };
    return { ok: true, customerId: customer.stripe_customer_id };
  }

  async updateKeeperPreferences(input: {
    token: string;
    dedication?: string;
    weeklyLetters?: boolean;
  }): Promise<KeeperSummary | null> {
    const soul = await this.authenticateToken(input.token);
    if (!soul) return null;
    const membership = this.ctx.storage.sql.exec<{ id: string }>(
      "SELECT id FROM keeper_memberships WHERE soul_id = ? AND activated_at IS NOT NULL",
      soul.id,
    ).toArray()[0];
    if (!membership) return this.keeperSummary(soul.id);
    let dedication: string | null | undefined;
    if (input.dedication !== undefined) {
      dedication = normalizeDedication(input.dedication);
      if (dedication === null) throw new Error("invalid_dedication");
      if (dedication === "") dedication = null;
    }
    if (input.weeklyLetters === true && this.letterPreferenceRow(soul.id)?.status !== "confirmed") {
      throw new Error("email_required");
    }
    this.ctx.storage.sql.exec(`
      UPDATE keeper_memberships SET dedication = COALESCE(?, dedication),
        weekly_letters_enabled = COALESCE(?, weekly_letters_enabled), updated_at = ? WHERE id = ?
    `,
    dedication === undefined ? null : dedication,
    input.weeklyLetters === undefined ? null : input.weeklyLetters ? 1 : 0,
    Date.now(), membership.id);
    if (input.dedication !== undefined && dedication === null) {
      this.ctx.storage.sql.exec("UPDATE keeper_memberships SET dedication = NULL WHERE id = ?", membership.id);
    }
    if (input.weeklyLetters !== undefined) {
      this.ctx.storage.sql.exec(
        "UPDATE pond_letter_preferences SET keeper_letters_enabled = ? WHERE soul_id = ?",
        input.weeklyLetters ? 1 : 0, soul.id,
      );
    }
    return this.keeperSummary(soul.id);
  }

  async applyStripeEvent(input: NormalizedStripeEvent): Promise<{ duplicate: boolean }> {
    const duplicate = this.ctx.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM stripe_webhook_events WHERE event_id = ?",
      input.eventId,
    ).one().count > 0;
    if (duplicate) return { duplicate: true };
    const membershipRef = input.subscription?.membershipRef ?? input.checkout?.membershipRef;
    const membership = membershipRef ? this.ctx.storage.sql.exec<{
      id: string;
      soul_id: string;
      activated_at: number | null;
      paid_through_at: number | null;
      rested_at: number | null;
      current_subscription_id: string | null;
    }>(`
      SELECT id, soul_id, activated_at, paid_through_at, rested_at, current_subscription_id
      FROM keeper_memberships WHERE id = ?
    `, membershipRef).toArray()[0] : undefined;
    this.ctx.storage.sql.exec(`
      INSERT INTO stripe_webhook_events(event_id, event_type, object_id, event_created_at, processed_at)
      VALUES (?, ?, ?, ?, ?)
    `, input.eventId, input.type, input.objectId, input.createdAt, Date.now());
    if (!membership) return { duplicate: false };

    if (input.checkout) {
      const mayLinkCheckout = membership.current_subscription_id === null
        || membership.rested_at !== null && (membership.paid_through_at ?? 0) <= Date.now();
      this.ctx.storage.sql.exec(`
        UPDATE keeper_memberships SET stripe_customer_id = COALESCE(stripe_customer_id, ?),
          current_subscription_id = CASE WHEN ? = 1 THEN COALESCE(?, current_subscription_id)
            ELSE current_subscription_id END,
          updated_at = ? WHERE id = ?
      `, input.checkout.customerId, mayLinkCheckout ? 1 : 0,
      input.checkout.subscriptionId, Date.now(), membership.id);
      if (input.objectId) {
        this.ctx.storage.sql.exec(`
          UPDATE keeper_checkout_attempts SET state = 'created', updated_at = ?
          WHERE membership_id = ? AND stripe_session_id = ?
        `, Date.now(), membership.id, input.objectId);
      }
    }
    const subscription = input.subscription;
    if (!subscription) {
      await this.deliverKeeperUpdate(membership.soul_id);
      return { duplicate: false };
    }
    const expectedPrice = subscription.interval === "month"
      ? this.env.STRIPE_MONTHLY_PRICE_ID
      : subscription.interval === "year" ? this.env.STRIPE_ANNUAL_PRICE_ID : null;
    if (subscription.quantity !== 1 || !expectedPrice || subscription.priceId !== expectedPrice) return { duplicate: false };
    const now = Date.now();
    const previous = this.ctx.storage.sql.exec<{ last_event_created_at: number; paid_through_at: number | null }>(
      "SELECT last_event_created_at, paid_through_at FROM keeper_subscriptions WHERE stripe_subscription_id = ?",
      subscription.subscriptionId,
    ).toArray()[0];
    const paidGrant = input.invoicePaid && input.paidInvoiceThroughAt && input.paidInvoiceThroughAt > 0
      ? input.paidInvoiceThroughAt
      : null;
    const subscriptionPaidThrough = Math.max(previous?.paid_through_at ?? 0, paidGrant ?? 0) || null;
    this.ctx.storage.sql.exec(`
      INSERT INTO keeper_subscriptions(
        stripe_subscription_id, membership_id, stripe_customer_id, stripe_price_id, billing_interval,
        stripe_status, cancel_at_period_end, paid_through_at, started_at, ended_at,
        last_event_created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(stripe_subscription_id) DO UPDATE SET
        stripe_customer_id = CASE WHEN excluded.last_event_created_at >= keeper_subscriptions.last_event_created_at
          THEN excluded.stripe_customer_id ELSE keeper_subscriptions.stripe_customer_id END,
        stripe_price_id = CASE WHEN excluded.last_event_created_at >= keeper_subscriptions.last_event_created_at
          THEN excluded.stripe_price_id ELSE keeper_subscriptions.stripe_price_id END,
        billing_interval = CASE WHEN excluded.last_event_created_at >= keeper_subscriptions.last_event_created_at
          THEN excluded.billing_interval ELSE keeper_subscriptions.billing_interval END,
        stripe_status = CASE WHEN excluded.last_event_created_at >= keeper_subscriptions.last_event_created_at
          THEN excluded.stripe_status ELSE keeper_subscriptions.stripe_status END,
        cancel_at_period_end = CASE WHEN excluded.last_event_created_at >= keeper_subscriptions.last_event_created_at
          THEN excluded.cancel_at_period_end ELSE keeper_subscriptions.cancel_at_period_end END,
        paid_through_at = CASE
          WHEN excluded.paid_through_at IS NULL THEN keeper_subscriptions.paid_through_at
          WHEN keeper_subscriptions.paid_through_at IS NULL THEN excluded.paid_through_at
          ELSE MAX(keeper_subscriptions.paid_through_at, excluded.paid_through_at)
        END,
        ended_at = CASE WHEN excluded.last_event_created_at >= keeper_subscriptions.last_event_created_at
          THEN excluded.ended_at ELSE keeper_subscriptions.ended_at END,
        last_event_created_at = MAX(keeper_subscriptions.last_event_created_at, excluded.last_event_created_at),
        updated_at = CASE WHEN excluded.last_event_created_at >= keeper_subscriptions.last_event_created_at
          THEN excluded.updated_at ELSE keeper_subscriptions.updated_at END
    `,
    subscription.subscriptionId, membership.id, subscription.customerId, subscription.priceId,
    subscription.interval, subscription.status, subscription.cancelAtPeriodEnd ? 1 : 0, subscriptionPaidThrough,
    input.createdAt, subscription.status === "canceled" ? input.createdAt : null,
    Math.max(previous?.last_event_created_at ?? 0, input.createdAt), now);
    const refreshedMembership = this.ctx.storage.sql.exec<{
      activated_at: number | null;
      paid_through_at: number | null;
      current_subscription_id: string | null;
    }>(`
      SELECT activated_at, paid_through_at, current_subscription_id
      FROM keeper_memberships WHERE id = ?
    `, membership.id).one();
    const provenPaidActivation = input.invoicePaid === true
      && subscription.status === "active"
      && paidGrant !== null
      && paidGrant > now;
    const canonicalSubscription = refreshedMembership.current_subscription_id === null
      || refreshedMembership.current_subscription_id === subscription.subscriptionId
      || provenPaidActivation && paidGrant > (refreshedMembership.paid_through_at ?? 0);
    if (!canonicalSubscription) {
      await this.rescheduleAlarm();
      return { duplicate: false };
    }
    this.ctx.storage.sql.exec(`
      UPDATE keeper_memberships SET stripe_customer_id = ?, current_subscription_id = ?, stripe_status = ?,
        stripe_price_id = ?, billing_interval = ?, cancel_at_period_end = ?,
        paid_through_at = CASE
          WHEN ? IS NULL THEN paid_through_at
          WHEN paid_through_at IS NULL THEN ?
          ELSE MAX(paid_through_at, ?)
        END, updated_at = ?
      WHERE id = ?
    `,
    subscription.customerId, subscription.subscriptionId, subscription.status, subscription.priceId,
    subscription.interval, subscription.cancelAtPeriodEnd ? 1 : 0,
    paidGrant, paidGrant, paidGrant, now, membership.id);

    const currentPaidThrough = Math.max(refreshedMembership.paid_through_at ?? 0, paidGrant ?? 0) || null;

    if (provenPaidActivation && currentPaidThrough) {
      this.consecrateKeeper(membership.id, membership.soul_id, currentPaidThrough, now);
    } else if (refreshedMembership.activated_at !== null && (!currentPaidThrough || currentPaidThrough <= now)
      && (subscription.status === "canceled" || subscription.status === "unpaid" || subscription.status === "past_due")) {
      this.restKeeper(membership.id, membership.soul_id, now);
    }
    await this.deliverKeeperUpdate(membership.soul_id);
    await this.rescheduleAlarm();
    return { duplicate: false };
  }

  private consecrateKeeper(membershipId: string, soulId: string, paidThroughAt: number, now: number): void {
    const soul = this.ctx.storage.sql.exec<SoulRow>(
      "SELECT id, poetic_name, tint, completed_lives, last_seen_at FROM souls WHERE id = ?",
      soulId,
    ).one();
    let entity = this.findSoulEntity(soulId);
    const stateChanged = !entity || entity.lifeKind !== "memorial" || entity.memorialPhase === "dome";
    if (!entity) {
      const lifeId = crypto.randomUUID();
      entity = createSoulFish({
        entityId: crypto.randomUUID(),
        soulId,
        lifeId,
        label: soul.poetic_name,
        x: 0.5,
        z: 0.5,
        tint: soul.tint,
        now,
      });
      entity.lifeKind = "memorial";
      entity.memorialPhase = "water";
      entity.endsAt = null;
      entity.refugeUntil = null;
      entity.state = { ...entity.state, keeperAccent: true };
      entity.foreground = [...this.sessions.values()].some((session) => session.soulId === soulId && session.renderer !== "canvas")
        && this.foregroundSoulCount() < this.capacityLimit;
      this.ctx.storage.sql.exec(`
        INSERT INTO lives(id, soul_id, life_kind, started_at, ends_at, memorial_phase, owner_soul_id, billing_reference)
        VALUES (?, ?, 'memorial', ?, NULL, 'water', ?, ?)
      `, lifeId, soulId, now, soulId, membershipId);
      this.entities.set(entity.id, entity);
    } else {
      this.ctx.storage.sql.exec(`
        UPDATE lives SET life_kind = 'memorial', ends_at = NULL, ended_at = NULL,
          memorial_phase = 'water', owner_soul_id = ?, billing_reference = ? WHERE id = ?
      `, soulId, membershipId, entity.lifeId);
      entity.lifeKind = "memorial";
      entity.memorialPhase = "water";
      entity.endsAt = null;
      entity.refugeUntil = null;
      entity.state = { ...entity.state, keeperAccent: true };
      if (this.foregroundSoulCount() < this.capacityLimit
        && [...this.sessions.values()].some((session) => session.soulId === soulId && session.renderer !== "canvas")) {
        entity.foreground = true;
      }
    }
    entity.updatedAt = now;
    this.entities.set(entity.id, entity);
    this.persistEntity(entity);
    for (const session of this.sessions.values()) {
      if (session.soulId === soulId && session.renderer !== "canvas" && entity.foreground) session.entityId = entity.id;
    }
    this.ctx.storage.sql.exec(`
      UPDATE keeper_memberships SET life_id = ?, activated_at = COALESCE(activated_at, ?),
        rested_at = NULL, paid_through_at = ?, next_weekly_letter_at = COALESCE(next_weekly_letter_at, ?),
        updated_at = ? WHERE id = ?
    `, entity.lifeId, now, paidThroughAt, now + 7 * GROWTH_DAY_MS, now, membershipId);
    if (stateChanged) this.recordSoulEvent(soulId, "keeper_consecrated", now);
  }

  private restKeeper(membershipId: string, soulId: string, now: number): boolean {
    const entity = this.findSoulEntity(soulId);
    if (!entity || entity.lifeKind !== "memorial" || !entity.lifeId) return false;
    const sharing = this.sharingSummary(soulId);
    const point = deterministicMemorialPoint(sharing.slug ?? membershipId);
    entity.memorialPhase = "dome";
    entity.foreground = false;
    entity.updatedAt = now;
    this.entities.set(entity.id, entity);
    this.persistEntity(entity);
    this.ctx.storage.sql.exec(
      "UPDATE lives SET memorial_phase = 'dome' WHERE id = ?",
      entity.lifeId,
    );
    this.ctx.storage.sql.exec(`
      INSERT OR IGNORE INTO memories(id, soul_id, life_id, display_name, tint, life_kind, completed_at, x, z)
      VALUES (?, ?, ?, ?, ?, 'memorial', ?, ?, ?)
    `, crypto.randomUUID(), soulId, entity.lifeId, entity.label ?? "A quiet soul", entity.tint, now, point.x, point.z);
    this.ctx.storage.sql.exec(
      "UPDATE keeper_memberships SET rested_at = ?, next_weekly_letter_at = NULL, updated_at = ? WHERE id = ?",
      now, now, membershipId,
    );
    for (const session of this.sessions.values()) if (session.soulId === soulId) session.entityId = null;
    this.recordSoulEvent(soulId, "keeper_rested", now);
    return true;
  }

  private processKeeperStates(now: number): void {
    const memberships = this.ctx.storage.sql.exec<{
      id: string;
      soul_id: string;
      stripe_status: string | null;
      paid_through_at: number | null;
      activated_at: number | null;
      rested_at: number | null;
      weekly_letters_enabled: number;
      next_weekly_letter_at: number | null;
    }>("SELECT * FROM keeper_memberships WHERE activated_at IS NOT NULL").toArray();
    for (const membership of memberships) {
      const paid = membership.paid_through_at !== null && membership.paid_through_at > now;
      if (!paid && membership.rested_at === null) {
        if (this.restKeeper(membership.id, membership.soul_id, now)) {
          this.ctx.waitUntil(this.deliverKeeperUpdate(membership.soul_id));
        }
        continue;
      }
      if (!paid || membership.weekly_letters_enabled !== 1
        || membership.next_weekly_letter_at === null || membership.next_weekly_letter_at > now) continue;
      const preference = this.letterPreferenceRow(membership.soul_id);
      const entity = this.findSoulEntity(membership.soul_id);
      if (preference?.status === "confirmed" && preference.keeper_letters_enabled === 1
        && entity?.memorialPhase === "water") {
        const period = Math.floor(now / (7 * GROWTH_DAY_MS));
        this.createEmailDelivery(
          `keeper-weekly:${membership.id}:${period}`,
          membership.soul_id,
          "keeper_weekly",
          entity.lifeId,
          membership.id,
          "pending",
          now,
        );
        this.ctx.storage.sql.exec(`
          UPDATE keeper_memberships SET last_weekly_letter_at = ?, next_weekly_letter_at = ?, updated_at = ? WHERE id = ?
        `, now, now + 7 * GROWTH_DAY_MS, now, membership.id);
      } else {
        this.ctx.storage.sql.exec(
          "UPDATE keeper_memberships SET next_weekly_letter_at = ?, updated_at = ? WHERE id = ?",
          now + 7 * GROWTH_DAY_MS, now, membership.id,
        );
      }
    }
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
