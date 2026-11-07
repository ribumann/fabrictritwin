import type { SessionMetric, TrainingDiscipline, TrainingSession } from "../models/index.js";
import { toUtcDate } from "./date-utils.js";
import { createSeededRandom, deriveSeed } from "./random.js";

const DEFAULT_SESSION_METRICS_SEED = 20_260_906;
const DEFAULT_SAMPLE_INTERVAL_MINUTES = 1;
const BASE_LATITUDE = 47.6205;
const BASE_LONGITUDE = -122.3493;
const DEG_TO_RAD = Math.PI / 180;

interface DisciplineProfile {
  readonly baseHeartRate: number;
  readonly heartRateRange: number;
  readonly cadenceBase: number;
  readonly cadenceRange: number;
  readonly paceBase: number;
  readonly paceRange: number;
  readonly powerBase: number | null;
  readonly powerRange: number;
  readonly routeRadiusKm: number;
  readonly laps: number;
}

const DISCIPLINE_PROFILES: Record<TrainingDiscipline, DisciplineProfile> = {
  swim: {
    baseHeartRate: 110,
    heartRateRange: 34,
    cadenceBase: 31,
    cadenceRange: 5,
    paceBase: 1.45,
    paceRange: 0.3,
    powerBase: null,
    powerRange: 0,
    routeRadiusKm: 0.24,
    laps: 4,
  },
  bike: {
    baseHeartRate: 105,
    heartRateRange: 48,
    cadenceBase: 84,
    cadenceRange: 9,
    paceBase: 8.6,
    paceRange: 3.2,
    powerBase: 150,
    powerRange: 180,
    routeRadiusKm: 6.5,
    laps: 2,
  },
  run: {
    baseHeartRate: 118,
    heartRateRange: 42,
    cadenceBase: 170,
    cadenceRange: 8,
    paceBase: 3.0,
    paceRange: 1.0,
    powerBase: null,
    powerRange: 0,
    routeRadiusKm: 3.1,
    laps: 2,
  },
  strength: {
    baseHeartRate: 96,
    heartRateRange: 24,
    cadenceBase: 14,
    cadenceRange: 4,
    paceBase: 0.15,
    paceRange: 0.1,
    powerBase: null,
    powerRange: 0,
    routeRadiusKm: 0.04,
    laps: 1,
  },
};

/**
 * Options for generating synthetic session telemetry.
 */
export interface SessionMetricGeneratorOptions {
  seed?: number;
  sampleIntervalMinutes?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function getZoneIntensity(targetZone: string): number {
  switch (targetZone) {
    case "Z1":
      return 0.42;
    case "Z2":
      return 0.55;
    case "Z3":
      return 0.68;
    case "Z4":
      return 0.82;
    case "Z5":
      return 0.92;
    default:
      return 0.64;
  }
}

function getSampleCount(durationMinutes: number, sampleIntervalMinutes: number): number {
  return Math.max(2, Math.floor(durationMinutes / sampleIntervalMinutes) + 1);
}

/**
 * Generates telemetry rows for one completed session. Missed sessions intentionally produce no
 * metrics because the gap is itself the signal.
 */
export function generateSessionMetrics(
  session: TrainingSession,
  options: SessionMetricGeneratorOptions = {},
): SessionMetric[] {
  if (session.status !== "completed") {
    return [];
  }

  const sampleIntervalMinutes = options.sampleIntervalMinutes ?? DEFAULT_SAMPLE_INTERVAL_MINUTES;
  const seed = options.seed ?? DEFAULT_SESSION_METRICS_SEED;
  const sampleCount = getSampleCount(session.plannedDurationMinutes, sampleIntervalMinutes);
  const intensity = getZoneIntensity(session.targetZone);
  const profile = DISCIPLINE_PROFILES[session.discipline];
  const random = createSeededRandom(deriveSeed(seed, session.sessionId));
  const sessionOffsetLat = (random.next() - 0.5) * 0.02;
  const sessionOffsetLon = (random.next() - 0.5) * 0.02;
  const baseDate = toUtcDate(session.plannedDate);
  const longitudeScale = 111.32 * Math.cos((BASE_LATITUDE + sessionOffsetLat) * DEG_TO_RAD);
  const metrics: SessionMetric[] = [];

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const progress = sampleIndex / (sampleCount - 1);
    const effortCurve = Math.sin(progress * Math.PI);
    const intervalPulse =
      session.targetZone === "Z4" || session.targetZone === "Z5"
        ? Math.sin(progress * Math.PI * 5) * 0.08
        : 0;
    const fatigueDrift = progress * (session.discipline === "strength" ? 0.03 : 0.06);
    const heartRate = clamp(
      Math.round(
        profile.baseHeartRate +
          profile.heartRateRange * intensity * (0.6 + 0.4 * effortCurve + intervalPulse) +
          fatigueDrift * 20 +
          (random.next() - 0.5) * 4,
      ),
      30,
      220,
    );
    const cadence = round(
      clamp(
        profile.cadenceBase +
          profile.cadenceRange * intensity * (0.5 + 0.5 * effortCurve) +
          (random.next() - 0.5) * 3,
        0,
        session.discipline === "run" ? 200 : session.discipline === "bike" ? 110 : 45,
      ),
      1,
    );
    const pace = round(
      clamp(
        profile.paceBase +
          profile.paceRange * intensity * (0.55 + 0.45 * effortCurve + intervalPulse) -
          fatigueDrift * profile.paceRange * 0.15 +
          (random.next() - 0.5) * (session.discipline === "strength" ? 0.03 : 0.18),
        0,
        20,
      ),
      2,
    );
    const power =
      profile.powerBase === null
        ? null
        : round(
            clamp(
              profile.powerBase +
                profile.powerRange * intensity * (0.55 + 0.45 * effortCurve + intervalPulse) +
                (random.next() - 0.5) * 14,
              80,
              520,
            ),
            1,
          );
    const radiusKm =
      session.discipline === "strength"
        ? profile.routeRadiusKm
        : profile.routeRadiusKm * (0.7 + 0.3 * Math.sin(progress * Math.PI));
    const angle = progress * Math.PI * 2 * profile.laps;
    const latitude = round(
      BASE_LATITUDE + sessionOffsetLat + (radiusKm / 111.32) * Math.cos(angle),
      6,
    );
    const longitude = round(
      BASE_LONGITUDE + sessionOffsetLon + (radiusKm / longitudeScale) * Math.sin(angle),
      6,
    );
    const timestamp = new Date(
      baseDate.getTime() + sampleIndex * sampleIntervalMinutes * 60_000,
    ).toISOString();

    metrics.push({
      sessionId: session.sessionId,
      timestamp,
      heartRate,
      power,
      pace,
      cadence,
      latitude,
      longitude,
    });
  }

  return metrics;
}

/**
 * Generates telemetry rows for every completed session in a collection.
 */
export function generateSessionMetricsForSessions(
  sessions: readonly TrainingSession[],
  options: SessionMetricGeneratorOptions = {},
): SessionMetric[] {
  return sessions.flatMap((session) => generateSessionMetrics(session, options));
}

export { DEFAULT_SAMPLE_INTERVAL_MINUTES, DEFAULT_SESSION_METRICS_SEED };
