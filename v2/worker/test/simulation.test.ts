import { describe, expect, it } from "vitest";
import {
  MAX_LIFESPAN_MS,
  MIN_LIFESPAN_MS,
  NEWBORN_REFUGE_MS,
  PROTOCOL_VERSION,
  orbitPhaseAt,
  parseClientMessage,
} from "@eternal-pond/shared";
import { insertReturningFirstFifo } from "../src/queue";
import {
  BIRD_PERCH_ANCHORS,
  FROG_HABITAT_ANCHORS,
  advanceEntity,
  applyFrogFeed,
  applySchooling,
  canBePredated,
  canPredate,
  createSoulFish,
  createWildEntity,
  fastForwardEntity,
  isLegendaryWindow,
  lifespanForSeed,
  selectPredation,
} from "../src/simulation";

describe("canonical simulation", () => {
  it("assigns deterministic two-to-seven-day mortal lives and refuge", () => {
    const now = 1_800_000_000_000;
    const first = createSoulFish({
      entityId: "entity-a",
      soulId: "soul-a",
      lifeId: "life-a",
      label: "Quiet Reed at Dawn",
      x: 0.4,
      z: 0.6,
      tint: 0x71c9bd,
      now,
      seed: 42,
    });
    const second = createSoulFish({
      entityId: "entity-b",
      soulId: "soul-b",
      lifeId: "life-b",
      label: "Silver Current by Moonlight",
      x: 0.6,
      z: 0.4,
      tint: 0xe7a8a4,
      now,
      seed: 42,
    });
    expect(first.endsAt).toBe(second.endsAt);
    expect((first.endsAt ?? 0) - now).toBeGreaterThanOrEqual(MIN_LIFESPAN_MS);
    expect((first.endsAt ?? 0) - now).toBeLessThanOrEqual(MAX_LIFESPAN_MS);
    expect(first.refugeUntil).toBe(now + NEWBORN_REFUGE_MS);
    expect(lifespanForSeed(42)).toBe(lifespanForSeed(42));
  });

  it("advances and fast-forwards deterministically", () => {
    const now = 1_800_000_000_000;
    const entity = createWildEntity("wildFish", 7, now);
    expect(advanceEntity(entity, 120, 0.1, now + 100)).toEqual(advanceEntity(entity, 120, 0.1, now + 100));
    expect(fastForwardEntity(entity, now + 86_400_000)).toEqual(fastForwardEntity(entity, now + 86_400_000));
  });

  it("keeps canonical birds in circling, shoreline, and perch roles without idle hovering", () => {
    const now = 1_800_000_000_000;
    const circling = createWildEntity("bird", 0, now);
    const foraging = createWildEntity("bird", 1, now);
    const perched = createWildEntity("bird", 2, now);
    expect([circling.state.mode, foraging.state.mode, perched.state.mode]).toEqual(["circling", "foraging", "perched"]);

    const movedCircle = advanceEntity(circling, 20, 0.1, now + 10_000);
    const movedShore = advanceEntity(foraging, 20, 0.1, now + 10_000);
    const heldPerch = advanceEntity(perched, 20, 0.1, now + 10_000);
    expect(Math.hypot(movedCircle.x - 0.5, movedCircle.z - 0.5)).toBeGreaterThan(0.33);
    expect(Math.hypot(movedShore.x - 0.5, movedShore.z - 0.5)).toBeCloseTo(0.472, 3);
    expect(heldPerch.x).toBeCloseTo(BIRD_PERCH_ANCHORS[2].x, 5);
    expect(heldPerch.z).toBeCloseTo(BIRD_PERCH_ANCHORS[2].z, 5);
    expect(movedCircle.heading).not.toBe(circling.heading);
    expect(movedShore.heading).not.toBe(foraging.heading);
  });

  it("keeps both canonical frogs in deterministic findable habitats", () => {
    const now = 1_800_000_000_000;
    const lilyFrog = createWildEntity("frog", 0, now);
    const shoreFrog = createWildEntity("frog", 1, now);
    expect(lilyFrog.state.mode).toBe("lily");
    expect(shoreFrog.state.mode).toBe("shore");
    expect({ x: lilyFrog.x, z: lilyFrog.z }).toEqual(FROG_HABITAT_ANCHORS[0]);
    expect({ x: shoreFrog.x, z: shoreFrog.z }).toEqual(FROG_HABITAT_ANCHORS[3]);
    expect(fastForwardEntity(lilyFrog, now + 60_000)).toEqual(fastForwardEntity(lilyFrog, now + 60_000));
  });

  it("schools nearby fish loosely while varying depth deterministically", () => {
    const now = 1_800_000_000_000;
    const first = { ...createWildEntity("wildFish", 10, now), x: 0.48, z: 0.5, heading: 0, depth: 0.3 };
    const second = { ...createWildEntity("wildFish", 11, now), x: 0.5, z: 0.5, heading: 0.9, depth: 0.3 };
    const third = { ...createWildEntity("wildFish", 12, now), x: 0.52, z: 0.5, heading: 1.05, depth: 0.3 };
    const result = applySchooling([third, first, second], 220, 0.1, now + 100);
    expect(result).toEqual(applySchooling([third, first, second], 220, 0.1, now + 100));
    const updatedFirst = result.find((entity) => entity.id === first.id);
    expect(updatedFirst?.heading).toBeGreaterThan(first.heading);
    expect(updatedFirst?.depth).not.toBe(first.depth);
  });

  it("keeps newborn and memorial fish outside predation", () => {
    const now = 1_800_000_000_000;
    const newborn = createSoulFish({
      entityId: "newborn",
      soulId: "soul",
      lifeId: "life",
      label: "Tender Rain after Rain",
      x: 0.5,
      z: 0.5,
      tint: 0x71c9bd,
      now,
    });
    const memorial = createSoulFish({
      entityId: "memorial",
      soulId: "soul-m",
      lifeId: "life-m",
      label: "Still Lily at Rest",
      x: 0.5,
      z: 0.5,
      tint: 0xe8c477,
      now,
      lifeKind: "memorial",
      memorialPhase: "water",
    });
    expect(canBePredated(newborn, now + 1000)).toBe(false);
    expect(canBePredated(memorial, now + 20_000_000)).toBe(false);
    expect(canPredate(memorial)).toBe(false);
    expect(memorial.endsAt).toBeNull();
  });

  it("allows deterministic predation after refuge", () => {
    const now = 1_800_000_000_000;
    const predator = { ...createWildEntity("wildFish", 1, now), x: 0.5, z: 0.5, size: 1.4 };
    const prey = {
      ...createSoulFish({
        entityId: "adult-prey",
        soulId: "adult-soul",
        lifeId: "adult-life",
        label: "Mossy Pool under Glass",
        x: 0.501,
        z: 0.501,
        tint: 0x71c9bd,
        now: now - NEWBORN_REFUGE_MS - 1,
      }),
      refugeUntil: now - 1,
      size: 0.7,
    };
    let selected = false;
    for (let sequence = 10; sequence <= 5000; sequence += 10) {
      if (selectPredation([predator, prey], sequence, now).length > 0) {
        selected = true;
        break;
      }
    }
    expect(selected).toBe(true);
  });

  it("prioritizes returning lives while preserving FIFO order", () => {
    const queue: Array<{ id: string; returningLife: boolean }> = [];
    insertReturningFirstFifo(queue, { id: "birth-a", returningLife: false });
    insertReturningFirstFifo(queue, { id: "return-a", returningLife: true });
    insertReturningFirstFifo(queue, { id: "birth-b", returningLife: false });
    insertReturningFirstFifo(queue, { id: "return-b", returningLife: true });
    expect(queue.map((entry) => entry.id)).toEqual(["return-a", "return-b", "birth-a", "birth-b"]);
  });

  it("derives shared orbit and rare alignment deterministically", () => {
    const epoch = 1_800_000_000_000;
    expect(orbitPhaseAt(epoch + 30 * 60 * 1000, epoch)).toBeCloseTo(0.5);
    expect(isLegendaryWindow(0, 0.8)).toBe(true);
    expect(isLegendaryWindow(0.12, 0.8)).toBe(false);
    expect(isLegendaryWindow(0, 0.2)).toBe(false);
  });

  it("grows canonical frogs by 0.3 per synchronized catch and caps them at 3x", () => {
    const now = 1_800_000_000_000;
    let frog = createWildEntity("frog", 0, now);
    frog = applyFrogFeed(frog, now + 1000, "lily", 2);
    expect(frog.state.feedCount).toBe(1);
    expect(frog.state.growthScale).toBeCloseTo(1.3);
    expect(frog.state.mode).toBe("lily");
    for (let index = 0; index < 12; index++) frog = applyFrogFeed(frog, now + 2000 + index);
    expect(frog.state.feedCount).toBe(13);
    expect(frog.state.growthScale).toBe(3);
    const replacement = createWildEntity("frog", 0, now + 20_000);
    expect(replacement.state.feedCount).toBe(0);
    expect(replacement.state.growthScale).toBe(1);
  });

  it("accepts bounded protocol-v3 ripple batches and rejects oversized ones", () => {
    const base = {
      v: PROTOCOL_VERSION,
      type: "rippleBatch",
      requestId: "ripples_test_01",
    };
    const accepted = parseClientMessage(JSON.stringify({ ...base, points: Array.from({ length: 12 }, () => ({ x: 0.5, z: 0.5 })) }));
    const rejected = parseClientMessage(JSON.stringify({ ...base, points: Array.from({ length: 13 }, () => ({ x: 0.5, z: 0.5 })) }));
    expect(accepted.ok).toBe(true);
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toBe("invalid_ripple_batch");
  });
});
