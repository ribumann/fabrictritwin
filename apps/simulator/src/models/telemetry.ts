import type { IsoDateTime } from "./common.js";

/**
 * Per-sample telemetry recorded for a completed or live session.
 */
export interface SessionMetric {
  sessionId: string;
  timestamp: IsoDateTime;
  heartRate: number;
  power: number | null;
  pace: number;
  cadence: number;
  latitude: number;
  longitude: number;
}

/**
 * High-frequency split telemetry recorded for a live or completed race simulation.
 */
export interface RaceSplit {
  raceId: string;
  timestamp: IsoDateTime;
  distanceCoveredMeters: number;
  currentPaceSecPerKm: number;
  plannedPaceSecPerKm: number;
  currentHeartRate: number;
  leg: "swim" | "T1" | "bike" | "T2" | "run";
  isFinish: boolean;
}
