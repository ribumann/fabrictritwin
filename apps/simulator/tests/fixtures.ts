import type { Athlete, Race } from "../src/models/index.js";
import { generateDailyMetricsBundle } from "../src/generators/daily-metrics.js";
import { generatePeriodizedTrainingPlan } from "../src/generators/periodization.js";

export const TEST_SEED = 424_242;
export const TEST_REFERENCE_DATE = "2026-09-03";

export const TEST_ATHLETE: Athlete = {
  athleteId: "11111111-1111-4111-8111-111111111111",
  displayName: "Alex Triathlete",
  functionalThresholdPower: 268,
  thresholdPace: {
    swim: 1.72,
    bike: 9.6,
    run: 3.95,
  },
  restingHeartRate: 46,
  thresholdHeartRate: 178,
  createdAt: "2026-09-03T05:00:00.000Z",
};

export const TEST_RACE: Race = {
  raceId: "22222222-2222-4222-8222-222222222222",
  athleteId: TEST_ATHLETE.athleteId,
  name: "Seattle Seafair Olympic Triathlon",
  date: "2026-09-06",
  distance: "olympic",
  goalTimeSeconds: 8_550,
  status: "upcoming",
  predictedFinishTimeSeconds: null,
  actualFinishTimeSeconds: null,
  pacingEvennessStdDev: null,
};

export function createTrainingPlan(seed = TEST_SEED) {
  return generatePeriodizedTrainingPlan({
    athleteId: TEST_ATHLETE.athleteId,
    goalRaceId: TEST_RACE.raceId,
    referenceDate: TEST_REFERENCE_DATE,
    seed,
  });
}

export function createDailyMetrics(seed = TEST_SEED) {
  const plan = createTrainingPlan(seed);

  return generateDailyMetricsBundle({
    athleteId: TEST_ATHLETE.athleteId,
    startDate: plan.trainingBlock.startDate,
    endDate: plan.trainingBlock.endDate,
    sessions: plan.sessions,
    seed,
  });
}
