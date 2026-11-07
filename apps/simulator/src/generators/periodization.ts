import type {
  IsoDate,
  TrainingBlock,
  TrainingBlockPhase,
  TrainingBlockPhaseType,
  TrainingDiscipline,
  TrainingSession,
} from "../models/index.js";
import { addDays, formatDate, getInclusiveDayCount, toUtcDate, withUtcTime } from "./date-utils.js";
import { createSeededRandom, deriveSeed, nextUuid } from "./random.js";

const HISTORY_WINDOW_DAYS = 112;
const DEFAULT_PERIODIZATION_SEED = 20_260_903;

// Chosen split: 40% / 35% / 15% / 10% of 112 days, rounded to 45/39/17/11 so the 4 contiguous
// phases span the full 16-week block without gaps or overlaps.
const PHASE_DAY_SPLIT: ReadonlyArray<readonly [TrainingBlockPhaseType, number]> = [
  ["Base", 45],
  ["Build", 39],
  ["Peak", 17],
  ["Taper", 11],
];

interface SessionTemplate {
  readonly dayOfWeek: number;
  readonly discipline: TrainingDiscipline;
  readonly time: readonly [hour: number, minute: number];
  readonly durationMinutes: number;
  readonly workoutType: "technique" | "endurance" | "tempo" | "long" | "strength";
}

const WEEKLY_SESSION_TEMPLATES: readonly SessionTemplate[] = [
  { dayOfWeek: 2, discipline: "swim", time: [6, 15], durationMinutes: 55, workoutType: "technique" },
  { dayOfWeek: 3, discipline: "bike", time: [6, 30], durationMinutes: 90, workoutType: "endurance" },
  { dayOfWeek: 4, discipline: "run", time: [6, 10], durationMinutes: 55, workoutType: "tempo" },
  { dayOfWeek: 5, discipline: "swim", time: [6, 0], durationMinutes: 50, workoutType: "endurance" },
  { dayOfWeek: 5, discipline: "strength", time: [17, 30], durationMinutes: 40, workoutType: "strength" },
  { dayOfWeek: 6, discipline: "bike", time: [7, 0], durationMinutes: 150, workoutType: "long" },
  { dayOfWeek: 0, discipline: "run", time: [8, 0], durationMinutes: 85, workoutType: "long" },
] as const;

interface PhaseProfile {
  readonly durationMultiplier: number;
  readonly hardRpeOffset: number;
  readonly easyRpeOffset: number;
}

const PHASE_PROFILES: Record<TrainingBlockPhaseType, PhaseProfile> = {
  Base: { durationMultiplier: 1.0, hardRpeOffset: 0, easyRpeOffset: 0 },
  Build: { durationMultiplier: 1.08, hardRpeOffset: 1, easyRpeOffset: 1 },
  Peak: { durationMultiplier: 0.95, hardRpeOffset: 2, easyRpeOffset: 1 },
  Taper: { durationMultiplier: 0.62, hardRpeOffset: 1, easyRpeOffset: 0 },
};

/**
 * Options for generating a seeded 16-week training block.
 */
export interface PeriodizedTrainingPlanOptions {
  athleteId: string;
  goalRaceId: string;
  referenceDate?: Date | IsoDate;
  seed?: number;
}

/**
 * Deterministic seeded training-block output consumed by later seeding orchestration.
 */
export interface PeriodizedTrainingPlan {
  trainingBlock: TrainingBlock;
  phases: TrainingBlockPhase[];
  sessions: TrainingSession[];
}

/**
 * Generates a deterministic slice of sessions from an existing training block while preserving the
 * same RNG progression the full seeded-history generator would have used from the block start.
 */
export interface TrainingSessionDateRangeOptions {
  trainingBlock: TrainingBlock;
  phases: readonly TrainingBlockPhase[];
  startDate?: IsoDate;
  endDate?: IsoDate;
  seed?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveReferenceDate(referenceDate?: Date | IsoDate): IsoDate {
  return formatDate(toUtcDate(referenceDate ?? new Date()));
}

function getWeeklyLoadMultiplier(weekIndex: number): number {
  const cycleWeek = weekIndex % 4;

  if (cycleWeek === 3) {
    return 0.84;
  }

  return 1 + cycleWeek * 0.05;
}

function resolveTargetZone(
  phase: TrainingBlockPhaseType,
  workoutType: SessionTemplate["workoutType"],
): string {
  if (workoutType === "strength") {
    return phase === "Taper" ? "Z2" : "Z3";
  }

  if (workoutType === "technique") {
    return phase === "Peak" ? "Z3" : "Z2";
  }

  if (workoutType === "endurance") {
    return phase === "Base" ? "Z2" : phase === "Taper" ? "Z2" : "Z3";
  }

  if (workoutType === "tempo") {
    return phase === "Base" ? "Z3" : "Z4";
  }

  return phase === "Taper" ? "Z3" : phase === "Peak" ? "Z4" : "Z3";
}

function resolveRpe(
  template: SessionTemplate,
  phase: TrainingBlockPhaseType,
  randomJitter: number,
  isRecoveryWeek: boolean,
): number {
  const baseRpe =
    template.workoutType === "technique"
      ? 4
      : template.workoutType === "endurance"
        ? 5
        : template.workoutType === "tempo"
          ? 6
          : template.workoutType === "strength"
            ? 6
            : 7;

  const profile = PHASE_PROFILES[phase];
  const offset = template.workoutType === "technique" || template.workoutType === "endurance" ? profile.easyRpeOffset : profile.hardRpeOffset;
  const recoveryAdjustment = isRecoveryWeek ? -1 : 0;

  return clamp(baseRpe + offset + recoveryAdjustment + randomJitter, 3, 9);
}

function findPhaseForDate(phases: readonly TrainingBlockPhase[], date: IsoDate): TrainingBlockPhase {
  const phase = phases.find((candidate) => candidate.startDate <= date && candidate.endDate >= date);

  if (!phase) {
    throw new Error(`No phase found for date ${date}.`);
  }

  return phase;
}

/**
 * Creates the single seeded training block spanning the 16-week history window.
 */
export function generateTrainingBlock(options: PeriodizedTrainingPlanOptions): TrainingBlock {
  const referenceDate = resolveReferenceDate(options.referenceDate);
  const endDate = referenceDate;
  const startDate = formatDate(addDays(referenceDate, -(HISTORY_WINDOW_DAYS - 1)));
  const random = createSeededRandom(deriveSeed(options.seed ?? DEFAULT_PERIODIZATION_SEED, "training-block"));

  return {
    trainingBlockId: nextUuid(random),
    athleteId: options.athleteId,
    startDate,
    endDate,
    goalRaceId: options.goalRaceId,
  };
}

/**
 * Builds the 4 contiguous block phases required by the domain model.
 */
export function generateTrainingBlockPhases(
  trainingBlock: TrainingBlock,
  seed = DEFAULT_PERIODIZATION_SEED,
): TrainingBlockPhase[] {
  const random = createSeededRandom(deriveSeed(seed, "training-block-phases"));
  const phases: TrainingBlockPhase[] = [];
  let phaseStart = trainingBlock.startDate;

  for (const [phaseName, dayCount] of PHASE_DAY_SPLIT) {
    const phaseEnd = formatDate(addDays(phaseStart, dayCount - 1));

    phases.push({
      trainingBlockPhaseId: nextUuid(random),
      trainingBlockId: trainingBlock.trainingBlockId,
      phase: phaseName,
      startDate: phaseStart,
      endDate: phaseEnd,
    });

    phaseStart = formatDate(addDays(phaseEnd, 1));
  }

  return phases;
}

/**
 * Generates the completed historical training sessions that populate the seeded 16-week block.
 */
export function generateTrainingSessions(
  trainingBlock: TrainingBlock,
  phases: readonly TrainingBlockPhase[],
  seed = DEFAULT_PERIODIZATION_SEED,
): TrainingSession[] {
  if (getInclusiveDayCount(trainingBlock.startDate, trainingBlock.endDate) !== HISTORY_WINDOW_DAYS) {
    throw new Error(`Training block must span exactly ${HISTORY_WINDOW_DAYS} days.`);
  }

  return generateTrainingSessionsForDateRange({
    trainingBlock,
    phases,
    startDate: trainingBlock.startDate,
    endDate: trainingBlock.endDate,
    seed,
  });
}

/**
 * Generates a deterministic session subset for a caller-supplied date range, while still walking
 * the pseudo-random sequence from the original block start so later days remain consistent with the
 * seeded plan instead of "resetting" from a fresh window.
 */
export function generateTrainingSessionsForDateRange(options: TrainingSessionDateRangeOptions): TrainingSession[] {
  const rangeStartDate = options.startDate ?? options.trainingBlock.startDate;
  const rangeEndDate = options.endDate ?? options.trainingBlock.endDate;
  const blockStart = toUtcDate(options.trainingBlock.startDate);
  const requestedStart = toUtcDate(rangeStartDate);
  const requestedEnd = toUtcDate(rangeEndDate);
  const seed = options.seed ?? DEFAULT_PERIODIZATION_SEED;

  if (requestedStart.getTime() < blockStart.getTime()) {
    throw new Error("Requested session range cannot start before the training block start date.");
  }

  if (requestedEnd.getTime() < requestedStart.getTime()) {
    throw new Error("Requested session range end date must be on or after the start date.");
  }

  const sessionIdRandom = createSeededRandom(deriveSeed(seed, "training-session-ids"));
  const workoutRandom = createSeededRandom(deriveSeed(seed, "training-session-workouts"));
  const sessions: TrainingSession[] = [];
  let current = blockStart;

  for (let dayIndex = 0; current.getTime() <= requestedEnd.getTime(); dayIndex += 1) {
    const currentDate = formatDate(current);
    const dayOfWeek = toUtcDate(currentDate).getUTCDay();
    const phase = findPhaseForDate(options.phases, currentDate).phase;
    const weekIndex = Math.floor(dayIndex / 7);
    const weeklyLoadMultiplier = getWeeklyLoadMultiplier(weekIndex);
    const isRecoveryWeek = weekIndex % 4 === 3;

    for (const template of WEEKLY_SESSION_TEMPLATES) {
      if (template.dayOfWeek !== dayOfWeek) {
        continue;
      }

      const variation = 1 + (workoutRandom.next() - 0.5) * 0.14;
      const profile = PHASE_PROFILES[phase];
      const plannedDurationMinutes = Math.max(
        30,
        Math.round(template.durationMinutes * profile.durationMultiplier * weeklyLoadMultiplier * variation),
      );
      const rpe = resolveRpe(template, phase, workoutRandom.int(-1, 1), isRecoveryWeek);

      sessions.push({
        sessionId: nextUuid(sessionIdRandom),
        athleteId: options.trainingBlock.athleteId,
        trainingBlockId: options.trainingBlock.trainingBlockId,
        discipline: template.discipline,
        plannedDate: withUtcTime(currentDate, template.time[0], template.time[1]),
        plannedDurationMinutes,
        targetZone: resolveTargetZone(phase, template.workoutType),
        status: "completed",
        rpe,
        source: "seeded",
      });
    }

    current = addDays(current, 1);
  }

  return sessions.filter((session) => {
    const date = session.plannedDate.slice(0, 10);
    return date >= rangeStartDate && date <= rangeEndDate;
  });
}

/**
 * Generates the full seeded training plan for the 16-week historical window.
 */
export function generatePeriodizedTrainingPlan(options: PeriodizedTrainingPlanOptions): PeriodizedTrainingPlan {
  const trainingBlock = generateTrainingBlock(options);
  const phases = generateTrainingBlockPhases(trainingBlock, options.seed ?? DEFAULT_PERIODIZATION_SEED);
  const sessions = generateTrainingSessions(trainingBlock, phases, options.seed ?? DEFAULT_PERIODIZATION_SEED);

  return { trainingBlock, phases, sessions };
}

export { DEFAULT_PERIODIZATION_SEED, HISTORY_WINDOW_DAYS, PHASE_DAY_SPLIT };
