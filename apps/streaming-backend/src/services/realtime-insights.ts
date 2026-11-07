import { createHash } from "node:crypto";
import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";
import {
  Client as KustoClient,
  ClientRequestProperties,
  KustoConnectionStringBuilder,
} from "azure-kusto-data";
import { resolveRuntimeProfile } from "./runtime-profile.js";
import { SyntheticInsightsService, type SyntheticProvenance } from "./synthetic-insights.js";

export interface AthleteAnalysesResponse {
  provenance?: SyntheticProvenance;
  acuteChronicWorkloadRatio: number | null;
  recoveryScore: number | null;
  nutritionAdequacy: number | null;
  sleepDebtMinutes: number | null;
  taperIndex: number | null;
  asOf: string | null;
}

export type AlertType =
  "sustained-high-hr" | "acwr" | "missed-session" | "race-pace-drift" | "fueling-shortfall";

export interface ActiveAlert {
  alertId: string;
  type: AlertType;
  raisedAt: string;
  detail: string;
  context: Record<string, boolean | number | string | null>;
}

export interface ActiveAlertsResponse {
  alerts: ActiveAlert[];
  provenance?: SyntheticProvenance;
}

export interface AthleteAnalysesService {
  getAnalyses(athleteId: string): Promise<AthleteAnalysesResponse>;
}

export interface ActiveAlertsService {
  getActiveAlerts(athleteId: string): Promise<ActiveAlertsResponse>;
}

export interface RealtimeInsightsService extends AthleteAnalysesService, ActiveAlertsService {}

interface QueryRow {
  [key: string]: unknown;
}

interface QueryExecutor {
  queryRows<T extends QueryRow = QueryRow>(query: string): Promise<T[]>;
}

interface EventhouseConfig {
  queryUri: string;
  databaseName: string;
  queryTimeoutMs: number;
}

export interface CreateRealtimeInsightsServiceOptions {
  queryExecutor?: QueryExecutor;
}

const DEFAULT_QUERY_TIMEOUT_MS = 30_000;

let sharedCredential: TokenCredential | undefined;
let sharedQueryExecutor: QueryExecutor | undefined;

function requireNonEmptyEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }

  return value;
}

function getEventhouseConfig(): EventhouseConfig {
  const rawTimeout = process.env.EVENTHOUSE_QUERY_TIMEOUT_MS?.trim();
  const parsedTimeout = rawTimeout ? Number.parseInt(rawTimeout, 10) : Number.NaN;

  return {
    queryUri: requireNonEmptyEnv("EVENTHOUSE_QUERY_URI"),
    databaseName: requireNonEmptyEnv("EVENTHOUSE_DATABASE_NAME"),
    queryTimeoutMs:
      Number.isFinite(parsedTimeout) && parsedTimeout > 0
        ? parsedTimeout
        : DEFAULT_QUERY_TIMEOUT_MS,
  };
}

export function isRealtimeInsightsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.EVENTHOUSE_QUERY_URI?.trim() && env.EVENTHOUSE_DATABASE_NAME?.trim());
}

export function resetRealtimeInsightsClientForTests(): void {
  sharedCredential = undefined;
  sharedQueryExecutor = undefined;
}

function quoteKustoString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function firstRow<T extends QueryRow>(rows: readonly T[]): T | undefined {
  return rows[0];
}

function coerceNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function coerceString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function coerceIsoTimestamp(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }

  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }

  return null;
}

function coerceBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function maxIsoTimestamp(values: ReadonlyArray<string | null>): string | null {
  const timestamps = values
    .filter((value): value is string => value !== null)
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);

  if (timestamps.length === 0) {
    return null;
  }

  return new Date(Math.max(...timestamps)).toISOString();
}

function toAlertId(parts: readonly string[]): string {
  const digest = createHash("sha256").update(parts.join("|")).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

class DefaultQueryExecutor implements QueryExecutor {
  private readonly client: KustoClient;

  constructor(
    private readonly config: EventhouseConfig,
    credential: TokenCredential,
  ) {
    this.client = new KustoClient(
      KustoConnectionStringBuilder.withTokenCredential(config.queryUri, credential),
    );
  }

  async queryRows<T extends QueryRow = QueryRow>(query: string): Promise<T[]> {
    const properties = new ClientRequestProperties();
    properties.setOption("servertimeout", this.config.queryTimeoutMs);

    const result = await this.client.executeQuery(this.config.databaseName, query, properties);
    const primaryTable = result.primaryResults[0];
    if (!primaryTable) {
      return [];
    }

    return Array.from(primaryTable.rows(), (row) => row.toJSON<T>());
  }
}

function getDefaultQueryExecutor(): QueryExecutor {
  if (sharedQueryExecutor) {
    return sharedQueryExecutor;
  }

  const credential = sharedCredential ?? (sharedCredential = new DefaultAzureCredential());
  sharedQueryExecutor = new DefaultQueryExecutor(getEventhouseConfig(), credential);
  return sharedQueryExecutor;
}

function buildActiveAlert(
  athleteId: string,
  type: AlertType,
  raisedAt: string | null,
  detail: string,
  identityParts: readonly string[],
  context: Record<string, boolean | number | string | null>,
): ActiveAlert {
  const normalizedRaisedAt = raisedAt ?? new Date(0).toISOString();

  return {
    alertId: toAlertId([type, athleteId, ...identityParts, normalizedRaisedAt]),
    type,
    raisedAt: normalizedRaisedAt,
    detail,
    context,
  };
}

function normalizeSustainedHighHrAlert(athleteId: string, row: QueryRow): ActiveAlert {
  const raisedAt = coerceIsoTimestamp(row.raisedAt);
  const sessionId = coerceString(row.sessionId) ?? "unknown-session";
  const minHeartRate = coerceNumber(row.minHeartRate);
  const distinctMinutes = coerceNumber(row.distinctMinutes);

  return buildActiveAlert(
    athleteId,
    "sustained-high-hr",
    raisedAt,
    `Heart rate stayed above the 90% race threshold for at least ${distinctMinutes ?? 3} minutes (minimum observed ${minHeartRate ?? "unknown"} bpm).`,
    [sessionId],
    {
      sessionId,
      minHeartRate,
      distinctMinutes,
    },
  );
}

function normalizeAcwrAlert(athleteId: string, row: QueryRow): ActiveAlert {
  const raisedAt = coerceIsoTimestamp(row.raisedAt);
  const acwr = coerceNumber(row.acwr);
  const avgLoad7d = coerceNumber(row.avgLoad7d);
  const avgLoad28d = coerceNumber(row.avgLoad28d);

  return buildActiveAlert(
    athleteId,
    "acwr",
    raisedAt,
    `Acute:Chronic Workload Ratio is ${acwr ?? "unknown"}, outside the safe 0.8-1.5 range (7d avg ${avgLoad7d ?? "unknown"}, 28d avg ${avgLoad28d ?? "unknown"}).`,
    [raisedAt ?? "unknown"],
    {
      acwr,
      avgLoad7d,
      avgLoad28d,
    },
  );
}

function normalizeMissedSessionAlert(athleteId: string, row: QueryRow): ActiveAlert {
  const raisedAt = coerceIsoTimestamp(row.raisedAt);
  const sessionId = coerceString(row.sessionId) ?? "unknown-session";
  const plannedDate = coerceIsoTimestamp(row.plannedDate);
  const overdueHours = coerceNumber(row.overdueHours);
  const discipline = coerceString(row.discipline);
  const status = coerceString(row.status);

  return buildActiveAlert(
    athleteId,
    "missed-session",
    raisedAt,
    `${discipline ?? "Scheduled"} session ${sessionId} has not been completed ${overdueHours ?? "unknown"} hours after its planned time.`,
    [sessionId, plannedDate ?? "unknown"],
    {
      sessionId,
      plannedDate,
      overdueHours,
      discipline,
      status,
    },
  );
}

function normalizeRacePaceDriftAlert(athleteId: string, row: QueryRow): ActiveAlert {
  const raisedAt = coerceIsoTimestamp(row.raisedAt);
  const raceId = coerceString(row.raceId) ?? "unknown-race";
  const leg = coerceString(row.leg) ?? "unknown-leg";
  const paceDriftPct = coerceNumber(row.paceDriftPct);
  const consecutiveOffPlanSplits = coerceNumber(row.consecutiveOffPlanSplits);
  const isFinish = coerceBoolean(row.isFinish);

  return buildActiveAlert(
    athleteId,
    "race-pace-drift",
    raisedAt,
    `${leg} pace is drifting ${paceDriftPct ?? "unknown"}% from plan after ${consecutiveOffPlanSplits ?? "unknown"} off-plan splits.`,
    [raceId, leg],
    {
      raceId,
      leg,
      paceDriftPct,
      consecutiveOffPlanSplits,
      isFinish,
    },
  );
}

function normalizeFuelingAlert(athleteId: string, row: QueryRow): ActiveAlert {
  const raisedAt = coerceIsoTimestamp(row.raisedAt);
  const sessionId = coerceString(row.sessionId) ?? "unknown-session";
  const discipline = coerceString(row.discipline);
  const adequacyRatio = coerceNumber(row.adequacyRatio);
  const recentCarbsGrams = coerceNumber(row.recentCarbsGrams);
  const estimatedCarbDemandGrams = coerceNumber(row.estimatedCarbDemandGrams);

  return buildActiveAlert(
    athleteId,
    "fueling-shortfall",
    raisedAt,
    `${discipline ?? "Live"} session fueling is only ${adequacyRatio ?? "unknown"} of estimated carbohydrate demand (${recentCarbsGrams ?? "unknown"}g / ${estimatedCarbDemandGrams ?? "unknown"}g).`,
    [sessionId],
    {
      sessionId,
      discipline,
      adequacyRatio,
      recentCarbsGrams,
      estimatedCarbDemandGrams,
    },
  );
}

class KustoRealtimeInsightsService implements RealtimeInsightsService {
  constructor(private readonly queryExecutor: QueryExecutor) {}

  async getAnalyses(athleteId: string): Promise<AthleteAnalysesResponse> {
    const athleteLiteral = quoteKustoString(athleteId);

    const [acwrRows, recoveryRows, nutritionRows, sleepRows, taperRows] = await Promise.all([
      this.queryExecutor.queryRows<{
        acuteChronicWorkloadRatio?: number;
        asOf?: unknown;
      }>(
        `eh_fn_acwr_alert_candidates() | where athleteId == ${athleteLiteral} | project acuteChronicWorkloadRatio = acwr, asOf = asOfDate | take 1`,
      ),
      this.queryExecutor.queryRows<{
        recoveryScore?: number;
        asOf?: unknown;
      }>(
        `eh_fn_recovery_score() | where athleteId == ${athleteLiteral} | top 1 by asOfDate desc | project recoveryScore, asOf = asOfDate`,
      ),
      this.queryExecutor.queryRows<{
        nutritionAdequacy?: number;
        asOf?: unknown;
      }>(
        `eh_fn_live_fueling_alert_candidates() | where athleteId == ${athleteLiteral} | top 1 by plannedDate desc | project nutritionAdequacy = adequacyRatio, asOf = plannedDate`,
      ),
      this.queryExecutor.queryRows<{
        sleepDebtMinutes?: number;
        asOf?: unknown;
      }>(
        `eh_fn_sleep_debt() | where athleteId == ${athleteLiteral} | top 1 by asOfDate desc | project sleepDebtMinutes, asOf = asOfDate`,
      ),
      this.queryExecutor.queryRows<{
        taperIndex?: number;
      }>(
        `eh_fn_taper_index() | where athleteId == ${athleteLiteral} | project taperIndex | take 1`,
      ),
    ]);

    const acwr = firstRow(acwrRows);
    const recovery = firstRow(recoveryRows);
    const nutrition = firstRow(nutritionRows);
    const sleep = firstRow(sleepRows);
    const taper = firstRow(taperRows);

    return {
      acuteChronicWorkloadRatio: coerceNumber(acwr?.acuteChronicWorkloadRatio),
      recoveryScore: coerceNumber(recovery?.recoveryScore),
      nutritionAdequacy: coerceNumber(nutrition?.nutritionAdequacy),
      sleepDebtMinutes: coerceNumber(sleep?.sleepDebtMinutes),
      taperIndex: coerceNumber(taper?.taperIndex),
      asOf: maxIsoTimestamp([
        coerceIsoTimestamp(acwr?.asOf),
        coerceIsoTimestamp(recovery?.asOf),
        coerceIsoTimestamp(nutrition?.asOf),
        coerceIsoTimestamp(sleep?.asOf),
      ]),
    };
  }

  async getActiveAlerts(athleteId: string): Promise<ActiveAlertsResponse> {
    const athleteLiteral = quoteKustoString(athleteId);

    const [highHrRows, acwrRows, missedSessionRows, racePaceRows, fuelingRows] = await Promise.all([
      this.queryExecutor.queryRows(
        "eh_mv_sustained_high_hr_candidates | where minHeartRate >= 160.2 and distinctMinutes >= 3 and windowStart >= ago(15m) | summarize arg_max(windowStart, *) by sessionId | project sessionId, raisedAt = windowStart, minHeartRate, distinctMinutes",
      ),
      this.queryExecutor.queryRows(
        `eh_fn_acwr_alert_candidates() | where athleteId == ${athleteLiteral} and alertCandidate == true | project athleteId, raisedAt = asOfDate, acwr, avgLoad7d, avgLoad28d`,
      ),
      this.queryExecutor.queryRows(
        `eh_fn_missed_session_alert_candidates() | where athleteId == ${athleteLiteral} and overdueHours >= 48 | project sessionId, athleteId, raisedAt = plannedDate, plannedDate, overdueHours, discipline, status`,
      ),
      this.queryExecutor.queryRows(
        "eh_mv_race_pace_drift_alert_candidates | join kind=inner (eh_mv_racesplit_latest | project raceId, latestSplitAt = timestamp, isFinish) on raceId | where latestSplitAt >= ago(6h) and isFinish == false and consecutiveOffPlanSplits >= 2 and abs(paceDriftPct) > 10 | project raceId, leg, raisedAt = latestSplitAt, paceDriftPct, consecutiveOffPlanSplits, isFinish",
      ),
      this.queryExecutor.queryRows(
        `eh_fn_live_fueling_alert_candidates() | where athleteId == ${athleteLiteral} and alertCandidate == true | project sessionId, athleteId, raisedAt = plannedDate, discipline, adequacyRatio, recentCarbsGrams, estimatedCarbDemandGrams`,
      ),
    ]);

    const alerts = [
      ...highHrRows.map((row) => normalizeSustainedHighHrAlert(athleteId, row)),
      ...acwrRows.map((row) => normalizeAcwrAlert(athleteId, row)),
      ...missedSessionRows.map((row) => normalizeMissedSessionAlert(athleteId, row)),
      ...racePaceRows.map((row) => normalizeRacePaceDriftAlert(athleteId, row)),
      ...fuelingRows.map((row) => normalizeFuelingAlert(athleteId, row)),
    ].sort((left, right) => right.raisedAt.localeCompare(left.raisedAt));

    return { alerts };
  }
}

export function createRealtimeInsightsService(
  options: CreateRealtimeInsightsServiceOptions = {},
): RealtimeInsightsService {
  if (resolveRuntimeProfile() === "synthetic") {
    if (options.queryExecutor) {
      throw new Error("A live query executor cannot be supplied with DEMO_PROFILE=synthetic.");
    }
    return new SyntheticInsightsService();
  }
  return new KustoRealtimeInsightsService(options.queryExecutor ?? getDefaultQueryExecutor());
}
