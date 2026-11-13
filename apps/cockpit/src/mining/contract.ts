/** Mining reads are independently authorized by the backend, never by athlete mappings. */
export type MiningQuality = "good" | "uncertain" | "bad" | "stale" | "missing";
export type MiningStatus = "normal" | "warning" | "high" | "stopped" | "unknown";
export type MiningMetric = "feed" | "density" | "vibration" | "water-energy";

export interface MiningReading {
  tagId: string;
  equipmentId: string;
  moduleId: string;
  value: number | null;
  unit: string;
  sampleTime: string | null;
  ingestionTime: string | null;
  quality: MiningQuality;
  ageSeconds: number | null;
  normalBand: [number, number] | null;
}

export interface MiningKpi {
  value: number | null;
  unit: string;
  coverage: number | null;
  quality: MiningQuality;
  windowStart: string;
  windowEnd: string;
}

export interface MiningRun {
  plantId: "D01";
  catalogVersion: string;
  runId: string;
  publisherStatus:
    | "admission_pending"
    | "admission_unknown"
    | "starting"
    | "running"
    | "publisher_complete"
    | "stop_requested"
    | "stopped"
    | "interrupted"
    | "failed";
  ingestionStatus: "pending" | "partial" | "complete" | "unknown";
}

export interface MiningContext {
  plantId: "D01";
  approvedRun: MiningRun | null;
  catalogVersion: string;
  readAvailable: boolean;
  unavailableReason?: string;
  assistant: { available: boolean; fabricUrl?: string };
  queries?: Partial<
    Record<
      "PlantLatest" | "PlantSummary" | "AssetTrend" | "ActiveIncidents" | "CompareLines",
      {
        text: string;
        fabricUrl?: string;
      }
    >
  >;
}

export interface MiningOverview {
  plantId: "D01";
  runId: string;
  catalogVersion: string;
  run: MiningRun;
  asOf: string;
  refreshedAt: string;
  quality: MiningQuality;
  latest: {
    modules: Array<{ moduleId: string; status: MiningStatus }>;
    readings: MiningReading[];
  };
  summary: {
    throughput: MiningKpi;
    runningLines: MiningKpi;
    grossProcessWaterIntensity: MiningKpi;
    energyIntensity: MiningKpi;
  };
}

export interface MiningSeries {
  plantId: "D01";
  runId: string;
  catalogVersion: string;
  moduleId: string | null;
  metric: MiningMetric;
  windowStart: string;
  windowEnd: string;
  binMinutes: 1 | 5;
  rows: Array<{
    timestamp: string;
    /** Exact canonical tag ID, retaining its catalog unit rather than a free-form label. */
    seriesId: string;
    value: number | null;
    unit: string;
    quality: MiningQuality;
    coverage: number | null;
  }>;
}

export interface MiningIncident {
  incidentId: string;
  ruleId: string;
  scopeId: string;
  moduleId: string;
  affectedModuleIds: string[];
  metric: MiningMetric;
  severity: "warning" | "high";
  title: string;
  raisedAt: string;
  clearedAt: string | null;
  acknowledgedAt: string | null;
  verification: "verified" | "unverified";
  holdWindowStart: string;
  holdWindowEnd: string;
  evidenceWindowStart: string;
  evidenceWindowEnd: string;
  evidence: MiningReading[];
}

export interface MiningIncidents {
  plantId: "D01";
  runId: string;
  catalogVersion: string;
  asOf: string;
  incidents: MiningIncident[];
}
