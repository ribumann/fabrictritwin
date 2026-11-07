import type { IsoDate, IsoDateTime, TrainingSessionSource } from "./common.js";

/**
 * The four phases that always partition a seeded training block.
 */
export type TrainingBlockPhaseType = "Base" | "Build" | "Peak" | "Taper";

/**
 * Supported training disciplines for seeded and live sessions.
 */
export type TrainingDiscipline = "swim" | "bike" | "run" | "strength";

/**
 * Lifecycle state for a training session.
 */
export type TrainingSessionStatus = "planned" | "live" | "completed" | "missed";

/**
 * A single 16-week periodized block tied to one goal race.
 */
export interface TrainingBlock {
  trainingBlockId: string;
  athleteId: string;
  startDate: IsoDate;
  endDate: IsoDate;
  goalRaceId: string;
}

/**
 * One contiguous phase within a training block.
 */
export interface TrainingBlockPhase {
  trainingBlockPhaseId: string;
  trainingBlockId: string;
  phase: TrainingBlockPhaseType;
  startDate: IsoDate;
  endDate: IsoDate;
}

/**
 * A planned or completed training session.
 */
export interface TrainingSession {
  sessionId: string;
  athleteId: string;
  trainingBlockId: string;
  discipline: TrainingDiscipline;
  plannedDate: IsoDateTime;
  plannedDurationMinutes: number;
  targetZone: string;
  status: TrainingSessionStatus;
  rpe: number | null;
  source: TrainingSessionSource;
}
