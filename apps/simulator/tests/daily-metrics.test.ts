import { describe, expect, it } from "vitest";
import { createDailyMetrics, createTrainingPlan } from "./fixtures.js";

describe("daily metrics generators", () => {
  it("creates exactly one recovery row and one sleep row per day plus multiple nutrition logs", () => {
    const plan = createTrainingPlan();
    const { recoveryMetrics, sleepSessions, nutritionLogs } = createDailyMetrics();

    expect(recoveryMetrics).toHaveLength(112);
    expect(new Set(recoveryMetrics.map((metrics) => metrics.date)).size).toBe(112);
    expect(sleepSessions).toHaveLength(112);
    expect(new Set(sleepSessions.map((sleep) => sleep.date)).size).toBe(112);

    const nutritionCountByDay = new Map<string, number>();

    for (const log of nutritionLogs) {
      const date = log.date.slice(0, 10);
      nutritionCountByDay.set(date, (nutritionCountByDay.get(date) ?? 0) + 1);

      expect(log.carbsGrams).toBeGreaterThanOrEqual(0);
      expect(log.proteinGrams).toBeGreaterThanOrEqual(0);
      expect(log.fatGrams).toBeGreaterThanOrEqual(0);
      expect(log.calories).toBeGreaterThanOrEqual(0);
      expect(log.hydrationMl).toBeGreaterThanOrEqual(0);
    }

    expect(nutritionCountByDay.size).toBe(112);
    expect([...nutritionCountByDay.values()].every((count) => count >= 4)).toBe(true);
    expect(recoveryMetrics[0]?.date).toBe(plan.trainingBlock.startDate);
    expect(recoveryMetrics.at(-1)?.date).toBe(plan.trainingBlock.endDate);
  });

  it("is deterministic for a fixed seed", () => {
    const first = createDailyMetrics();
    const second = createDailyMetrics();

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
