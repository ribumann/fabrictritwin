import type { IsoDate } from "./common.js";

/**
 * Supported race distances in the demo narrative.
 */
export type RaceDistance = "olympic" | "70.3" | "full";

/**
 * Current race state.
 */
export type RaceStatus = "completed" | "upcoming" | "live";

/**
 * Race metadata used by the seeded training block and later live simulations.
 */
export interface Race {
  raceId: string;
  athleteId: string;
  name: string;
  date: IsoDate;
  distance: RaceDistance;
  goalTimeSeconds: number;
  status: RaceStatus;
  predictedFinishTimeSeconds: number | null;
  actualFinishTimeSeconds: number | null;
  pacingEvennessStdDev: number | null;
}
