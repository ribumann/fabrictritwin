/**
 * These read-only MCP tools query Eventhouse directly with the MCP Tool Server's own managed
 * identity, rather than calling the Streaming Backend's analyses/alerts routes. That duplicates a
 * small amount of KQL/normalization logic, but it matches the MCP contract's architecture
 * (`contracts/mcp-tools-contract.md`: custom tools authenticate with the MCP Tool Server's managed
 * identity) and avoids coupling tool availability to the REST layer.
 */
import { createHash } from "node:crypto";
import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";
import {
  Client as KustoClient,
  ClientRequestProperties,
  KustoConnectionStringBuilder,
} from "azure-kusto-data";
import type {
  ActiveAlertItem,
  ActiveAlertsToolResponse,
  RaceSplitItem,
  RaceSplitsResponse,
  RecoveryTrendResponse,
  TrainingLoadResponse,
} from "../models.js";

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

export interface CreateAthleteAssistantDataServiceOptions {
  queryExecutor?: QueryExecutor;
}

export interface AthleteAssistantDataService {
  getRecoveryTrend(athleteId: string, days: number): Promise<RecoveryTrendResponse>;
  getTrainingLoad(athleteId: string): Promise<TrainingLoadResponse>;
  getActiveAlerts(athleteId: string): Promise<ActiveAlertsToolResponse>;
  getRaceSplits(athleteId: string, raceId: string): Promise<RaceSplitsResponse>;
}

const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
const NIGHTLY_SLEEP_TARGET_MINUTES = 480;
const SAFE_PHASES = ["Base", "Build", "Peak", "Taper"] as const;
const RACE_DISTANCE_TOTALS_BY_PLANNED_PACE = new Map<number, number>([
  [108, 51_930],
  [114, 113_537],
  [118, 226_605],
]);

let sharedCredential: TokenCredential | undefined;
let sharedQueryExecutor: QueryExecutor | undefined;
let sharedDataService: AthleteAssistantDataService | undefined;

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

function coerceDateOnly(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === "string" && value.length > 0) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return value;
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
  }

  return null;
}

function coerceBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toAlertId(parts: readonly string[]): string {
  const digest = createHash("sha256").update(parts.join("|")).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function buildActiveAlert(
  athleteId: string,
  type: string,
  raisedAt: string | null,
  detail: string,
  identityParts: readonly string[],
): ActiveAlertItem {
  const normalizedRaisedAt = raisedAt ?? new Date(0).toISOString();

  return {
    alertId: toAlertId([type, athleteId, ...identityParts, normalizedRaisedAt]),
    type,
    raisedAt: normalizedRaisedAt,
    detail,
  };
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

function computeRecoveryScore(
  hrv: number,
  sleepScore: number,
  sorenessScore: number,
  restingHeartRate: number,
  baselineHrvMean: number,
  baselineHrvStdev: number,
  baselineRhrMean: number,
): number {
  const hrvZ = baselineHrvStdev > 0 ? (hrv - baselineHrvMean) / baselineHrvStdev : 0;
  const hrvComponent = ((clamp(hrvZ, -3, 3) + 3) / 6) * 100;
  const inverseSorenessComponent = ((10 - sorenessScore) / 10) * 100;
  const rhrDeltaCapped = clamp(baselineRhrMean - restingHeartRate, -10, 10);
  const rhrComponent = ((rhrDeltaCapped + 10) / 20) * 100;

  return round(
    0.35 * hrvComponent + 0.25 * sleepScore + 0.2 * inverseSorenessComponent + 0.2 * rhrComponent,
    1,
  );
}

function computeSleepDebt(targetDate: string, sleepByDate: ReadonlyMap<string, number>): number {
  const anchor = new Date(`${targetDate}T00:00:00.000Z`);
  const samples: number[] = [];

  for (let index = 6; index >= 0; index -= 1) {
    const date = new Date(anchor);
    date.setUTCDate(date.getUTCDate() - index);
    const dateKey = date.toISOString().slice(0, 10);
    const minutes = sleepByDate.get(dateKey);
    if (typeof minutes === "number" && Number.isFinite(minutes)) {
      samples.push(minutes);
    }
  }

  if (samples.length === 0) {
    return 0;
  }

  const averageMinutes = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return round(NIGHTLY_SLEEP_TARGET_MINUTES - averageMinutes, 1);
}

function normalizePhase(value: string | null): TrainingLoadResponse["currentPhase"] {
  return SAFE_PHASES.find((phase) => phase === value) ?? "Base";
}

function inferRaceTotalDistanceMeters(
  splits: ReadonlyArray<{ plannedPaceSecPerKm: number }>,
): number | null {
  for (const split of splits) {
    const inferred = RACE_DISTANCE_TOTALS_BY_PLANNED_PACE.get(
      Math.round(split.plannedPaceSecPerKm),
    );
    if (typeof inferred === "number") {
      return inferred;
    }
  }

  return null;
}

class KustoAthleteAssistantDataService implements AthleteAssistantDataService {
  constructor(private readonly queryExecutor: QueryExecutor) {}

  async getRecoveryTrend(athleteId: string, days: number): Promise<RecoveryTrendResponse> {
    const athleteLiteral = quoteKustoString(athleteId);
    const boundedDays = Math.max(1, Math.min(Math.trunc(days), 30));

    const [baselineRows, recoveryRows, sleepRows] = await Promise.all([
      this.queryExecutor.queryRows<{
        baselineHrvMean?: number;
        baselineHrvStdev?: number;
        baselineRhrMean?: number;
      }>(
        `external_table('sc_RecoveryMetrics') | where athleteId == ${athleteLiteral} | summarize baselineHrvMean = avg(hrv), baselineHrvStdev = stdev(hrv), baselineRhrMean = avg(restingHeartRate)`,
      ),
      this.queryExecutor.queryRows<{
        date?: unknown;
        hrv?: number;
        sleepScore?: number;
        sorenessScore?: number;
        restingHeartRate?: number;
      }>(
        `let latestDate = toscalar(external_table('sc_RecoveryMetrics') | where athleteId == ${athleteLiteral} | summarize max(['date'])); external_table('sc_RecoveryMetrics') | where athleteId == ${athleteLiteral} and ['date'] > latestDate - ${boundedDays}d and ['date'] <= latestDate | project ['date'], hrv, sleepScore, sorenessScore, restingHeartRate | order by ['date'] asc`,
      ),
      this.queryExecutor.queryRows<{
        date?: unknown;
        totalSleepMinutes?: number;
      }>(
        `let latestDate = toscalar(external_table('sc_SleepSession') | where athleteId == ${athleteLiteral} | summarize max(['date'])); external_table('sc_SleepSession') | where athleteId == ${athleteLiteral} and ['date'] > latestDate - ${Math.max(boundedDays, 7) + 6}d and ['date'] <= latestDate | project ['date'], totalSleepMinutes | order by ['date'] asc`,
      ),
    ]);

    const baseline = firstRow(baselineRows);
    const baselineHrvMean = coerceNumber(baseline?.baselineHrvMean) ?? 0;
    const baselineHrvStdev = coerceNumber(baseline?.baselineHrvStdev) ?? 0;
    const baselineRhrMean = coerceNumber(baseline?.baselineRhrMean) ?? 0;
    const sleepByDate = new Map<string, number>();

    for (const row of sleepRows) {
      const date = coerceDateOnly(row.date);
      const minutes = coerceNumber(row.totalSleepMinutes);
      if (date && minutes !== null) {
        sleepByDate.set(date, minutes);
      }
    }

    return {
      trend: recoveryRows.flatMap((row) => {
        const date = coerceDateOnly(row.date);
        const hrv = coerceNumber(row.hrv);
        const sleepScore = coerceNumber(row.sleepScore);
        const sorenessScore = coerceNumber(row.sorenessScore);
        const restingHeartRate = coerceNumber(row.restingHeartRate);

        if (
          !date ||
          hrv === null ||
          sleepScore === null ||
          sorenessScore === null ||
          restingHeartRate === null
        ) {
          return [];
        }

        return [
          {
            date,
            recoveryScore: computeRecoveryScore(
              hrv,
              sleepScore,
              sorenessScore,
              restingHeartRate,
              baselineHrvMean,
              baselineHrvStdev,
              baselineRhrMean,
            ),
            sleepDebtMinutes: computeSleepDebt(date, sleepByDate),
            hrv,
          },
        ];
      }),
    };
  }

  async getTrainingLoad(athleteId: string): Promise<TrainingLoadResponse> {
    const athleteLiteral = quoteKustoString(athleteId);

    const [phaseRows, acwrRows, recentSessionRows] = await Promise.all([
      this.queryExecutor.queryRows<{ phase?: string }>(
        `let asOfDate = toscalar(external_table('sc_TrainingSession') | where athleteId == ${athleteLiteral} | summarize max(plannedDate)); let selectedTrainingBlockId = toscalar(external_table('sc_TrainingSession') | where athleteId == ${athleteLiteral} and plannedDate == asOfDate | project trainingBlockId | take 1); external_table('sc_TrainingBlockPhase') | where trainingBlockId == selectedTrainingBlockId | extend containsAsOf = iff(startDate <= asOfDate and endDate >= asOfDate, 1, 0) | order by containsAsOf desc, endDate desc | take 1 | project phase`,
      ),
      this.queryExecutor.queryRows<{ acwr?: number }>(
        `eh_fn_acwr_alert_candidates() | where athleteId == ${athleteLiteral} | project acwr | take 1`,
      ),
      this.queryExecutor.queryRows<{
        sessionId?: string;
        date?: unknown;
        discipline?: string;
        durationMinutes?: number;
        rpe?: number;
      }>(
        `external_table('sc_TrainingSession') | where athleteId == ${athleteLiteral} and status == 'completed' and isnotnull(rpe) | top 3 by plannedDate desc | project sessionId, ['date'] = plannedDate, discipline, durationMinutes = plannedDurationMinutes, rpe`,
      ),
    ]);

    const sessionIds = recentSessionRows
      .map((row) => coerceString(row.sessionId))
      .filter((value): value is string => value !== null);
    const heartRateRows =
      sessionIds.length === 0
        ? []
        : await this.queryExecutor.queryRows<{ sessionId?: string; maxHeartRate?: number }>(
            `SessionMetric | where sessionId in (${sessionIds.map(quoteKustoString).join(", ")}) | summarize maxHeartRate = max(heartRate) by sessionId`,
          );
    const maxHeartRateBySessionId = new Map<string, number>();

    for (const row of heartRateRows) {
      const sessionId = coerceString(row.sessionId);
      const maxHeartRate = coerceNumber(row.maxHeartRate);
      if (sessionId && maxHeartRate !== null) {
        maxHeartRateBySessionId.set(sessionId, maxHeartRate);
      }
    }

    return {
      currentPhase: normalizePhase(coerceString(firstRow(phaseRows)?.phase)),
      acwr: coerceNumber(firstRow(acwrRows)?.acwr) ?? 0,
      recentSessions: recentSessionRows.flatMap((row) => {
        const sessionId = coerceString(row.sessionId);
        const date = coerceDateOnly(row.date);
        const discipline = coerceString(row.discipline);
        const durationMinutes = coerceNumber(row.durationMinutes);
        const rpe = coerceNumber(row.rpe);

        if (!sessionId || !date || !discipline || durationMinutes === null || rpe === null) {
          return [];
        }

        return [
          {
            sessionId,
            date,
            discipline,
            durationMinutes,
            rpe,
            maxHeartRate: maxHeartRateBySessionId.get(sessionId) ?? 0,
          },
        ];
      }),
    };
  }

  async getActiveAlerts(athleteId: string): Promise<ActiveAlertsToolResponse> {
    const athleteLiteral = quoteKustoString(athleteId);
    const [highHrRows, acwrRows, missedSessionRows, racePaceRows, fuelingRows] = await Promise.all([
      this.queryExecutor.queryRows(
        "eh_mv_sustained_high_hr_candidates | where minHeartRate >= 160.2 and distinctMinutes >= 3 and windowStart >= ago(15m) | summarize arg_max(windowStart, *) by sessionId | project sessionId, raisedAt = windowStart, minHeartRate, distinctMinutes",
      ),
      this.queryExecutor.queryRows(
        `eh_fn_acwr_alert_candidates() | where athleteId == ${athleteLiteral} and alertCandidate == true | project raisedAt = asOfDate, acwr, avgLoad7d, avgLoad28d`,
      ),
      this.queryExecutor.queryRows(
        `eh_fn_missed_session_alert_candidates() | where athleteId == ${athleteLiteral} and overdueHours >= 48 | project sessionId, raisedAt = plannedDate, plannedDate, overdueHours, discipline, status`,
      ),
      this.queryExecutor.queryRows(
        "eh_mv_race_pace_drift_alert_candidates | join kind=inner (eh_mv_racesplit_latest | project raceId, latestSplitAt = timestamp, isFinish) on raceId | where latestSplitAt >= ago(6h) and isFinish == false and consecutiveOffPlanSplits >= 2 and abs(paceDriftPct) > 10 | project raceId, leg, raisedAt = latestSplitAt, paceDriftPct, consecutiveOffPlanSplits, isFinish",
      ),
      this.queryExecutor.queryRows(
        `eh_fn_live_fueling_alert_candidates() | where athleteId == ${athleteLiteral} and alertCandidate == true | project sessionId, raisedAt = plannedDate, discipline, adequacyRatio, recentCarbsGrams, estimatedCarbDemandGrams`,
      ),
    ]);

    const alerts = [
      ...highHrRows.map((row) => {
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
        );
      }),
      ...acwrRows.map((row) => {
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
        );
      }),
      ...missedSessionRows.map((row) => {
        const raisedAt = coerceIsoTimestamp(row.raisedAt);
        const sessionId = coerceString(row.sessionId) ?? "unknown-session";
        const overdueHours = coerceNumber(row.overdueHours);
        const discipline = coerceString(row.discipline);
        return buildActiveAlert(
          athleteId,
          "missed-session",
          raisedAt,
          `${discipline ?? "Scheduled"} session ${sessionId} has not been completed ${overdueHours ?? "unknown"} hours after its planned time.`,
          [sessionId, coerceIsoTimestamp(row.plannedDate) ?? "unknown"],
        );
      }),
      ...racePaceRows.map((row) => {
        const raisedAt = coerceIsoTimestamp(row.raisedAt);
        const raceId = coerceString(row.raceId) ?? "unknown-race";
        const leg = coerceString(row.leg) ?? "unknown-leg";
        const paceDriftPct = coerceNumber(row.paceDriftPct);
        const consecutiveOffPlanSplits = coerceNumber(row.consecutiveOffPlanSplits);
        return buildActiveAlert(
          athleteId,
          "race-pace-drift",
          raisedAt,
          `${leg} pace is drifting ${paceDriftPct ?? "unknown"}% from plan after ${consecutiveOffPlanSplits ?? "unknown"} off-plan splits.`,
          [raceId, leg],
        );
      }),
      ...fuelingRows.map((row) => {
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
        );
      }),
    ].sort((left, right) => right.raisedAt.localeCompare(left.raisedAt));

    return { alerts };
  }

  async getRaceSplits(_athleteId: string, raceId: string): Promise<RaceSplitsResponse> {
    const raceIdLiteral = quoteKustoString(raceId);
    const splitRows = await this.queryExecutor.queryRows<{
      leg?: string;
      timestamp?: unknown;
      currentPaceSecPerKm?: number;
      plannedPaceSecPerKm?: number;
      currentHeartRate?: number;
      distanceCoveredMeters?: number;
      isFinish?: boolean;
    }>(
      `RaceSplit | where raceId == ${raceIdLiteral} | order by timestamp asc | project leg, timestamp, currentPaceSecPerKm, plannedPaceSecPerKm, currentHeartRate, distanceCoveredMeters, isFinish`,
    );

    const splits = splitRows.flatMap((row) => {
      const leg = coerceString(row.leg);
      const timestamp = coerceIsoTimestamp(row.timestamp);
      const currentPaceSecPerKm = coerceNumber(row.currentPaceSecPerKm);
      const plannedPaceSecPerKm = coerceNumber(row.plannedPaceSecPerKm);
      const currentHeartRate = coerceNumber(row.currentHeartRate);
      const distanceCoveredMeters = coerceNumber(row.distanceCoveredMeters);
      const isFinish = coerceBoolean(row.isFinish) ?? false;

      if (
        !leg ||
        !timestamp ||
        currentPaceSecPerKm === null ||
        plannedPaceSecPerKm === null ||
        currentHeartRate === null ||
        distanceCoveredMeters === null
      ) {
        return [];
      }

      return [
        {
          leg,
          timestamp,
          currentPaceSecPerKm,
          plannedPaceSecPerKm,
          currentHeartRate,
          distanceCoveredMeters,
          isFinish,
        },
      ];
    });

    if (splits.length === 0) {
      return { splits: [], projectedFinishTimeSeconds: 0 };
    }

    const totalDistanceMeters =
      inferRaceTotalDistanceMeters(splits) ?? splits[splits.length - 1]!.distanceCoveredMeters;
    let elapsedSeconds = 0;
    let previousDistanceMeters = 0;

    for (const split of splits) {
      const segmentDistanceMeters = Math.max(
        0,
        split.distanceCoveredMeters - previousDistanceMeters,
      );
      elapsedSeconds += (segmentDistanceMeters / 1_000) * split.currentPaceSecPerKm;
      previousDistanceMeters = split.distanceCoveredMeters;
    }

    const latestSplit = splits[splits.length - 1]!;
    const remainingMeters = Math.max(0, totalDistanceMeters - latestSplit.distanceCoveredMeters);
    const projectedFinishTimeSeconds = latestSplit.isFinish
      ? round(elapsedSeconds, 2)
      : round(elapsedSeconds + (remainingMeters / 1_000) * latestSplit.currentPaceSecPerKm, 2);

    return {
      splits: splits.map<RaceSplitItem>((split) => ({
        leg: split.leg,
        timestamp: split.timestamp,
        currentPaceSecPerKm: split.currentPaceSecPerKm,
        plannedPaceSecPerKm: split.plannedPaceSecPerKm,
        currentHeartRate: split.currentHeartRate,
      })),
      projectedFinishTimeSeconds,
    };
  }
}

export function createAthleteAssistantDataService(
  options: CreateAthleteAssistantDataServiceOptions = {},
): AthleteAssistantDataService {
  return new KustoAthleteAssistantDataService(options.queryExecutor ?? getDefaultQueryExecutor());
}

export function getAthleteAssistantDataService(): AthleteAssistantDataService {
  if (!sharedDataService) {
    sharedDataService = createAthleteAssistantDataService();
  }

  return sharedDataService;
}

export function resetAthleteAssistantDataServiceForTests(): void {
  sharedCredential = undefined;
  sharedQueryExecutor = undefined;
  sharedDataService = undefined;
}
