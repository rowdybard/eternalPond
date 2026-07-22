import {
  MAX_LIFESPAN_MS,
  MIN_LIFESPAN_MS,
  NEWBORN_REFUGE_MS,
  hashString32,
  mulberry32,
  type EntityKind,
  type EntityState,
  type LifeKind,
} from "@eternal-pond/shared";

export interface SimEntity extends EntityState {
  foreground: boolean;
  seed: number;
  updatedAt: number;
}

export interface CreateSoulFishInput {
  entityId: string;
  soulId: string;
  lifeId: string;
  label: string;
  x: number;
  z: number;
  tint: number;
  now: number;
  lifeKind?: LifeKind;
  memorialPhase?: "water" | "dome" | null;
  seed?: number;
}

const TAU = Math.PI * 2;

export const BIRD_PERCH_ANCHORS = [
  { x: 0.12, z: 0.12 }, { x: 0.88, z: 0.1 }, { x: 0.98, z: 0.62 },
  { x: 0.18, z: 0.94 }, { x: 0.02, z: 0.62 }, { x: 0.72, z: 0.97 },
] as const;

export const FROG_HABITAT_ANCHORS = [
  { x: 0.31, z: 0.35 }, { x: 0.69, z: 0.58 },
  { x: 0.97, z: 0.57 }, { x: 0.08, z: 0.72 },
  { x: 0.07, z: 0.08 }, { x: 0.94, z: 0.94 },
] as const;

export const LILY_BASELINE_ANCHORS = [
  { x: 0.28, z: 0.39 }, { x: 0.64, z: 0.34 }, { x: 0.72, z: 0.59 },
  { x: 0.42, z: 0.7 }, { x: 0.2, z: 0.57 },
] as const;

export function lifespanForSeed(seed: number): number {
  const random = mulberry32(seed ^ 0x9e3779b9);
  return MIN_LIFESPAN_MS + random() * (MAX_LIFESPAN_MS - MIN_LIFESPAN_MS);
}

export function createSoulFish(input: CreateSoulFishInput): SimEntity {
  const seed = input.seed ?? hashString32(input.entityId);
  const random = mulberry32(seed);
  const lifeKind = input.lifeKind ?? "mortal";
  const endsAt = lifeKind === "memorial" ? null : input.now + lifespanForSeed(seed);
  return {
    id: input.entityId,
    kind: "soulFish",
    soulId: input.soulId,
    lifeId: input.lifeId,
    label: input.label,
    x: input.x,
    z: input.z,
    depth: 0.2 + random() * 0.18,
    heading: random() * TAU,
    speed: 0.005 + random() * 0.0025,
    size: 0.78 + random() * 0.22,
    tint: input.tint,
    ageRatio: 0,
    bornAt: input.now,
    endsAt,
    refugeUntil: lifeKind === "mortal" ? input.now + NEWBORN_REFUGE_MS : null,
    lifeKind,
    memorialPhase: input.memorialPhase ?? (lifeKind === "memorial" ? "water" : null),
    state: {},
    foreground: true,
    seed,
    updatedAt: input.now,
  };
}

export function createWildEntity(kind: EntityKind, index: number, now: number): SimEntity {
  const seed = hashString32(`wild:${kind}:${index}`);
  const random = mulberry32(seed);
  const angle = random() * TAU;
  const radius = Math.sqrt(random()) * 0.38;
  const defaults = {
    wildFish: { depth: 0.28 + random() * 0.32, speed: 0.0035 + random() * 0.004, size: 0.45 + random() * 0.85 },
    legendaryPenguin: { depth: 0.16, speed: 0.003, size: 1.5 },
    lily: { depth: 0, speed: 0, size: 0.7 + random() * 0.45 },
    bird: { depth: -1, speed: 0.0015 + random() * 0.001, size: 1.1 },
    frog: { depth: 0, speed: 0.002 + random() * 0.001, size: 1 },
    soulFish: { depth: 0.25, speed: 0.005, size: 0.8 },
  }[kind];
  const palette = [0xf3b563, 0x61c8bf, 0xe67b82, 0x8fa9d8, 0xb5cf72, 0xd7a8d8];
  let x = 0.5 + Math.cos(angle) * radius;
  let z = 0.5 + Math.sin(angle) * radius;
  let state: SimEntity["state"] = {};
  if (kind === "lily") {
    const anchor = LILY_BASELINE_ANCHORS[index % LILY_BASELINE_ANCHORS.length];
    x = anchor?.x ?? x;
    z = anchor?.z ?? z;
    state = { source: "baseline" };
  } else if (kind === "bird") {
    const mode = (["circling", "foraging", "perched"] as const)[index % 3] ?? "circling";
    const targetAnchor = index % BIRD_PERCH_ANCHORS.length;
    state = { mode, targetAnchor };
    if (mode === "perched") {
      const anchor = BIRD_PERCH_ANCHORS[targetAnchor] ?? BIRD_PERCH_ANCHORS[0];
      x = anchor.x;
      z = anchor.z;
    } else {
      const movementRadius = mode === "foraging" ? 0.472 : 0.34 + ((seed >>> 6) % 55) / 1000;
      const movementAngle = (now / 1000) * (mode === "foraging" ? 0.018 + defaults.speed * 2 : 0.055 + defaults.speed * 6) + (seed % 6283) / 1000;
      x = 0.5 + Math.cos(movementAngle) * movementRadius;
      z = 0.5 + Math.sin(movementAngle) * movementRadius;
    }
  } else if (kind === "frog") {
    const mode = index % 2 === 0 ? "lily" as const : "shore" as const;
    const targetAnchor = mode === "lily" ? index % 2 : 2 + (index % 2);
    const anchor = FROG_HABITAT_ANCHORS[targetAnchor] ?? FROG_HABITAT_ANCHORS[0];
    x = anchor.x;
    z = anchor.z;
    state = { mode, growthScale: 1, feedCount: 0, targetAnchor };
  }
  return {
    id: `wild_${kind}_${index}`,
    kind,
    soulId: null,
    lifeId: null,
    label: null,
    x,
    z,
    depth: defaults.depth,
    heading: random() * TAU,
    speed: defaults.speed,
    size: defaults.size,
    tint: palette[index % palette.length] ?? 0x61c8bf,
    ageRatio: 0,
    bornAt: now,
    endsAt: kind === "legendaryPenguin" ? now + 4 * 60 * 1000 : null,
    refugeUntil: null,
    lifeKind: null,
    memorialPhase: null,
    state,
    foreground: true,
    seed,
    updatedAt: now,
  };
}

function wrapAngle(value: number): number {
  return ((value % TAU) + TAU) % TAU;
}

function shortestAngle(from: number, to: number): number {
  return ((to - from + Math.PI * 3) % TAU) - Math.PI;
}

export function advanceEntity(entity: SimEntity, sequence: number, dtSeconds: number, now: number): SimEntity {
  const next = { ...entity, state: { ...entity.state } };
  const safeDt = Math.max(0, Math.min(dtSeconds, 1));
  if (next.kind === "lily") {
    next.heading = wrapAngle(next.heading + 0.025 * safeDt);
  } else if (next.kind === "bird") {
    const mode = next.state.mode ?? "circling";
    const anchor = BIRD_PERCH_ANCHORS[(next.state.targetAnchor ?? 0) % BIRD_PERCH_ANCHORS.length] ?? BIRD_PERCH_ANCHORS[0];
    const transitionFrom = next.state.transitionFrom;
    const transitionTo = next.state.transitionTo;
    const transitionStartedAt = next.state.transitionStartedAt ?? 0;
    const transitionEndsAt = next.state.transitionEndsAt ?? 0;
    if (transitionFrom && transitionTo && now < transitionEndsAt) {
      const raw = Math.max(0, Math.min(1, (now - transitionStartedAt) / Math.max(1, transitionEndsAt - transitionStartedAt)));
      const eased = raw * raw * (3 - 2 * raw);
      next.x = transitionFrom.x + (transitionTo.x - transitionFrom.x) * eased;
      next.z = transitionFrom.z + (transitionTo.z - transitionFrom.z) * eased;
      next.heading = wrapAngle(Math.atan2(transitionTo.z - transitionFrom.z, transitionTo.x - transitionFrom.x));
    } else if (mode === "circling") {
      const radius = 0.34 + ((next.seed >>> 6) % 55) / 1000;
      const angle = (now / 1000) * (0.055 + next.speed * 6) + (next.seed % 6283) / 1000;
      next.x = 0.5 + Math.cos(angle) * radius;
      next.z = 0.5 + Math.sin(angle) * radius;
      next.heading = wrapAngle(angle + Math.PI / 2);
    } else if (mode === "foraging") {
      const angle = (now / 1000) * (0.018 + next.speed * 2) + (next.seed % 6283) / 1000;
      const radius = 0.472;
      next.x = 0.5 + Math.cos(angle) * radius;
      next.z = 0.5 + Math.sin(angle) * radius;
      next.heading = wrapAngle(angle + Math.PI / 2);
    } else {
      const approach = Math.min(1, safeDt * 1.8);
      next.heading = wrapAngle(Math.atan2(anchor.z - next.z, anchor.x - next.x));
      next.x += (anchor.x - next.x) * approach;
      next.z += (anchor.z - next.z) * approach;
    }
  } else if (next.kind === "frog") {
    const mode = next.state.mode ?? "floating";
    const anchor = FROG_HABITAT_ANCHORS[(next.state.targetAnchor ?? 0) % FROG_HABITAT_ANCHORS.length] ?? FROG_HABITAT_ANCHORS[0];
    const transitionFrom = next.state.transitionFrom;
    const transitionTo = next.state.transitionTo;
    const transitionStartedAt = next.state.transitionStartedAt ?? 0;
    const transitionEndsAt = next.state.transitionEndsAt ?? 0;
    if (transitionFrom && transitionTo && now < transitionEndsAt) {
      const raw = Math.max(0, Math.min(1, (now - transitionStartedAt) / Math.max(1, transitionEndsAt - transitionStartedAt)));
      const eased = raw * raw * (3 - 2 * raw);
      next.x = transitionFrom.x + (transitionTo.x - transitionFrom.x) * eased;
      next.z = transitionFrom.z + (transitionTo.z - transitionFrom.z) * eased;
      next.heading = wrapAngle(Math.atan2(transitionTo.z - transitionFrom.z, transitionTo.x - transitionFrom.x));
    } else if (mode === "swimming" || mode === "floating") {
      const wobble = Math.sin(now * 0.0007 + next.seed) * 0.11;
      next.heading = wrapAngle(next.heading + wobble * safeDt);
      next.x += Math.cos(next.heading) * next.speed * safeDt;
      next.z += Math.sin(next.heading) * next.speed * safeDt;
      const radius = Math.hypot(next.x - 0.5, next.z - 0.5);
      if (radius > 0.38) next.heading = wrapAngle(Math.atan2(0.5 - next.z, 0.5 - next.x));
    } else {
      const approach = Math.min(1, safeDt * (mode === "feeding" ? 0.35 : 0.75));
      next.heading = wrapAngle(Math.atan2(anchor.z - next.z, anchor.x - next.x));
      next.x += (anchor.x - next.x) * approach;
      next.z += (anchor.z - next.z) * approach;
    }
  } else {
    const noise = Math.sin((sequence + (next.seed & 1023)) * 0.031) * 0.24;
    next.heading = wrapAngle(next.heading + noise * safeDt);
    const dx = next.x - 0.5;
    const dz = next.z - 0.5;
    const radius = Math.hypot(dx, dz);
    if (radius > 0.39) {
      const inward = Math.atan2(-dz, -dx);
      const strength = Math.min(1, (radius - 0.39) / 0.06);
      next.heading = wrapAngle(next.heading + shortestAngle(next.heading, inward) * strength * 0.22);
    }
    next.x += Math.cos(next.heading) * next.speed * safeDt;
    next.z += Math.sin(next.heading) * next.speed * safeDt;
    const nextRadius = Math.hypot(next.x - 0.5, next.z - 0.5);
    if (nextRadius > 0.46) {
      const scale = 0.46 / nextRadius;
      next.x = 0.5 + (next.x - 0.5) * scale;
      next.z = 0.5 + (next.z - 0.5) * scale;
      next.heading = wrapAngle(Math.atan2(0.5 - next.z, 0.5 - next.x));
    }
  }
  if (next.bornAt !== null && next.endsAt !== null) {
    next.ageRatio = Math.max(0, Math.min(1, (now - next.bornAt) / (next.endsAt - next.bornAt)));
  }
  next.updatedAt = now;
  return next;
}

const SCHOOL_CELL_SIZE = 0.075;
const MAX_SCHOOL_NEIGHBORS = 12;

function schoolCellKey(x: number, z: number): string {
  return `${Math.floor(x / SCHOOL_CELL_SIZE)}:${Math.floor(z / SCHOOL_CELL_SIZE)}`;
}

function clampTurn(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value));
}

export function applySchooling(
  entities: Iterable<SimEntity>,
  sequence: number,
  dtSeconds: number,
  now: number,
): SimEntity[] {
  const ordered = [...entities].map((entity) => ({ ...entity })).sort((a, b) => a.id.localeCompare(b.id));
  const swimmers = ordered.filter((entity) => entity.kind === "soulFish" || entity.kind === "wildFish");
  const grid = new Map<string, SimEntity[]>();
  for (const fish of swimmers) {
    const key = schoolCellKey(fish.x, fish.z);
    const cell = grid.get(key) ?? [];
    cell.push(fish);
    grid.set(key, cell);
  }

  const safeDt = Math.max(0, Math.min(dtSeconds, 0.25));
  for (const fish of swimmers) {
    const cellX = Math.floor(fish.x / SCHOOL_CELL_SIZE);
    const cellZ = Math.floor(fish.z / SCHOOL_CELL_SIZE);
    const nearby: Array<{ fish: SimEntity; distance: number }> = [];
    for (let offsetX = -1; offsetX <= 1; offsetX++) {
      for (let offsetZ = -1; offsetZ <= 1; offsetZ++) {
        const cell = grid.get(`${cellX + offsetX}:${cellZ + offsetZ}`) ?? [];
        for (const candidate of cell) {
          if (candidate.id === fish.id) continue;
          const distance = Math.hypot(candidate.x - fish.x, candidate.z - fish.z);
          if (distance <= 0.095) nearby.push({ fish: candidate, distance });
        }
      }
    }
    nearby.sort((a, b) => a.distance - b.distance || a.fish.id.localeCompare(b.fish.id));
    const neighbors = nearby.slice(0, MAX_SCHOOL_NEIGHBORS);

    let desiredX = Math.cos(fish.heading) * 0.7;
    let desiredZ = Math.sin(fish.heading) * 0.7;
    if (neighbors.length > 0) {
      let alignmentX = 0;
      let alignmentZ = 0;
      let centerX = 0;
      let centerZ = 0;
      let separationX = 0;
      let separationZ = 0;
      for (const neighbor of neighbors) {
        alignmentX += Math.cos(neighbor.fish.heading);
        alignmentZ += Math.sin(neighbor.fish.heading);
        centerX += neighbor.fish.x;
        centerZ += neighbor.fish.z;
        if (neighbor.distance < 0.025 && neighbor.distance > 0.00001) {
          const pressure = (0.025 - neighbor.distance) / 0.025;
          separationX += ((fish.x - neighbor.fish.x) / neighbor.distance) * pressure;
          separationZ += ((fish.z - neighbor.fish.z) / neighbor.distance) * pressure;
        }
      }
      const inverseCount = 1 / neighbors.length;
      alignmentX *= inverseCount;
      alignmentZ *= inverseCount;
      centerX = centerX * inverseCount - fish.x;
      centerZ = centerZ * inverseCount - fish.z;
      const alignmentWeight = fish.kind === "wildFish" ? 0.28 : 0.16;
      desiredX += alignmentX * alignmentWeight + centerX * 2.2 + separationX * 0.52;
      desiredZ += alignmentZ * alignmentWeight + centerZ * 2.2 + separationZ * 0.52;
    }

    if (fish.kind === "wildFish") {
      const schoolIndex = (fish.seed >>> 5) % 7;
      const schoolPhase = now / 1000 * (0.0028 + schoolIndex * 0.00017) + schoolIndex * 0.91;
      const centerX = 0.5 + Math.cos(schoolPhase) * (0.1 + schoolIndex * 0.018);
      const centerZ = 0.5 + Math.sin(schoolPhase * 0.87) * (0.12 + schoolIndex * 0.014);
      desiredX += (centerX - fish.x) * 0.34;
      desiredZ += (centerZ - fish.z) * 0.34;
    }

    const desiredHeading = wrapAngle(Math.atan2(desiredZ, desiredX));
    const turnLimit = (fish.kind === "wildFish" ? 0.24 : 0.16) * safeDt;
    fish.heading = wrapAngle(fish.heading + clampTurn(shortestAngle(fish.heading, desiredHeading), turnLimit));

    const depthSeed = ((fish.seed >>> 11) % 1000) / 1000;
    const baseDepth = fish.kind === "soulFish" ? 0.2 + depthSeed * 0.2 : 0.25 + depthSeed * 0.34;
    const depthWave = Math.sin(now / 1000 * 0.045 + fish.seed * 0.0007 + sequence * 0.003) * 0.055;
    const targetDepth = Math.max(0.13, Math.min(0.68, baseDepth + depthWave));
    fish.depth += (targetDepth - fish.depth) * Math.min(1, safeDt * 0.22);
  }
  return ordered;
}

export function fastForwardEntity(entity: SimEntity, toTime: number): SimEntity {
  if (toTime <= entity.updatedAt) return { ...entity };
  if (entity.kind === "lily" || entity.kind === "frog" || entity.kind === "bird") {
    return { ...entity, state: { ...entity.state }, updatedAt: toTime };
  }
  const elapsedSeconds = (toTime - entity.updatedAt) / 1000;
  const seedAngle = (entity.seed % 6283) / 1000;
  const radius = 0.08 + ((entity.seed >>> 8) % 330) / 1000;
  const angularSpeed = 0.0005 + ((entity.seed >>> 16) % 80) / 100000;
  const angle = seedAngle + elapsedSeconds * angularSpeed;
  const next = {
    ...entity,
    x: 0.5 + Math.cos(angle) * radius,
    z: 0.5 + Math.sin(angle) * radius,
    heading: wrapAngle(angle + Math.PI / 2),
    updatedAt: toTime,
  };
  if (next.bornAt !== null && next.endsAt !== null) {
    next.ageRatio = Math.max(0, Math.min(1, (toTime - next.bornAt) / (next.endsAt - next.bornAt)));
  }
  return next;
}

export function canBePredated(entity: SimEntity, now: number): boolean {
  return entity.kind === "soulFish"
    && entity.lifeKind === "mortal"
    && entity.memorialPhase === null
    && (entity.refugeUntil === null || now >= entity.refugeUntil);
}

export function canPredate(entity: SimEntity): boolean {
  if (entity.lifeKind === "memorial") return false;
  return entity.kind === "wildFish" && entity.size >= 0.95;
}

export function applyFrogFeed(
  entity: SimEntity,
  now: number,
  mode: EntityState["state"]["mode"] = "floating",
  targetAnchor = 0,
): SimEntity {
  if (entity.kind !== "frog") return { ...entity, state: { ...entity.state } };
  const feedCount = (entity.state.feedCount ?? 0) + 1;
  return {
    ...entity,
    state: {
      ...entity.state,
      mode,
      targetAnchor,
      feedCount,
      growthScale: Math.min(3, 1 + feedCount * 0.3),
      nextActionAt: now + 3_000,
    },
    updatedAt: now,
  };
}

export function selectPredation(
  entities: Iterable<SimEntity>,
  sequence: number,
  now: number,
): Array<{ predatorId: string; preyId: string }> {
  if (sequence % 10 !== 0) return [];
  const ordered = [...entities].sort((a, b) => a.id.localeCompare(b.id));
  const prey = ordered.filter((entity) => canBePredated(entity, now));
  const results: Array<{ predatorId: string; preyId: string }> = [];
  const claimed = new Set<string>();
  for (const predator of ordered) {
    if (!canPredate(predator)) continue;
    let closest: SimEntity | null = null;
    let closestDistance = 0.018 + predator.size * 0.006;
    for (const candidate of prey) {
      if (claimed.has(candidate.id) || candidate.size >= predator.size) continue;
      const distance = Math.hypot(candidate.x - predator.x, candidate.z - predator.z);
      if (distance < closestDistance) {
        closest = candidate;
        closestDistance = distance;
      }
    }
    if (!closest) continue;
    const random = mulberry32(predator.seed ^ closest.seed ^ sequence);
    if (random() < 0.08) {
      claimed.add(closest.id);
      results.push({ predatorId: predator.id, preyId: closest.id });
    }
  }
  return results;
}

export function isNaturalLifeComplete(entity: SimEntity, now: number): boolean {
  return entity.lifeKind === "mortal" && entity.endsAt !== null && now >= entity.endsAt;
}

export function isLegendaryWindow(orbitPhase: number, ecologicalSignal: number): boolean {
  const alignment = Math.abs(Math.sin(orbitPhase * TAU * 3)) < 0.0075;
  return alignment && ecologicalSignal >= 0.55;
}
