import type { IsoDateTime, SessionMetric, TrainingDiscipline, TrainingSession } from "../models/index.js";
import { toUtcDate } from "./date-utils.js";
import { createSeededRandom, deriveSeed, nextUuid } from "./random.js";

const DEFAULT_LIVE_SESSION_SEED = 20_260_910;
const DEFAULT_LIVE_SAMPLE_COUNT = 36;
const BASE_LATITUDE = 47.6205;
const BASE_LONGITUDE = -122.3493;
const DEG_TO_RAD = Math.PI / 180;

interface DisciplineProfile {
  readonly durationMinutes: number;
  readonly targetZone: string;
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
    durationMinutes: 48,
    targetZone: "Z2",
    baseHeartRate: 116,
    heartRateRange: 28,
    cadenceBase: 31,
    cadenceRange: 4,
    paceBase: 1.58,
    paceRange: 0.22,
    powerBase: null,
    powerRange: 0,
    routeRadiusKm: 0.22,
    laps: 5,
  },
  bike: {
    durationMinutes: 75,
    targetZone: "Z3",
    baseHeartRate: 112,
    heartRateRange: 38,
    cadenceBase: 86,
    cadenceRange: 8,
    paceBase: 9.1,
    paceRange: 2.4,
    powerBase: 182,
    powerRange: 96,
    routeRadiusKm: 6.8,
    laps: 2,
  },
  run: {
    durationMinutes: 52,
    targetZone: "Z3",
    baseHeartRate: 124,
    heartRateRange: 34,
    cadenceBase: 174,
    cadenceRange: 6,
    paceBase: 3.78,
    paceRange: 0.48,
    powerBase: null,
    powerRange: 0,
    routeRadiusKm: 3.4,
    laps: 2,
  },
  strength: {
    durationMinutes: 42,
    targetZone: "Z3",
    baseHeartRate: 102,
    heartRateRange: 22,
    cadenceBase: 14,
    cadenceRange: 4,
    paceBase: 0.12,
    paceRange: 0.08,
    powerBase: null,
    powerRange: 0,
    routeRadiusKm: 0.04,
    laps: 1,
  },
};

/**
 * Inputs for the live-session generator.
 */
export interface LiveSessionGeneratorOptions {
  athleteId: string;
  discipline: TrainingDiscipline;
  plannedDate?: Date | IsoDateTime;
  plannedDurationMinutes?: number;
  targetZone?: string;
  trainingBlockId?: string;
  sessionId?: string;
  seed?: number;
  sampleCount?: number;
}

/**
 * One generated live-session sample plus its surrounding session metadata.
 */
export interface LiveSessionTick {
  session: TrainingSession;
  metric: SessionMetric;
  sampleIndex: number;
  sampleCount: number;
  isFinal: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function buildLiveSession(options: LiveSessionGeneratorOptions): TrainingSession {
  const profile = DISCIPLINE_PROFILES[options.discipline];
  const idRandom = createSeededRandom(
    deriveSeed(options.seed ?? DEFAULT_LIVE_SESSION_SEED, `${options.athleteId}:${options.discipline}:session-id`),
  );

  return {
    sessionId: options.sessionId ?? nextUuid(idRandom),
    athleteId: options.athleteId,
    trainingBlockId: options.trainingBlockId ?? "live-session",
    discipline: options.discipline,
    plannedDate: toUtcDate(options.plannedDate ?? new Date()).toISOString(),
    plannedDurationMinutes: options.plannedDurationMinutes ?? profile.durationMinutes,
    targetZone: options.targetZone ?? profile.targetZone,
    status: "live",
    rpe: null,
    source: "live",
  };
}

/**
 * Creates a deterministic generator that yields one live-session metric at a time. The caller
 * controls wall-clock pacing (for example, emitting one yielded value every 1-2 seconds) while
 * the metric timestamps advance across the full planned session duration.
 */
export function* createLiveSessionGenerator(
  options: LiveSessionGeneratorOptions,
): Generator<LiveSessionTick, void, void> {
  const session = buildLiveSession(options);
  const sampleCount = Math.max(2, Math.trunc(options.sampleCount ?? DEFAULT_LIVE_SAMPLE_COUNT));
  const seed = deriveSeed(options.seed ?? DEFAULT_LIVE_SESSION_SEED, session.sessionId);
  const random = createSeededRandom(seed);
  const profile = DISCIPLINE_PROFILES[session.discipline];
  const sessionOffsetLat = (random.next() - 0.5) * 0.02;
  const sessionOffsetLon = (random.next() - 0.5) * 0.02;
  const baseDate = toUtcDate(session.plannedDate);
  const totalDurationMs = session.plannedDurationMinutes * 60_000;
  const longitudeScale = 111.32 * Math.cos((BASE_LATITUDE + sessionOffsetLat) * DEG_TO_RAD);

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const progress = sampleIndex / (sampleCount - 1);
    const effortCurve =
      session.discipline === "strength"
        ? Math.sin(progress * Math.PI * 3) * 0.3 + 0.7
        : Math.sin(progress * Math.PI) * 0.55 + 0.45;
    const surge =
      session.targetZone === "Z4" || session.targetZone === "Z5"
        ? Math.sin(progress * Math.PI * 6) * 0.07
        : Math.sin(progress * Math.PI * 2) * 0.03;
    const fatigueDrift = progress * (session.discipline === "swim" ? 0.05 : 0.08);
    const heartRate = clamp(
      Math.round(
        profile.baseHeartRate +
          profile.heartRateRange * (effortCurve + surge) +
          fatigueDrift * 18 +
          (random.next() - 0.5) * 4,
      ),
      30,
      220,
    );
    const cadence = round(
      clamp(
        profile.cadenceBase +
          profile.cadenceRange * (0.55 + 0.45 * effortCurve) +
          (random.next() - 0.5) * (session.discipline === "run" ? 3 : 2),
        0,
        session.discipline === "run" ? 200 : session.discipline === "bike" ? 110 : 45,
      ),
      1,
    );
    const pace = round(
      clamp(
        profile.paceBase +
          profile.paceRange * (0.45 + 0.55 * effortCurve + surge) +
          fatigueDrift * profile.paceRange * 0.22 +
          (random.next() - 0.5) * (session.discipline === "strength" ? 0.02 : 0.08),
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
                profile.powerRange * (0.5 + 0.5 * effortCurve + surge) +
                (random.next() - 0.5) * 10,
              80,
              520,
            ),
            1,
          );
    const radiusKm =
      session.discipline === "strength"
        ? profile.routeRadiusKm
        : profile.routeRadiusKm * (0.72 + 0.28 * Math.sin(progress * Math.PI));
    const angle = progress * Math.PI * 2 * profile.laps;
    const latitude = round(BASE_LATITUDE + sessionOffsetLat + (radiusKm / 111.32) * Math.cos(angle), 6);
    const longitude = round(
      BASE_LONGITUDE + sessionOffsetLon + (radiusKm / longitudeScale) * Math.sin(angle),
      6,
    );
    const timestamp = new Date(baseDate.getTime() + totalDurationMs * progress).toISOString();

    yield {
      session,
      metric: {
        sessionId: session.sessionId,
        timestamp,
        heartRate,
        power,
        pace,
        cadence,
        latitude,
        longitude,
      },
      sampleIndex,
      sampleCount,
      isFinal: sampleIndex === sampleCount - 1,
    };
  }
}

/**
 * Materializes the full live-session stream as an array, primarily for tests or batch-oriented
 * callers.
 */
export function generateLiveSessionMetrics(options: LiveSessionGeneratorOptions): LiveSessionTick[] {
  return [...createLiveSessionGenerator(options)];
}

export { DEFAULT_LIVE_SAMPLE_COUNT, DEFAULT_LIVE_SESSION_SEED };
