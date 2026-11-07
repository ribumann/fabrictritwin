export interface ToolErrorResponse {
  [key: string]: unknown;
  error: string;
}

export interface RecoveryTrendPoint {
  [key: string]: unknown;
  date: string;
  recoveryScore: number;
  sleepDebtMinutes: number;
  hrv: number;
}

export interface RecoveryTrendResponse {
  [key: string]: unknown;
  trend: RecoveryTrendPoint[];
}

export interface TrainingLoadSession {
  [key: string]: unknown;
  sessionId: string;
  date: string;
  discipline: string;
  durationMinutes: number;
  rpe: number;
  maxHeartRate: number;
}

export interface TrainingLoadResponse {
  [key: string]: unknown;
  currentPhase: "Base" | "Build" | "Peak" | "Taper";
  acwr: number;
  recentSessions: TrainingLoadSession[];
}

export interface ActiveAlertItem {
  [key: string]: unknown;
  alertId: string;
  type: string;
  raisedAt: string;
  detail: string;
}

export interface ActiveAlertsToolResponse {
  [key: string]: unknown;
  alerts: ActiveAlertItem[];
}

export interface RaceSplitItem {
  [key: string]: unknown;
  leg: string;
  timestamp: string;
  currentPaceSecPerKm: number;
  plannedPaceSecPerKm: number;
  currentHeartRate: number;
}

export interface RaceSplitsResponse {
  [key: string]: unknown;
  splits: RaceSplitItem[];
  projectedFinishTimeSeconds: number;
}
