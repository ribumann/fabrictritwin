import type { IsoDate, NutritionLog, RecoveryMetrics, SleepSession, TrainingSession } from "../models/index.js";
import { enumerateDates } from "./date-utils.js";
import { createSeededRandom, deriveSeed } from "./random.js";

const DEFAULT_ANOMALY_SEED = 20_260_905;
const EDGE_BUFFER_DAYS = 5;

/**
 * Supported seeded anomaly kinds.
 */
export type SeededAnomalyType = "poor-sleep" | "sick-day" | "missed-session";

/**
 * Metadata describing an injected anomaly.
 */
export interface InjectedAnomaly {
  type: SeededAnomalyType;
  date: IsoDate;
  sessionId?: string;
}

/**
 * Inputs to anomaly injection.
 */
export interface AnomalyInjectionInput {
  trainingSessions: readonly TrainingSession[];
  recoveryMetrics: readonly RecoveryMetrics[];
  sleepSessions: readonly SleepSession[];
  nutritionLogs?: readonly NutritionLog[];
  seed?: number;
}

/**
 * Outputs from anomaly injection.
 */
export interface AnomalyInjectionResult {
  trainingSessions: TrainingSession[];
  recoveryMetrics: RecoveryMetrics[];
  sleepSessions: SleepSession[];
  nutritionLogs: NutritionLog[];
  anomalies: InjectedAnomaly[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getSessionDate(session: TrainingSession): IsoDate {
  return session.plannedDate.slice(0, 10);
}

function getCandidateDates(recoveryMetrics: readonly RecoveryMetrics[]): IsoDate[] {
  if (recoveryMetrics.length === 0) {
    return [];
  }

  const orderedDates = enumerateDates(recoveryMetrics[0].date, recoveryMetrics[recoveryMetrics.length - 1].date);
  return orderedDates.slice(EDGE_BUFFER_DAYS, orderedDates.length - EDGE_BUFFER_DAYS);
}

function pickDistinctDate(randomSeed: number, candidates: readonly IsoDate[], excludedDates: ReadonlySet<IsoDate>): IsoDate {
  const available = candidates.filter((candidate) => !excludedDates.has(candidate));

  if (available.length === 0) {
    throw new Error("No eligible dates remain for anomaly injection.");
  }

  return createSeededRandom(randomSeed).pick(available);
}

/**
 * Injects exactly one poor sleep night, one sick day, and one separate missed session.
 */
export function injectAnomalies(input: AnomalyInjectionInput): AnomalyInjectionResult {
  const seed = input.seed ?? DEFAULT_ANOMALY_SEED;
  const trainingSessions = input.trainingSessions.map((session) => ({ ...session }));
  const recoveryMetrics = input.recoveryMetrics.map((metrics) => ({ ...metrics }));
  const sleepSessions = input.sleepSessions.map((sleep) => ({ ...sleep }));
  const nutritionLogs = (input.nutritionLogs ?? []).map((log) => ({ ...log }));
  const sessionsByDate = new Map<IsoDate, TrainingSession[]>();

  for (const session of trainingSessions) {
    const date = getSessionDate(session);
    const sessions = sessionsByDate.get(date) ?? [];
    sessions.push(session);
    sessionsByDate.set(date, sessions);
  }

  const safeDates = getCandidateDates(recoveryMetrics);
  const singleSessionDates = safeDates.filter((date) => (sessionsByDate.get(date)?.length ?? 0) === 1);

  if (singleSessionDates.length < 2 || safeDates.length < 3) {
    throw new Error("Insufficient seeded history to inject the required anomalies.");
  }

  const sickDate = pickDistinctDate(deriveSeed(seed, "sick-day"), singleSessionDates, new Set<IsoDate>());
  const missedSessionDate = pickDistinctDate(
    deriveSeed(seed, "missed-session"),
    singleSessionDates.filter((date) => date !== sickDate),
    new Set<IsoDate>([sickDate]),
  );
  const poorSleepDate = pickDistinctDate(
    deriveSeed(seed, "poor-sleep"),
    safeDates,
    new Set<IsoDate>([sickDate, missedSessionDate]),
  );

  const sickSession = sessionsByDate.get(sickDate)?.[0];
  const missedSession = sessionsByDate.get(missedSessionDate)?.[0];
  const sickRecovery = recoveryMetrics.find((metrics) => metrics.date === sickDate);
  const poorSleep = sleepSessions.find((sleep) => sleep.date === poorSleepDate);

  if (!sickSession || !missedSession || !sickRecovery || !poorSleep) {
    throw new Error("Unable to locate one or more anomaly targets in the generated history.");
  }

  const poorSleepRandom = createSeededRandom(deriveSeed(seed, "poor-sleep-values"));
  poorSleep.totalSleepMinutes = poorSleepRandom.int(255, 315);
  poorSleep.deepSleepMinutes = poorSleepRandom.int(32, 50);
  poorSleep.remSleepMinutes = poorSleepRandom.int(38, 55);
  poorSleep.sleepScore = poorSleepRandom.int(38, 52);

  const sickRandom = createSeededRandom(deriveSeed(seed, "sick-day-values"));
  sickRecovery.hrv = sickRandom.int(28, 40);
  sickRecovery.restingHeartRate = clamp(sickRecovery.restingHeartRate + sickRandom.int(10, 16), 30, 220);
  sickRecovery.sleepScore = sickRandom.int(42, 56);
  sickRecovery.sorenessScore = Number((7.8 + sickRandom.next() * 1.5).toFixed(1));
  sickSession.status = "missed";
  sickSession.rpe = null;

  missedSession.status = "missed";
  missedSession.rpe = null;

  return {
    trainingSessions,
    recoveryMetrics,
    sleepSessions,
    nutritionLogs,
    anomalies: [
      { type: "poor-sleep", date: poorSleepDate },
      { type: "sick-day", date: sickDate, sessionId: sickSession.sessionId },
      { type: "missed-session", date: missedSessionDate, sessionId: missedSession.sessionId },
    ],
  };
}

export { DEFAULT_ANOMALY_SEED, EDGE_BUFFER_DAYS };
