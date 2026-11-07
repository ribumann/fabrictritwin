import type { IsoDate, RaceDistance, RaceSplit } from "../models/index.js";
import { toUtcDate } from "./date-utils.js";
import { createSeededRandom, deriveSeed } from "./random.js";

const DEFAULT_RACE_DAY_SEED = 20_260_911;
const DEFAULT_RACE_SPLIT_COUNT = 48;

type RaceLeg = RaceSplit["leg"];

interface LegProfile {
  readonly leg: RaceLeg;
  readonly distanceMeters: number;
  readonly plannedPaceSecPerKm: number;
  readonly baseHeartRate: number;
  readonly heartRateRange: number;
}

const RACE_DISTANCE_PROFILES: Record<RaceDistance, readonly LegProfile[]> = {
  olympic: [
    {
      leg: "swim",
      distanceMeters: 1_500,
      plannedPaceSecPerKm: 108,
      baseHeartRate: 138,
      heartRateRange: 10,
    },
    {
      leg: "T1",
      distanceMeters: 250,
      plannedPaceSecPerKm: 360,
      baseHeartRate: 142,
      heartRateRange: 8,
    },
    {
      leg: "bike",
      distanceMeters: 40_000,
      plannedPaceSecPerKm: 97,
      baseHeartRate: 152,
      heartRateRange: 11,
    },
    {
      leg: "T2",
      distanceMeters: 180,
      plannedPaceSecPerKm: 320,
      baseHeartRate: 156,
      heartRateRange: 8,
    },
    {
      leg: "run",
      distanceMeters: 10_000,
      plannedPaceSecPerKm: 245,
      baseHeartRate: 163,
      heartRateRange: 9,
    },
  ],
  "70.3": [
    {
      leg: "swim",
      distanceMeters: 1_900,
      plannedPaceSecPerKm: 114,
      baseHeartRate: 136,
      heartRateRange: 10,
    },
    {
      leg: "T1",
      distanceMeters: 320,
      plannedPaceSecPerKm: 390,
      baseHeartRate: 141,
      heartRateRange: 8,
    },
    {
      leg: "bike",
      distanceMeters: 90_000,
      plannedPaceSecPerKm: 106,
      baseHeartRate: 148,
      heartRateRange: 11,
    },
    {
      leg: "T2",
      distanceMeters: 220,
      plannedPaceSecPerKm: 340,
      baseHeartRate: 154,
      heartRateRange: 8,
    },
    {
      leg: "run",
      distanceMeters: 21_097,
      plannedPaceSecPerKm: 270,
      baseHeartRate: 160,
      heartRateRange: 10,
    },
  ],
  full: [
    {
      leg: "swim",
      distanceMeters: 3_800,
      plannedPaceSecPerKm: 118,
      baseHeartRate: 134,
      heartRateRange: 9,
    },
    {
      leg: "T1",
      distanceMeters: 360,
      plannedPaceSecPerKm: 420,
      baseHeartRate: 139,
      heartRateRange: 7,
    },
    {
      leg: "bike",
      distanceMeters: 180_000,
      plannedPaceSecPerKm: 118,
      baseHeartRate: 145,
      heartRateRange: 10,
    },
    {
      leg: "T2",
      distanceMeters: 250,
      plannedPaceSecPerKm: 360,
      baseHeartRate: 151,
      heartRateRange: 7,
    },
    {
      leg: "run",
      distanceMeters: 42_195,
      plannedPaceSecPerKm: 305,
      baseHeartRate: 158,
      heartRateRange: 10,
    },
  ],
};

/**
 * Inputs for the race-day split generator.
 */
export interface RaceDayGeneratorOptions {
  raceId: string;
  date?: Date | IsoDate;
  distance?: RaceDistance;
  seed?: number;
  splitCount?: number;
}

/**
 * One high-frequency race split plus the continuously updated projected finish time.
 */
export interface RaceDayTick {
  split: RaceSplit;
  splitIndex: number;
  splitCount: number;
  projectedFinishTimeSeconds: number;
  isFinal: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Distributes `splitCount` splits across legs so that every leg (including short T1/T2
 * transitions) is guaranteed at least one split, with the remainder allocated proportionally to
 * each leg's share of total race distance (largest-remainder method so the allocation always sums
 * to exactly `splitCount`).
 */
function allocateSplitsPerLeg(legs: readonly LegProfile[], splitCount: number): number[] {
  const legCount = legs.length;
  const remaining = Math.max(0, splitCount - legCount);
  const totalDistanceMeters = legs.reduce((sum, leg) => sum + leg.distanceMeters, 0);
  const rawShares = legs.map((leg) => (leg.distanceMeters / totalDistanceMeters) * remaining);
  const wholeShares = rawShares.map((share) => Math.floor(share));
  const allocated = wholeShares.map((whole) => whole + 1);

  let leftover = remaining - wholeShares.reduce((sum, whole) => sum + whole, 0);
  const remainderOrder = rawShares
    .map((share, index) => ({ index, fraction: share - wholeShares[index]! }))
    .sort((a, b) => b.fraction - a.fraction);
  for (let i = 0; leftover > 0 && i < remainderOrder.length; i += 1, leftover -= 1) {
    allocated[remainderOrder[i]!.index] += 1;
  }

  return allocated;
}

/**
 * Splits a single leg's distance into `count` positive chunks that sum exactly to
 * `legDistanceMeters`, with light randomness for realism. The final chunk absorbs any rounding
 * remainder so the leg total is always exact.
 */
function splitLegDistance(
  legDistanceMeters: number,
  count: number,
  random: { next(): number },
): number[] {
  if (count === 1) {
    return [legDistanceMeters];
  }
  const weights = Array.from({ length: count }, () => 0.92 + random.next() * 0.18);
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const chunks = weights.map((weight) =>
    Math.max(1, Math.round((weight / weightSum) * legDistanceMeters)),
  );
  const roundedSum = chunks.reduce((sum, chunk) => sum + chunk, 0);
  chunks[count - 1] = Math.max(1, chunks[count - 1]! + (legDistanceMeters - roundedSum));
  return chunks;
}

/**
 * Creates deterministic high-frequency race splits. Each yielded value carries the current
 * projected finish time for FR-010 while the persisted `RaceSplit` payload remains aligned to the
 * domain model / Eventhouse schema. Splits are allocated per-leg (never crossing a leg boundary)
 * so every leg -- including short T1/T2 transitions -- always produces at least one split, and the
 * generator always yields exactly `splitCount` splits.
 */
export function* createRaceDayGenerator(
  options: RaceDayGeneratorOptions,
): Generator<RaceDayTick, void, void> {
  const distance = options.distance ?? "olympic";
  const legs = RACE_DISTANCE_PROFILES[distance];
  const splitCount = Math.max(
    legs.length,
    Math.trunc(options.splitCount ?? DEFAULT_RACE_SPLIT_COUNT),
  );
  const seed = deriveSeed(options.seed ?? DEFAULT_RACE_DAY_SEED, options.raceId);
  const random = createSeededRandom(seed);
  const baseDate = toUtcDate(options.date ?? new Date());
  const totalDistanceMeters = legs.reduce((sum, leg) => sum + leg.distanceMeters, 0);
  const perLegSplitCounts = allocateSplitsPerLeg(legs, splitCount);

  let elapsedSeconds = 0;
  let coveredMeters = 0;
  let globalSplitIndex = 0;

  for (let legIndex = 0; legIndex < legs.length; legIndex += 1) {
    const leg = legs[legIndex]!;
    const splitsInLeg = perLegSplitCounts[legIndex]!;
    const legDistanceChunks = splitLegDistance(leg.distanceMeters, splitsInLeg, random);
    let coveredInLeg = 0;

    for (let i = 0; i < splitsInLeg; i += 1) {
      const isFinalLeg = legIndex === legs.length - 1;
      const isFinalSplitInLeg = i === splitsInLeg - 1;
      const isFinal = isFinalLeg && isFinalSplitInLeg;
      const progress = globalSplitIndex / (splitCount - 1);

      const splitDistanceMeters = legDistanceChunks[i]!;
      coveredInLeg += splitDistanceMeters;
      coveredMeters = isFinal
        ? totalDistanceMeters
        : Math.min(totalDistanceMeters, coveredMeters + splitDistanceMeters);
      const legProgress = clamp(coveredInLeg / leg.distanceMeters, 0, 1);

      const fatigueFactor =
        progress * (leg.leg === "run" ? 0.08 : leg.leg === "bike" ? 0.05 : 0.03);
      const surge = Math.sin(progress * Math.PI * 4 + legIndex) * 0.02;
      const currentPaceSecPerKm = round(
        clamp(
          leg.plannedPaceSecPerKm * (1 + fatigueFactor + surge + (random.next() - 0.5) * 0.025),
          60,
          600,
        ),
        2,
      );
      const splitDurationSeconds = (splitDistanceMeters / 1_000) * currentPaceSecPerKm;
      elapsedSeconds += splitDurationSeconds;
      const remainingMeters = Math.max(0, totalDistanceMeters - coveredMeters);
      const projectedFinishTimeSeconds = isFinal
        ? round(elapsedSeconds, 2)
        : round(elapsedSeconds + (remainingMeters / 1_000) * currentPaceSecPerKm, 2);
      const currentHeartRate = clamp(
        Math.round(
          leg.baseHeartRate +
            leg.heartRateRange * (0.45 + 0.55 * legProgress) +
            progress * 10 +
            (random.next() - 0.5) * 4,
        ),
        30,
        220,
      );
      const timestamp = new Date(baseDate.getTime() + elapsedSeconds * 1_000).toISOString();

      yield {
        split: {
          raceId: options.raceId,
          timestamp,
          distanceCoveredMeters: coveredMeters,
          currentPaceSecPerKm,
          plannedPaceSecPerKm: leg.plannedPaceSecPerKm,
          currentHeartRate,
          leg: leg.leg,
          isFinish: isFinal,
        },
        splitIndex: globalSplitIndex,
        splitCount,
        projectedFinishTimeSeconds,
        isFinal,
      };

      globalSplitIndex += 1;
    }
  }
}

/**
 * Materializes the full race-day stream as an array, primarily for tests or batch-oriented
 * callers.
 */
export function generateRaceDaySplits(options: RaceDayGeneratorOptions): RaceDayTick[] {
  return [...createRaceDayGenerator(options)];
}

export { DEFAULT_RACE_DAY_SEED, DEFAULT_RACE_SPLIT_COUNT };
