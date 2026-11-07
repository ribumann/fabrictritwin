import type { IsoDate, NutritionLog, RecoveryMetrics, SleepSession, TrainingSession } from "../models/index.js";
import { enumerateDates, getDatePortion, getInclusiveDayCount, withUtcTime } from "./date-utils.js";
import { createSeededRandom, deriveSeed } from "./random.js";

const DEFAULT_DAILY_METRICS_SEED = 20_260_904;
const DEFAULT_BODY_WEIGHT_KG = 72.5;

interface DailySessionSummary {
  readonly date: IsoDate;
  readonly sessionCount: number;
  readonly totalDurationMinutes: number;
  readonly totalTrainingLoad: number;
  readonly longestSessionMinutes: number;
}

/**
 * Shared options for daily historical metric generators.
 */
export interface DailyMetricsGeneratorOptions {
  athleteId: string;
  startDate: IsoDate;
  endDate: IsoDate;
  anchorStartDate?: IsoDate;
  sessions?: readonly TrainingSession[];
  seed?: number;
  baseBodyWeightKg?: number;
}

/**
 * Combined output of the daily historical generators.
 */
export interface DailyMetricsBundle {
  recoveryMetrics: RecoveryMetrics[];
  sleepSessions: SleepSession[];
  nutritionLogs: NutritionLog[];
}

interface SleepProfile {
  readonly totalSleepMinutes: number;
  readonly deepSleepMinutes: number;
  readonly remSleepMinutes: number;
  readonly sleepScore: number;
}

function estimateTrainingLoadRpe(session: TrainingSession): number {
  if (session.rpe !== null) {
    return session.rpe;
  }

  switch (session.targetZone) {
    case "Z1":
      return 3;
    case "Z2":
      return 4;
    case "Z3":
      return 6;
    case "Z4":
      return 7;
    case "Z5":
      return 8;
    default:
      return 5;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function buildSessionSummaryByDate(
  dates: readonly IsoDate[],
  sessions: readonly TrainingSession[] = [],
): Map<IsoDate, DailySessionSummary> {
  const summaryByDate = new Map<IsoDate, DailySessionSummary>(
    dates.map((date) => [
      date,
      {
        date,
        sessionCount: 0,
        totalDurationMinutes: 0,
        totalTrainingLoad: 0,
        longestSessionMinutes: 0,
      },
    ]),
  );

  for (const session of sessions) {
    const date = getDatePortion(session.plannedDate);
    const existing = summaryByDate.get(date);

    if (!existing) {
      continue;
    }

    summaryByDate.set(date, {
      date,
      sessionCount: existing.sessionCount + 1,
      totalDurationMinutes: existing.totalDurationMinutes + session.plannedDurationMinutes,
      totalTrainingLoad: existing.totalTrainingLoad + session.plannedDurationMinutes * estimateTrainingLoadRpe(session),
      longestSessionMinutes: Math.max(existing.longestSessionMinutes, session.plannedDurationMinutes),
    });
  }

  return summaryByDate;
}

function getBodyWeightKg(dayIndex: number, baseBodyWeightKg: number, seed: number): number {
  const random = createSeededRandom(deriveSeed(seed, `body-weight-${dayIndex}`));
  const slowTrend = Math.sin((dayIndex / 112) * Math.PI * 1.5) * 0.4;
  const noise = (random.next() - 0.5) * 0.5;

  return round(baseBodyWeightKg + slowTrend + noise, 1);
}

function getSleepProfile(dayIndex: number, summary: DailySessionSummary, seed: number): SleepProfile {
  const random = createSeededRandom(deriveSeed(seed, `sleep-${summary.date}`));
  const trainingBonus = Math.min(45, summary.totalDurationMinutes * 0.16);
  const totalSleepMinutes = clamp(
    Math.round(440 + trainingBonus + (Math.sin(dayIndex / 7) * 12 + (random.next() - 0.5) * 24)),
    400,
    540,
  );
  const deepSleepMinutes = clamp(
    Math.round(totalSleepMinutes * (0.19 + random.next() * 0.05)),
    65,
    120,
  );
  const remSleepMinutes = clamp(
    Math.round(totalSleepMinutes * (0.21 + random.next() * 0.05)),
    75,
    Math.max(75, totalSleepMinutes - deepSleepMinutes - 60),
  );
  const sleepScore = clamp(
    Math.round(72 + (totalSleepMinutes - 420) / 6 + (random.next() - 0.5) * 10),
    68,
    97,
  );

  return {
    totalSleepMinutes,
    deepSleepMinutes,
    remSleepMinutes,
    sleepScore,
  };
}

function getDailyCarbTargetPerKg(summary: DailySessionSummary): number {
  if (summary.totalTrainingLoad === 0) {
    return 4.3;
  }

  return clamp(4.8 + summary.totalDurationMinutes / 55 + summary.sessionCount * 0.2, 4.8, 8.6);
}

/**
 * Generates one recovery row per day across a date range.
 */
export function generateRecoveryMetrics(options: DailyMetricsGeneratorOptions): RecoveryMetrics[] {
  const seed = options.seed ?? DEFAULT_DAILY_METRICS_SEED;
  const dates = enumerateDates(options.startDate, options.endDate);
  const summaryByDate = buildSessionSummaryByDate(dates, options.sessions);
  const anchorStartDate = options.anchorStartDate ?? options.startDate;

  return dates.map((date) => {
    const dayIndex = getInclusiveDayCount(anchorStartDate, date) - 1;
    const summary = summaryByDate.get(date)!;
    const random = createSeededRandom(deriveSeed(seed, `recovery-${date}`));
    const sleepProfile = getSleepProfile(dayIndex, summary, seed);
    const bodyWeightKg = getBodyWeightKg(dayIndex, options.baseBodyWeightKg ?? DEFAULT_BODY_WEIGHT_KG, seed);
    const hrv = clamp(
      round(78 - summary.totalTrainingLoad / 115 + (random.next() - 0.5) * 7, 1),
      48,
      96,
    );
    const restingHeartRate = clamp(
      Math.round(45 + summary.totalTrainingLoad / 250 + (random.next() - 0.5) * 5),
      40,
      62,
    );
    const sorenessScore = clamp(
      round(2.4 + summary.totalDurationMinutes / 90 + (random.next() - 0.5) * 1.8, 1),
      1,
      8.5,
    );

    return {
      athleteId: options.athleteId,
      date,
      hrv,
      restingHeartRate,
      sleepScore: sleepProfile.sleepScore,
      bodyWeightKg,
      sorenessScore,
      source: "seeded",
    };
  });
}

/**
 * Generates one sleep row per day across a date range.
 */
export function generateSleepSessions(options: DailyMetricsGeneratorOptions): SleepSession[] {
  const seed = options.seed ?? DEFAULT_DAILY_METRICS_SEED;
  const dates = enumerateDates(options.startDate, options.endDate);
  const summaryByDate = buildSessionSummaryByDate(dates, options.sessions);
  const anchorStartDate = options.anchorStartDate ?? options.startDate;

  return dates.map((date) => {
    const dayIndex = getInclusiveDayCount(anchorStartDate, date) - 1;
    const summary = summaryByDate.get(date)!;
    const profile = getSleepProfile(dayIndex, summary, seed);

    return {
      athleteId: options.athleteId,
      date,
      totalSleepMinutes: profile.totalSleepMinutes,
      deepSleepMinutes: profile.deepSleepMinutes,
      remSleepMinutes: profile.remSleepMinutes,
      sleepScore: profile.sleepScore,
      source: "seeded",
    };
  });
}

/**
 * Generates multiple nutrition rows per day, scaled to the day's training demand.
 */
export function generateNutritionLogs(options: DailyMetricsGeneratorOptions): NutritionLog[] {
  const seed = options.seed ?? DEFAULT_DAILY_METRICS_SEED;
  const dates = enumerateDates(options.startDate, options.endDate);
  const summaryByDate = buildSessionSummaryByDate(dates, options.sessions);
  const anchorStartDate = options.anchorStartDate ?? options.startDate;
  const logs: NutritionLog[] = [];

  for (const date of dates) {
    const dayIndex = getInclusiveDayCount(anchorStartDate, date) - 1;
    const summary = summaryByDate.get(date)!;
    const random = createSeededRandom(deriveSeed(seed, `nutrition-${date}`));
    const bodyWeightKg = getBodyWeightKg(dayIndex, options.baseBodyWeightKg ?? DEFAULT_BODY_WEIGHT_KG, seed);
    const carbTargetPerKg = getDailyCarbTargetPerKg(summary);
    const totalCarbs = round(bodyWeightKg * carbTargetPerKg * (0.94 + random.next() * 0.12));
    const totalProtein = round(bodyWeightKg * (1.7 + Math.min(0.35, summary.totalDurationMinutes / 500)));
    const totalFat = round(clamp(65 + summary.totalDurationMinutes * 0.12 + (random.next() - 0.5) * 12, 55, 105));
    const totalHydrationMl = round(clamp(2200 + summary.totalDurationMinutes * 10 + summary.sessionCount * 180, 2200, 5200));

    const mealPlan = [
      { mealType: "breakfast", time: [7, 15], share: 0.24 },
      { mealType: "lunch", time: [12, 30], share: 0.28 },
      { mealType: "snack", time: [16, 0], share: 0.14 },
      { mealType: "dinner", time: [19, 15], share: 0.27 },
    ];

    if (summary.totalDurationMinutes >= 90) {
      mealPlan.push({ mealType: "recovery", time: [14, 30], share: 0.07 });
    }

    if (summary.longestSessionMinutes >= 135) {
      mealPlan.push({ mealType: "during-session", time: [9, 0], share: 0.1 });
    }

    const totalShare = mealPlan.reduce((sum, meal) => sum + meal.share, 0);

    for (const meal of mealPlan) {
      const normalizedShare = meal.share / totalShare;
      const carbsGrams = round(Math.max(0, totalCarbs * normalizedShare));
      const proteinGrams = round(Math.max(0, totalProtein * normalizedShare));
      const fatGrams = round(
        Math.max(
          0,
          totalFat * normalizedShare * (meal.mealType === "during-session" ? 0.25 : meal.mealType === "recovery" ? 0.6 : 1),
        ),
      );
      const hydrationMl = round(
        Math.max(
          0,
          totalHydrationMl * normalizedShare * (meal.mealType === "during-session" ? 1.35 : 1),
        ),
      );
      const calories = round(carbsGrams * 4 + proteinGrams * 4 + fatGrams * 9);

      logs.push({
        athleteId: options.athleteId,
        date: withUtcTime(date, meal.time[0], meal.time[1]),
        mealType: meal.mealType,
        calories,
        carbsGrams,
        proteinGrams,
        fatGrams,
        hydrationMl,
        source: "seeded",
      });
    }
  }

  return logs;
}

/**
 * Generates the full daily recovery, sleep, and nutrition bundle for a seeded history window.
 */
export function generateDailyMetricsBundle(options: DailyMetricsGeneratorOptions): DailyMetricsBundle {
  return {
    recoveryMetrics: generateRecoveryMetrics(options),
    sleepSessions: generateSleepSessions(options),
    nutritionLogs: generateNutritionLogs(options),
  };
}

export { DEFAULT_DAILY_METRICS_SEED };
