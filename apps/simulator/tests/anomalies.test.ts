import { describe, expect, it } from "vitest";
import { injectAnomalies } from "../src/generators/anomalies.js";
import { createDailyMetrics, createTrainingPlan, TEST_SEED } from "./fixtures.js";

function getDayOffset(startDate: string, targetDate: string): number {
  return Math.floor(
    (Date.parse(`${targetDate}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) / 86_400_000,
  );
}

describe("injectAnomalies", () => {
  it("injects exactly the three required deterministic anomaly types", () => {
    const plan = createTrainingPlan(TEST_SEED);
    const daily = createDailyMetrics(TEST_SEED);
    const first = injectAnomalies({
      trainingSessions: plan.sessions,
      recoveryMetrics: daily.recoveryMetrics,
      sleepSessions: daily.sleepSessions,
      nutritionLogs: daily.nutritionLogs,
      seed: TEST_SEED,
    });
    const second = injectAnomalies({
      trainingSessions: plan.sessions,
      recoveryMetrics: daily.recoveryMetrics,
      sleepSessions: daily.sleepSessions,
      nutritionLogs: daily.nutritionLogs,
      seed: TEST_SEED,
    });

    expect(first.anomalies).toHaveLength(3);
    expect(first.anomalies.map((anomaly) => anomaly.type).sort()).toEqual([
      "missed-session",
      "poor-sleep",
      "sick-day",
    ]);

    const dateSet = new Set(first.anomalies.map((anomaly) => anomaly.date));
    expect(dateSet.size).toBe(3);

    const sickDay = first.anomalies.find((anomaly) => anomaly.type === "sick-day")!;
    const missedSessionDay = first.anomalies.find((anomaly) => anomaly.type === "missed-session")!;

    expect(sickDay.date).not.toBe(missedSessionDay.date);

    for (const anomaly of first.anomalies) {
      const offset = getDayOffset(plan.trainingBlock.startDate, anomaly.date);
      expect(offset).toBeGreaterThanOrEqual(5);
      expect(offset).toBeLessThan(107);
    }

    const sickSession = first.trainingSessions.find((session) => session.sessionId === sickDay.sessionId);
    const missedSession = first.trainingSessions.find((session) => session.sessionId === missedSessionDay.sessionId);

    expect(sickSession?.status).toBe("missed");
    expect(sickSession?.rpe).toBeNull();
    expect(missedSession?.status).toBe("missed");
    expect(missedSession?.rpe).toBeNull();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
