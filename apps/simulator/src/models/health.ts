import type { HistoricalSource, IsoDate, IsoDateTime, NutritionLogSource } from "./common.js";

/**
 * Daily recovery metrics joined with training and nutrition analyses.
 */
export interface RecoveryMetrics {
  athleteId: string;
  date: IsoDate;
  hrv: number;
  restingHeartRate: number;
  sleepScore: number;
  bodyWeightKg: number;
  sorenessScore: number;
  source: HistoricalSource;
}

/**
 * Meal-level nutrition intake.
 */
export interface NutritionLog {
  athleteId: string;
  date: IsoDateTime;
  mealType: string;
  calories: number;
  carbsGrams: number;
  proteinGrams: number;
  fatGrams: number;
  hydrationMl: number;
  source: NutritionLogSource;
}

/**
 * Daily sleep totals and stage breakdown.
 */
export interface SleepSession {
  athleteId: string;
  date: IsoDate;
  totalSleepMinutes: number;
  deepSleepMinutes: number;
  remSleepMinutes: number;
  sleepScore: number;
  source: HistoricalSource;
}
