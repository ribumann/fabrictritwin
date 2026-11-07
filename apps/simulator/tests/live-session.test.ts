import { describe, expect, it } from "vitest";
import { generateLiveSessionMetrics } from "../src/generators/live-session.js";
import { TEST_ATHLETE, TEST_SEED } from "./fixtures.js";

describe("live session generation", () => {
  it("creates deterministic live-session telemetry with increasing timestamps and matching session metadata", () => {
    const first = generateLiveSessionMetrics({
      athleteId: TEST_ATHLETE.athleteId,
      discipline: "bike",
      plannedDate: "2026-09-03T06:30:00.000Z",
      seed: TEST_SEED,
      sampleCount: 12,
    });
    const second = generateLiveSessionMetrics({
      athleteId: TEST_ATHLETE.athleteId,
      discipline: "bike",
      plannedDate: "2026-09-03T06:30:00.000Z",
      seed: TEST_SEED,
      sampleCount: 12,
    });

    expect(first).toHaveLength(12);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.every((tick) => tick.session.status === "live")).toBe(true);
    expect(first.every((tick) => tick.session.source === "live")).toBe(true);
    expect(first[0]?.session.discipline).toBe("bike");
    expect(first.at(-1)?.isFinal).toBe(true);

    for (let index = 1; index < first.length; index += 1) {
      expect(Date.parse(first[index - 1]!.metric.timestamp)).toBeLessThan(
        Date.parse(first[index]!.metric.timestamp),
      );
      expect(first[index]!.metric.sessionId).toBe(first[0]!.session.sessionId);
    }

    expect(first.every((tick) => tick.metric.power !== null)).toBe(true);
    expect(first.every((tick) => tick.metric.heartRate >= 30 && tick.metric.heartRate <= 220)).toBe(true);
  });

  it("keeps non-bike live sessions power-free and bounded to plausible coordinates", () => {
    const samples = generateLiveSessionMetrics({
      athleteId: TEST_ATHLETE.athleteId,
      discipline: "run",
      plannedDate: "2026-09-03T06:10:00.000Z",
      seed: TEST_SEED,
      sampleCount: 10,
    });

    expect(samples.every((tick) => tick.metric.power === null)).toBe(true);
    expect(samples.every((tick) => tick.metric.latitude > 47.55 && tick.metric.latitude < 47.69)).toBe(true);
    expect(samples.every((tick) => tick.metric.longitude < -122.28 && tick.metric.longitude > -122.42)).toBe(true);
  });
});
