import type { IsoDate, IsoDateTime } from "./common.js";

/**
 * Threshold pace values keyed by discipline.
 */
export interface ThresholdPace {
  swim: number;
  bike: number;
  run: number;
}

/**
 * Athlete profile seeded into the historical training twin.
 */
export interface Athlete {
  athleteId: string;
  displayName: string;
  functionalThresholdPower: number;
  thresholdPace: ThresholdPace;
  restingHeartRate: number;
  thresholdHeartRate: number;
  dateOfBirth?: IsoDate;
  createdAt: IsoDateTime;
}
