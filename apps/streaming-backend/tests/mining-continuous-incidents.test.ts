import { describe, expect, it } from "vitest";
import {
  replayContinuousIncidentSnapshot,
  type ContinuousIncidentSnapshot,
} from "../src/mining-incidents/continuous-replay.js";
import type {
  MiningReadingObservation,
  MiningStateObservation,
  MiningTag,
} from "../src/mining-incidents/evaluator.js";

const START = Date.parse("2026-01-01T00:00:00.000Z");
const RUN = "test-run";
const iso = (second: number) => new Date(START + second * 1000).toISOString();
const TAGS: MiningTag[] = [
  {
    tagId: "D01.B.crusher.vibration_rms",
    moduleId: "D01.B.crusher",
    scopeId: "B",
    unit: "mm/s",
    intervalSeconds: 30,
  },
  {
    tagId: "D01.B.crusher.bearing_temperature",
    moduleId: "D01.B.crusher",
    scopeId: "B",
    unit: "Cel",
    intervalSeconds: 60,
  },
];

type Observation = MiningReadingObservation | MiningStateObservation;

function observations(from: number, through: number, breachUntil: number): Observation[] {
  const rows: Observation[] = [];
  for (let second = from; second <= through; second += 30) {
    if (second % 60 === 0) {
      for (const scope of ["A", "B", "C", "shared"] as const) {
        rows.push({
          kind: "state",
          runId: RUN,
          eventId: `${scope}:${second}`,
          timestamp: iso(second),
          scopeId: scope,
          state: "running",
          scheduledRunning: true,
          sequence: second,
        });
      }
    }
    for (const tag of TAGS) {
      if (second === 0 || second % tag.intervalSeconds !== 0) continue;
      const breach = second >= from + 12 * 60 && second <= breachUntil;
      const temperature = tag.unit === "Cel";
      rows.push({
        kind: "reading",
        runId: RUN,
        eventId: `${tag.tagId}:${second}`,
        timestamp: iso(second),
        tagId: tag.tagId,
        value: breach ? (temperature ? 82 : 7) : temperature ? 55 : 2.4,
        unit: tag.unit,
        quality: "good",
        intervalSeconds: tag.intervalSeconds,
      });
    }
  }
  return rows;
}

function snapshot(asOf: number, rows: Observation[]): ContinuousIncidentSnapshot {
  return replayContinuousIncidentSnapshot({
    runId: RUN,
    runStartedAt: iso(0),
    asOf: iso(asOf),
    sourceObservedAt: iso(asOf + 30),
    tags: TAGS,
    observations: rows,
  });
}

describe("continuous incident event-time snapshot", () => {
  it("reports evidence-backed active bearing advisory after two hours without inventing history", () => {
    const end = 120 * 60;
    const result = snapshot(end, observations(end - 20 * 60, end, end));
    const bearing = result.advisories.find((row) => row.ruleId === "crusher-bearing");
    expect(result).toMatchObject({
      assessmentKind: "rolling-event-time-advisory",
      windowStart: iso(end - 20 * 60),
      asOf: iso(end),
      sourceObservedAt: iso(end + 30),
    });
    expect(bearing).toMatchObject({ scopeId: "B", severity: "high", verification: "verified" });
    expect(bearing?.evidence.length).toBeGreaterThan(0);
    expect(bearing).not.toHaveProperty("raisedAt");
    expect(bearing).not.toHaveProperty("incidentId");
  });

  it("withdraws a recovered snapshot without claiming a durable clear transition", () => {
    const end = 120 * 60;
    const result = snapshot(end, observations(end - 20 * 60, end, end - 4 * 60));
    expect(result.advisories.some((row) => row.ruleId === "crusher-bearing")).toBe(false);
    expect(result).not.toHaveProperty("transitions");
  });

  it("rejects evidence outside the selected owner and window instead of ignoring it", () => {
    const end = 120 * 60;
    const rows = observations(end - 20 * 60, end, end);
    expect(() => snapshot(end, [...rows, { ...rows[0], runId: "other-run" }])).toThrow(
      /selected run and window/,
    );
    expect(() => snapshot(end, [...rows, { ...rows[0], timestamp: iso(end + 1) }])).toThrow(
      /selected run and window/,
    );
  });

  it("rejects conflicting event identities and future snapshot times", () => {
    const end = 120 * 60;
    const rows = observations(end - 20 * 60, end, end);
    const reading = rows.find((row): row is MiningReadingObservation => row.kind === "reading")!;
    expect(() => snapshot(end, [...rows, { ...reading, value: reading.value + 1 }])).toThrow(
      /Conflicting mining event ID/,
    );
    expect(() =>
      replayContinuousIncidentSnapshot({
        runId: RUN,
        runStartedAt: iso(0),
        asOf: iso(end),
        sourceObservedAt: iso(end - 1),
        tags: TAGS,
        observations: rows,
      }),
    ).toThrow(/observed run-relative minute/);
  });
});
