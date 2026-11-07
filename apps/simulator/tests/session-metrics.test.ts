import { describe, expect, it } from "vitest";
import { injectAnomalies } from "../src/generators/anomalies.js";
import { createDailyMetrics, createTrainingPlan, TEST_SEED } from "./fixtures.js";
import { generateSessionMetrics, generateSessionMetricsForSessions } from "../src/generators/session-metrics.js";

describe("session metric generation", () => {
  it("produces increasing timestamps, null power for non-bike sessions, and no metrics for missed sessions", () => {
    const plan = createTrainingPlan(TEST_SEED);
    const daily = createDailyMetrics(TEST_SEED);
    const history = injectAnomalies({
      trainingSessions: plan.sessions,
      recoveryMetrics: daily.recoveryMetrics,
      sleepSessions: daily.sleepSessions,
      nutritionLogs: daily.nutritionLogs,
      seed: TEST_SEED,
    });

    const runSession = history.trainingSessions.find(
      (session) => session.discipline === "run" && session.status === "completed",
    )!;
    const runMetrics = generateSessionMetrics(runSession, { seed: TEST_SEED });

    expect(runMetrics.length).toBeGreaterThan(1);

    for (let index = 1; index < runMetrics.length; index += 1) {
      expect(Date.parse(runMetrics[index - 1]!.timestamp)).toBeLessThan(Date.parse(runMetrics[index]!.timestamp));
    }

    expect(runMetrics.every((metric) => metric.power === null)).toBe(true);

    const missedSessionIds = new Set(
      history.trainingSessions.filter((session) => session.status === "missed").map((session) => session.sessionId),
    );
    const allMetrics = generateSessionMetricsForSessions(history.trainingSessions, { seed: TEST_SEED });

    expect(allMetrics.every((metric) => !missedSessionIds.has(metric.sessionId))).toBe(true);
    expect(generateSessionMetrics(history.trainingSessions.find((session) => session.status === "missed")!, { seed: TEST_SEED })).toEqual([]);
  });

  it("is deterministic for a fixed seed", () => {
    const plan = createTrainingPlan(TEST_SEED);
    const bikeSession = plan.sessions.find(
      (session) => session.discipline === "bike" && session.status === "completed",
    )!;
    const first = generateSessionMetrics(bikeSession, { seed: TEST_SEED });
    const second = generateSessionMetrics(bikeSession, { seed: TEST_SEED });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
