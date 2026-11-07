import { describe, expect, it } from "vitest";
import { generateRaceDaySplits } from "../src/generators/race-day.js";
import { TEST_RACE, TEST_SEED } from "./fixtures.js";

const ALL_RACE_DISTANCES = ["olympic", "70.3", "full"] as const;
const ALL_LEGS = ["swim", "T1", "bike", "T2", "run"] as const;

describe("race-day split generation", () => {
  it("creates deterministic, increasing race splits with a single terminal finish split", () => {
    const first = generateRaceDaySplits({
      raceId: TEST_RACE.raceId,
      date: TEST_RACE.date,
      distance: TEST_RACE.distance,
      seed: TEST_SEED,
      splitCount: 24,
    });
    const second = generateRaceDaySplits({
      raceId: TEST_RACE.raceId,
      date: TEST_RACE.date,
      distance: TEST_RACE.distance,
      seed: TEST_SEED,
      splitCount: 24,
    });

    expect(first).toHaveLength(24);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.filter((tick) => tick.split.isFinish)).toHaveLength(1);
    expect(first.at(-1)?.split.isFinish).toBe(true);
    expect(first.at(-1)?.isFinal).toBe(true);
    expect(first.at(-1)?.split.distanceCoveredMeters).toBeGreaterThan(first[0]!.split.distanceCoveredMeters);

    for (let index = 1; index < first.length; index += 1) {
      expect(Date.parse(first[index - 1]!.split.timestamp)).toBeLessThan(
        Date.parse(first[index]!.split.timestamp),
      );
      expect(first[index - 1]!.split.distanceCoveredMeters).toBeLessThanOrEqual(
        first[index]!.split.distanceCoveredMeters,
      );
    }
  });

  it("updates projected finish time during the race while keeping pace and heart rate plausible", () => {
    const ticks = generateRaceDaySplits({
      raceId: TEST_RACE.raceId,
      date: TEST_RACE.date,
      distance: TEST_RACE.distance,
      seed: TEST_SEED,
      splitCount: 18,
    });

    expect(new Set(ticks.map((tick) => tick.projectedFinishTimeSeconds)).size).toBeGreaterThan(1);
    expect(ticks.every((tick) => tick.projectedFinishTimeSeconds > 0)).toBe(true);
    expect(ticks.every((tick) => tick.split.currentPaceSecPerKm >= 60)).toBe(true);
    expect(ticks.every((tick) => tick.split.currentHeartRate >= 30 && tick.split.currentHeartRate <= 220)).toBe(
      true,
    );
  });

  it("always yields exactly the requested split count, never fewer (regression for race-6 producing 47/48)", () => {
    for (const distance of ALL_RACE_DISTANCES) {
      for (const splitCount of [5, 6, 12, 18, 24, 30, 48, 60]) {
        for (const seed of [TEST_SEED, TEST_SEED + 1, 12_345, 999_999]) {
          const ticks = generateRaceDaySplits({
            raceId: `${TEST_RACE.raceId}-${distance}-${splitCount}-${seed}`,
            date: TEST_RACE.date,
            distance,
            seed,
            splitCount,
          });

          expect(ticks).toHaveLength(splitCount);
        }
      }
    }
  });

  it("always produces at least one split per leg, including short T1/T2 transitions (regression for skipped legs)", () => {
    for (const distance of ALL_RACE_DISTANCES) {
      for (const splitCount of [5, 6, 12, 24, 48]) {
        for (const seed of [TEST_SEED, TEST_SEED + 1, 12_345, 999_999]) {
          const ticks = generateRaceDaySplits({
            raceId: `${TEST_RACE.raceId}-${distance}-${splitCount}-${seed}-legs`,
            date: TEST_RACE.date,
            distance,
            seed,
            splitCount,
          });

          const legsSeen = new Set(ticks.map((tick) => tick.split.leg));
          for (const leg of ALL_LEGS) {
            expect(legsSeen.has(leg)).toBe(true);
          }
        }
      }
    }
  });

  it("never crosses a leg boundary within a single split (each split's leg matches its distance range)", () => {
    const ticks = generateRaceDaySplits({
      raceId: TEST_RACE.raceId,
      date: TEST_RACE.date,
      distance: "olympic",
      seed: TEST_SEED,
      splitCount: 24,
    });

    // Olympic leg boundaries (cumulative meters): swim 1500, T1 1750, bike 41750, T2 41930, run 51930.
    const legBoundaries: Array<{ leg: (typeof ALL_LEGS)[number]; upperBoundMeters: number }> = [
      { leg: "swim", upperBoundMeters: 1_500 },
      { leg: "T1", upperBoundMeters: 1_750 },
      { leg: "bike", upperBoundMeters: 41_750 },
      { leg: "T2", upperBoundMeters: 41_930 },
      { leg: "run", upperBoundMeters: 51_930 },
    ];

    for (const tick of ticks) {
      const expectedBoundary = legBoundaries.find((boundary) => boundary.leg === tick.split.leg);
      expect(expectedBoundary).toBeDefined();
      expect(tick.split.distanceCoveredMeters).toBeLessThanOrEqual(expectedBoundary!.upperBoundMeters);
    }
  });
});
