export const PROTOCOL_VERSION = 3 as const;
export const MAX_CLIENT_MESSAGE_BYTES = 4096;
export const MAX_RIPPLE_BATCH_POINTS = 12;
export const MAX_PUBLIC_SOUL_SLUG_LENGTH = 96;
export const MAX_POND_LETTER_EMAIL_LENGTH = 254;
export const ORBIT_PERIOD_MS = 60 * 60 * 1000;
export const OFFERING_COOLDOWN_MS = 5 * 60 * 1000;
export const NEWBORN_REFUGE_MS = 10 * 60 * 1000;
export const MIN_LIFESPAN_MS = 2 * 24 * 60 * 60 * 1000;
export const MAX_LIFESPAN_MS = 7 * 24 * 60 * 60 * 1000;

export type RendererKind = "webgl" | "canvas";
export type OfferingKind = "food" | "seed";
export type LifeKind = "mortal" | "memorial";
export type MemorialPhase = "water" | "dome";
export type EntityKind = "soulFish" | "wildFish" | "legendaryPenguin" | "lily" | "bird" | "frog";
export type EntitySource = "baseline" | "offering" | "recovery";
export type FrogMode = "swimming" | "floating" | "lily" | "shore" | "ground" | "feeding";
export type BirdMode = "circling" | "approaching" | "foraging" | "perched" | "takingOff";

export interface NormalizedPoint {
  x: number;
  z: number;
}

export interface EntityRuntimeState {
  source?: EntitySource;
  ownerSoulId?: string;
  mode?: FrogMode | BirdMode | "returning";
  growthScale?: number;
  feedCount?: number;
  targetAnchor?: number;
  nextActionAt?: number;
  returningAt?: number;
  transitionFrom?: NormalizedPoint;
  transitionTo?: NormalizedPoint;
  transitionStartedAt?: number;
  transitionEndsAt?: number;
  birdLifecycleAt?: number;
  birdFlightAngle?: number;
  birdCycle?: number;
  birdRestMode?: "foraging" | "perched";
  birdTakeoffFrom?: "air" | "foraging" | "perched";
  keeperAccent?: boolean;
}

interface ClientMessageBase {
  v: typeof PROTOCOL_VERSION;
  requestId: string;
}

export interface HelloMessage extends ClientMessageBase {
  type: "hello";
  token?: string;
  renderer: RendererKind;
  reducedMotion: boolean;
  clientTime: number;
}

export interface IncarnateMessage extends ClientMessageBase {
  type: "incarnate";
  point: NormalizedPoint;
}

export interface RippleBatchMessage extends ClientMessageBase {
  type: "rippleBatch";
  points: NormalizedPoint[];
}

export interface OfferMessage extends ClientMessageBase {
  type: "offer";
  point: NormalizedPoint;
  offering: OfferingKind;
}

export interface FocusMessage extends ClientMessageBase {
  type: "focus";
  entityId: string | null;
}

export interface LeaveMessage extends ClientMessageBase {
  type: "leave";
}

export interface SetSharingMessage extends ClientMessageBase {
  type: "setSharing";
  enabled: boolean;
}

export interface ObservePublicSoulMessage extends ClientMessageBase {
  type: "observePublicSoul";
  slug: string;
}

export interface LeavePublicRippleMessage extends ClientMessageBase {
  type: "leavePublicRipple";
  slug: string;
}

export interface SetPondLetterMessage extends ClientMessageBase {
  type: "setPondLetter";
  email?: string;
  mortalLetters?: boolean;
  keeperLetters?: boolean;
}

export interface ResendPondLetterConfirmationMessage extends ClientMessageBase {
  type: "resendPondLetterConfirmation";
}

export interface UnsubscribePondLettersMessage extends ClientMessageBase {
  type: "unsubscribePondLetters";
}

export type ClientMessage =
  | HelloMessage
  | IncarnateMessage
  | RippleBatchMessage
  | OfferMessage
  | FocusMessage
  | LeaveMessage
  | SetSharingMessage
  | ObservePublicSoulMessage
  | LeavePublicRippleMessage
  | SetPondLetterMessage
  | ResendPondLetterConfirmationMessage
  | UnsubscribePondLettersMessage;

export interface SoulIdentity {
  id: string;
  name: string;
  tint: number;
  completedLives: number;
}

export interface SharingSummary {
  enabled: boolean;
  slug?: string;
  url?: string;
}

export type PondLetterStatus = "none" | "pending" | "confirmed" | "unsubscribed" | "suppressed";

export interface LetterPreferenceSummary {
  available: boolean;
  status: PondLetterStatus;
  maskedEmail?: string;
  mortalLetters: boolean;
  keeperLetters: boolean;
}

export type KeeperPresentationState = "none" | "eligible" | "pending" | "active" | "canceling" | "past_due" | "resting";

export interface KeeperSummary {
  configured: boolean;
  eligible: boolean;
  requiresConfirmedEmail: boolean;
  state: KeeperPresentationState;
  interval?: "month" | "year";
  paidThroughAt?: number;
  fishPhase?: "water" | "dome";
  dedication?: string;
  weeklyLetters: boolean;
}

export interface CurrentLifeSummary {
  lifeId: string;
  entityId: string;
  name: string;
  lifeKind: "mortal" | "eternal";
  status: "living" | "resting";
  bornAt: number;
  endsAt: number | null;
  memorialPhase?: MemorialPhase;
}

export type PublicSoulStatus = "alive" | "resting" | "remembered";

export interface PublicSoulView {
  slug: string;
  name: string;
  tint: number;
  status: PublicSoulStatus;
  completedLives: number;
  dedication?: string;
  currentLife?: {
    kind: "mortal" | "eternal";
    ageText: string;
    remainingPassageText?: string;
    presentation: {
      x: number;
      z: number;
      depth: number;
      heading: number;
      size: number;
      ageRatio: number;
    };
  };
  latestMemorial?: {
    completedAt: number;
    ageText: string;
    rippleAnchor: NormalizedPoint;
  };
}

export interface EntityState {
  id: string;
  kind: EntityKind;
  soulId: string | null;
  lifeId: string | null;
  label: string | null;
  x: number;
  z: number;
  depth: number;
  heading: number;
  speed: number;
  size: number;
  tint: number;
  ageRatio: number;
  bornAt: number | null;
  endsAt: number | null;
  refugeUntil: number | null;
  lifeKind: LifeKind | null;
  memorialPhase: MemorialPhase | null;
  state: EntityRuntimeState;
}

export interface EntityMotion {
  id: string;
  x: number;
  z: number;
  depth: number;
  heading: number;
  size: number;
  ageRatio: number;
  state?: EntityRuntimeState;
}

export interface BackgroundCohort {
  id: string;
  kind: "mortal" | "wild" | "memorial";
  populationCount: number;
  x: number;
  z: number;
  tint: number;
  seed: number;
}

export interface DomeMemory {
  id: string;
  soulId: string | null;
  name: string;
  tint: number;
  completedAt: number;
  lifeKind: LifeKind;
  x?: number;
  z?: number;
}

export interface RecentLifeRecord {
  memoryId: string;
  ageText: string;
  completedAt: number;
}

export interface RitualEvent {
  id: string;
  kind: "ripple" | "food" | "seed" | "birth" | "departure";
  x: number;
  z: number;
  strength: number;
  createdAt: number;
  soulId: string | null;
}

export type NatureEventKind =
  | "fish_glint"
  | "frog_hop"
  | "frog_call"
  | "frog_feed"
  | "bird_transition"
  | "bird_hunt"
  | "dragonfly_pass"
  | "reed_gust"
  | "lily_movement"
  | "water_disturbance"
  | "food_gathering"
  | "predator_warning"
  | "lily_return";

export interface NatureEvent {
  id: string;
  kind: NatureEventKind;
  startsAt: number;
  endsAt: number;
  x: number;
  z: number;
  strength: number;
  seed: number;
  targetIds: string[];
  frogId?: string;
  insectId?: string;
  from?: NormalizedPoint;
  to?: NormalizedPoint;
}

export interface CapacityState {
  embodied: number;
  limit: number;
  spectators: number;
  queued: number;
}

export interface OrbitState {
  epoch: number;
  periodMs: number;
  phase: number;
}

export interface WorldSnapshot {
  serverTime: number;
  orbit: OrbitState;
  sequence: number;
  entities: EntityState[];
  backgroundCohorts: BackgroundCohort[];
  natureEvents: NatureEvent[];
  memories: DomeMemory[];
  foundingRipples: number;
  pondBornAt: number;
  capacity: CapacityState;
  connectedSouls: number;
}

export interface WelcomeMessage {
  v: typeof PROTOCOL_VERSION;
  type: "welcome";
  requestId: string;
  serverTime: number;
  token?: string;
  sessionId: string;
  identity: SoulIdentity;
  ownedEntityId: string | null;
  renderer: RendererKind;
  recentLifeRecord?: RecentLifeRecord;
  sharing?: SharingSummary;
  pondLetters?: LetterPreferenceSummary;
  currentLife?: CurrentLifeSummary | null;
  keeper?: KeeperSummary;
}

export interface SnapshotMessage {
  v: typeof PROTOCOL_VERSION;
  type: "snapshot";
  requestId: string;
  snapshot: WorldSnapshot;
}

export interface DeltaMessage {
  v: typeof PROTOCOL_VERSION;
  type: "delta";
  requestId: string;
  serverTime: number;
  sequence: number;
  upserts: EntityState[];
  motions: EntityMotion[];
  backgroundCohorts: BackgroundCohort[];
  hiddenIds: string[];
  removedIds: string[];
  rituals: RitualEvent[];
  natureEvents: NatureEvent[];
  orbitPhase: number;
}

export interface RitualAckMessage {
  v: typeof PROTOCOL_VERSION;
  type: "ritualAck";
  requestId: string;
  accepted: boolean;
  sampledPoint?: NormalizedPoint;
  nextOfferingAt?: number;
  reason?: "cooldown" | "spectator" | "invalid" | "unborn" | "keeper_resting";
}

export interface QueueMessage {
  v: typeof PROTOCOL_VERSION;
  type: "queue";
  requestId: string;
  position: number;
  capacity: CapacityState;
  returningLife: boolean;
}

export interface LifeEndedMessage {
  v: typeof PROTOCOL_VERSION;
  type: "lifeEnded";
  requestId: string;
  lifeId: string;
  entityId: string;
  completedAt: number;
  ageText: string;
  memoryId: string;
  memory?: DomeMemory;
}

export interface LifeStartedMessage {
  v: typeof PROTOCOL_VERSION;
  type: "lifeStarted";
  requestId: string;
  life: CurrentLifeSummary;
  reincarnation: boolean;
}

export interface SharingAckMessage {
  v: typeof PROTOCOL_VERSION;
  type: "sharingAck";
  requestId: string;
  accepted: boolean;
  sharing: SharingSummary;
}

export interface PublicSoulContextMessage {
  v: typeof PROTOCOL_VERSION;
  type: "publicSoulContext";
  requestId: string;
  soul: PublicSoulView | null;
}

export interface PondLetterAckMessage {
  v: typeof PROTOCOL_VERSION;
  type: "pondLetterAck";
  requestId: string;
  accepted: boolean;
  preference: LetterPreferenceSummary;
  confirmationSent?: boolean;
  reason?: "invalid_email" | "rate_limited" | "not_configured" | "unchanged" | "suppressed" | "email_unavailable";
}

export interface KeeperUpdatedMessage {
  v: typeof PROTOCOL_VERSION;
  type: "keeperUpdated";
  requestId: string;
  keeper: KeeperSummary;
}

export interface PresenceMessage {
  v: typeof PROTOCOL_VERSION;
  type: "presence";
  requestId: string;
  connectedSouls: number;
  capacity: CapacityState;
}

export interface ErrorMessage {
  v: typeof PROTOCOL_VERSION;
  type: "error";
  requestId: string;
  code: "bad_message" | "rate_limited" | "not_ready" | "unauthorized" | "internal";
  message: string;
}

export type ServerMessage =
  | WelcomeMessage
  | SnapshotMessage
  | DeltaMessage
  | RitualAckMessage
  | QueueMessage
  | LifeStartedMessage
  | LifeEndedMessage
  | SharingAckMessage
  | PublicSoulContextMessage
  | PondLetterAckMessage
  | KeeperUpdatedMessage
  | PresenceMessage
  | ErrorMessage;

export interface ParseResult {
  ok: boolean;
  message?: ClientMessage;
  error?: string;
}

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{6,80}$/;
const PUBLIC_SOUL_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,94}[a-z0-9])?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPoint(value: unknown): value is NormalizedPoint {
  if (!isRecord(value)) return false;
  return Number.isFinite(value.x) && Number.isFinite(value.z)
    && Number(value.x) >= 0 && Number(value.x) <= 1
    && Number(value.z) >= 0 && Number(value.z) <= 1;
}

function isPublicSoulSlug(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= MAX_PUBLIC_SOUL_SLUG_LENGTH
    && PUBLIC_SOUL_SLUG_PATTERN.test(value);
}

function isPondLetterEmail(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_POND_LETTER_EMAIL_LENGTH) return false;
  const normalized = value.trim();
  return normalized.length >= 3
    && !/[\u0000-\u001f\u007f\s]/.test(normalized)
    && /^[^@]+@[^@]+\.[^@]+$/.test(normalized);
}

export function parseClientMessage(raw: string): ParseResult {
  if (new TextEncoder().encode(raw).byteLength > MAX_CLIENT_MESSAGE_BYTES) {
    return { ok: false, error: "message_too_large" };
  }
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { return { ok: false, error: "invalid_json" }; }
  if (!isRecord(value) || value.v !== PROTOCOL_VERSION || typeof value.type !== "string") {
    return { ok: false, error: "invalid_envelope" };
  }
  if (typeof value.requestId !== "string" || !REQUEST_ID_PATTERN.test(value.requestId)) {
    return { ok: false, error: "invalid_request_id" };
  }
  switch (value.type) {
    case "hello":
      if ((value.token !== undefined && (typeof value.token !== "string" || value.token.length > 256))
        || (value.renderer !== "webgl" && value.renderer !== "canvas")
        || typeof value.reducedMotion !== "boolean"
        || !Number.isFinite(value.clientTime)) return { ok: false, error: "invalid_hello" };
      break;
    case "incarnate":
      if (!isPoint(value.point)) return { ok: false, error: "invalid_point" };
      break;
    case "rippleBatch":
      if (!Array.isArray(value.points) || value.points.length < 1 || value.points.length > MAX_RIPPLE_BATCH_POINTS
        || !value.points.every(isPoint)) return { ok: false, error: "invalid_ripple_batch" };
      break;
    case "offer":
      if (!isPoint(value.point) || (value.offering !== "food" && value.offering !== "seed")) {
        return { ok: false, error: "invalid_offer" };
      }
      break;
    case "focus":
      if (value.entityId !== null && (typeof value.entityId !== "string" || value.entityId.length > 80)) {
        return { ok: false, error: "invalid_focus" };
      }
      break;
    case "setSharing":
      if (typeof value.enabled !== "boolean") return { ok: false, error: "invalid_sharing" };
      break;
    case "observePublicSoul":
    case "leavePublicRipple":
      if (!isPublicSoulSlug(value.slug)) return { ok: false, error: "invalid_public_soul" };
      break;
    case "setPondLetter": {
      const hasEmail = value.email !== undefined;
      const hasMortalPreference = value.mortalLetters !== undefined;
      const hasKeeperPreference = value.keeperLetters !== undefined;
      if ((!hasEmail && !hasMortalPreference && !hasKeeperPreference)
        || (hasEmail && !isPondLetterEmail(value.email))
        || (hasMortalPreference && typeof value.mortalLetters !== "boolean")
        || (hasKeeperPreference && typeof value.keeperLetters !== "boolean")) {
        return { ok: false, error: "invalid_pond_letter" };
      }
      break;
    }
    case "resendPondLetterConfirmation":
    case "unsubscribePondLetters":
    case "leave":
      break;
    default:
      return { ok: false, error: "unknown_type" };
  }
  return { ok: true, message: value as unknown as ClientMessage };
}

export function clampNormalizedPoint(point: NormalizedPoint, inset = 0.04): NormalizedPoint {
  const dx = point.x - 0.5;
  const dz = point.z - 0.5;
  const radius = Math.hypot(dx, dz);
  const maxRadius = 0.5 - Math.max(0, Math.min(0.2, inset));
  if (radius <= maxRadius || radius === 0) return { x: point.x, z: point.z };
  const scale = maxRadius / radius;
  return { x: 0.5 + dx * scale, z: 0.5 + dz * scale };
}

export function orbitPhaseAt(serverTime: number, epoch: number, periodMs = ORBIT_PERIOD_MS): number {
  const elapsed = ((serverTime - epoch) % periodMs + periodMs) % periodMs;
  return elapsed / periodMs;
}

export function hashString32(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

export function poeticAge(startedAt: number, endedAt: number): string {
  const minutes = Math.max(1, Math.round((endedAt - startedAt) / 60000));
  if (minutes < 60) return minutes === 1 ? "one quiet minute" : `${minutes} quiet minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return hours === 1 ? "one turning hour" : `${hours} turning hours`;
  const days = Math.max(1, Math.round(hours / 24));
  return days === 1 ? "one passage of daylight" : `${days} passages of daylight`;
}

export function makeRequestId(prefix = "req"): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
