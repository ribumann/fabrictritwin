/**
 * Daily automatic data generation for User Story 2.
 *
 * The simulator still writes canonical JSONL files into the Lakehouse `Files/` area because this
 * Node process has no native Delta writer. Unlike one-time history seeding, however, the scheduled
 * job must leave the data queryable with zero operator steps (SC-002), so every seeded-athlete run
 * immediately trigger the existing `load-history-to-tables` Fabric notebook through the REST Job
 * Scheduler API using the Container Apps Job's managed identity. The notebook's own MERGE logic
 * remains the final idempotency guard for Lakehouse Delta tables, while this service prevents
 * duplicate per-day rows in the upstream JSONL source files and records explicit gap markers when
 * the schedule misses one or more days.
 */
import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";
import { randomUUID } from "node:crypto";
import type {
  Athlete,
  Equipment,
  IsoDate,
  NutritionLog,
  Race,
  RecoveryMetrics,
  SleepSession,
  TrainingBlock,
  TrainingBlockPhase,
  TrainingSession,
} from "../models/index.js";
import { formatDate, getDatePortion, toUtcDate } from "../generators/date-utils.js";
import { generateDailyMetricsBundle } from "../generators/daily-metrics.js";
import { generateTrainingSessionsForDateRange } from "../generators/periodization.js";
import { deriveSeed } from "../generators/random.js";
import {
  detectDailyGenerationGap,
  mergeGapRecords,
  type DailyGenerationGapRecord,
  type GapDetectionResult,
} from "./gap-detection.js";
import {
  DEFAULT_HISTORY_SEED,
  OneLakeFilesSeedHistoryStore,
  getLakehouseConfigFromEnv,
  type OneLakeConfig,
  type SeedHistoryLakehouseResult,
  type SeedHistoryStore,
} from "./seed-history.js";

const DEFAULT_ENVIRONMENT = "dev";
const FABRIC_SCOPE = "https://api.fabric.microsoft.com/.default";
const NOTEBOOK_TIMEOUT_MS = 15 * 60 * 1000;
const LOAD_HISTORY_NOTEBOOK_NAME_PATTERN = /load-history-to-tables$/i;
const DAILY_GENERATION_STATE_FILE = "daily-generation-state.json";
const LAKEHOUSE_ENTITY_FILES = {
  Athlete: "Athlete.jsonl",
  TrainingBlock: "TrainingBlock.jsonl",
  TrainingBlockPhase: "TrainingBlockPhase.jsonl",
  TrainingSession: "TrainingSession.jsonl",
  RecoveryMetrics: "RecoveryMetrics.jsonl",
  NutritionLog: "NutritionLog.jsonl",
  SleepSession: "SleepSession.jsonl",
  Race: "Race.jsonl",
  Equipment: "Equipment.jsonl",
} as const;

type LakehouseSeedPayload = Parameters<SeedHistoryStore["writeLakehouseFiles"]>[0]["payload"];
type JsonRecord = Athlete | TrainingBlock | TrainingBlockPhase | TrainingSession | RecoveryMetrics | NutritionLog | SleepSession | Race | Equipment;

export interface DailyGenerationState {
  athleteId: string;
  environment: string;
  lastGeneratedDate: IsoDate;
  lastRunId: string;
  lastRunAt: string;
  activeGaps: DailyGenerationGapRecord[];
}

export interface DailyGenerationStore extends Pick<SeedHistoryStore, "getExistingSeed" | "writeLakehouseFiles"> {
  listSeededAthleteIds(environment: string): Promise<string[]>;
  readLakehousePayload(athleteId: string, environment: string): Promise<LakehouseSeedPayload | null>;
  readDailyGenerationState(athleteId: string, environment: string): Promise<DailyGenerationState | null>;
  writeDailyGenerationState(state: DailyGenerationState): Promise<string>;
}

export interface DailyGenerationNotebookLoadResult {
  attempted: boolean;
  status: "completed" | "skipped-no-athletes";
  workspaceId?: string;
  notebookId?: string;
  jobInstanceId?: string;
}

export interface DailyGenerationNotebookLoader {
  run(args: { environment: string; athleteId?: string }): Promise<DailyGenerationNotebookLoadResult>;
}

export interface DailyGenerateAthleteOptions {
  athleteId: string;
  environment?: string;
  targetDate?: Date | IsoDate;
  seed?: number;
}

export interface DailyGenerateAthleteResult {
  athleteId: string;
  environment: string;
  targetDate: IsoDate;
  outcome: "generated" | "already-generated";
  status: "completed" | "already-generated";
  lastGeneratedDateBeforeRun: IsoDate;
  gap: GapDetectionResult;
  generatedCounts: {
    TrainingSession: number;
    RecoveryMetrics: number;
    NutritionLog: number;
    SleepSession: number;
  };
  lakehouseChanged: boolean;
  lakehouse?: SeedHistoryLakehouseResult;
  statePath: string;
}

export interface DailyGenerateJobOptions {
  athleteId?: string;
  environment?: string;
  targetDate?: Date | IsoDate;
  seed?: number;
}

export interface DailyGenerateJobResult {
  environment: string;
  targetDate: IsoDate;
  athleteIds: string[];
  athleteResults: DailyGenerateAthleteResult[];
  notebookLoad: DailyGenerationNotebookLoadResult;
}

export interface DailyGenerationDependencies {
  store?: DailyGenerationStore;
  notebookLoader?: DailyGenerationNotebookLoader;
  now?: () => Date;
  runIdFactory?: () => string;
}

interface FabricItemListResponse {
  value?: Array<{ id?: string; type?: string; displayName?: string }>;
  continuationUri?: string;
}

interface FabricJobInstanceResponse {
  id?: string;
  status?: string;
  failureReason?: unknown;
}

function retryAfterMilliseconds(response: Response): number {
  const value = response.headers.get("Retry-After");
  if (value === null) {
    return 0;
  }
  const milliseconds = Number(value) * 1000;
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new Error("Fabric notebook response contained an invalid Retry-After header.");
  }
  return milliseconds;
}

function resolveEnvironment(environment?: string): string {
  return environment ?? process.env.SIMULATOR_ENVIRONMENT ?? DEFAULT_ENVIRONMENT;
}

function resolveTargetDate(targetDate: Date | IsoDate | undefined, now: () => Date): IsoDate {
  return formatDate(toUtcDate(targetDate ?? now()));
}

function maxIsoDate(...values: IsoDate[]): IsoDate {
  return values.reduce((current, candidate) => (candidate > current ? candidate : current));
}

function sortByDate<T>(records: readonly T[], getDate: (record: T) => string, getTieBreaker: (record: T) => string): T[] {
  return [...records].sort((left, right) => {
    const dateCompare = getDate(left).localeCompare(getDate(right));
    return dateCompare !== 0 ? dateCompare : getTieBreaker(left).localeCompare(getTieBreaker(right));
  });
}

function dedupeByKey<T>(existing: readonly T[], additions: readonly T[], keySelector: (record: T) => string): T[] {
  const byKey = new Map(existing.map((record) => [keySelector(record), record]));
  for (const record of additions) {
    byKey.set(keySelector(record), record);
  }

  return [...byKey.values()];
}

function inferLastGeneratedDate(payload: LakehouseSeedPayload, seedManifestDate: IsoDate): IsoDate {
  const recoveryDate = payload.recoveryMetrics.at(-1)?.date ?? seedManifestDate;
  const sleepDate = payload.sleepSessions.at(-1)?.date ?? seedManifestDate;
  const nutritionDate = getDatePortion(payload.nutritionLogs.at(-1)?.date ?? `${seedManifestDate}T00:00:00.000Z`);
  const sessionDate = getDatePortion(payload.sessions.at(-1)?.plannedDate ?? `${seedManifestDate}T00:00:00.000Z`);

  return maxIsoDate(seedManifestDate, payload.trainingBlock.endDate, recoveryDate, sleepDate, nutritionDate, sessionDate);
}

function extendTrainingBlock(trainingBlock: TrainingBlock, targetDate: IsoDate): TrainingBlock {
  return targetDate > trainingBlock.endDate ? { ...trainingBlock, endDate: targetDate } : trainingBlock;
}

function extendTrainingBlockPhases(phases: readonly TrainingBlockPhase[], targetDate: IsoDate): TrainingBlockPhase[] {
  if (phases.length === 0) {
    throw new Error("Seeded history is missing TrainingBlockPhase rows.");
  }

  const sortedPhases = [...phases].sort((left, right) => left.startDate.localeCompare(right.startDate));
  const lastPhase = sortedPhases.at(-1)!;

  if (targetDate <= lastPhase.endDate) {
    return sortedPhases;
  }

  return sortedPhases.map((phase, index) =>
    index === sortedPhases.length - 1
      ? {
          ...phase,
          endDate: targetDate,
        }
      : phase,
  );
}

function toDailyGeneratedSessions(args: {
  athleteId: string;
  trainingBlock: TrainingBlock;
  phases: readonly TrainingBlockPhase[];
  targetDate: IsoDate;
  seed: number;
}): TrainingSession[] {
  return generateTrainingSessionsForDateRange({
    trainingBlock: args.trainingBlock,
    phases: args.phases,
    startDate: args.targetDate,
    endDate: args.targetDate,
    seed: args.seed,
  }).map((session) => ({
    ...session,
    athleteId: args.athleteId,
    trainingBlockId: args.trainingBlock.trainingBlockId,
    // daily-generation always targets "today" or an earlier missed day being caught up (never a
    // future date -- see resolveTargetDate/detectDailyGenerationGap), so the simulated day has
    // already "happened" by the time this job runs. Keep the generator's realistic completed
    // status/rpe instead of forcing every session to a permanently-unconfirmed "planned"/null
    // state, which made daily-generated sessions invisible to every completed-session query
    // (dashboards, the Athlete Assistant, FR-006/FR-007 KQL analyses) forever. The FR-007c
    // missed-session-alert demo scenario is produced deliberately via generators/anomalies.ts
    // injectAnomalies(), not by leaving routine daily sessions unconfirmed.
    source: "daily-generated",
  }));
}

function buildUpdatedPayload(args: {
  payload: LakehouseSeedPayload;
  athleteId: string;
  targetDate: IsoDate;
  seed: number;
}): {
  payload: LakehouseSeedPayload;
  generatedCounts: DailyGenerateAthleteResult["generatedCounts"];
} {
  const baseSeed = deriveSeed(args.seed, args.athleteId);
  const trainingBlock = extendTrainingBlock(args.payload.trainingBlock, args.targetDate);
  const phases = extendTrainingBlockPhases(args.payload.phases, args.targetDate);
  const dailySessions = toDailyGeneratedSessions({
    athleteId: args.athleteId,
    trainingBlock,
    phases,
    targetDate: args.targetDate,
    seed: deriveSeed(baseSeed, "periodization"),
  });
  const dailyMetrics = generateDailyMetricsBundle({
    athleteId: args.athleteId,
    startDate: args.targetDate,
    endDate: args.targetDate,
    anchorStartDate: args.payload.trainingBlock.startDate,
    sessions: dailySessions,
    seed: deriveSeed(baseSeed, "daily-metrics"),
  });
  const recoveryMetrics = dailyMetrics.recoveryMetrics.map((metrics) => ({ ...metrics, source: "daily-generated" as const }));
  const sleepSessions = dailyMetrics.sleepSessions.map((session) => ({ ...session, source: "daily-generated" as const }));
  const nutritionLogs = dailyMetrics.nutritionLogs.map((log) => ({ ...log, source: "daily-generated" as const }));

  return {
    payload: {
      athlete: args.payload.athlete,
      trainingBlock,
      phases,
      sessions: sortByDate(
        dedupeByKey(args.payload.sessions, dailySessions, (session) => session.sessionId),
        (session) => session.plannedDate,
        (session) => session.sessionId,
      ),
      recoveryMetrics: sortByDate(
        dedupeByKey(args.payload.recoveryMetrics, recoveryMetrics, (metrics) => `${metrics.athleteId}|${metrics.date}`),
        (metrics) => metrics.date,
        (metrics) => metrics.athleteId,
      ),
      nutritionLogs: sortByDate(
        dedupeByKey(args.payload.nutritionLogs, nutritionLogs, (log) => `${log.athleteId}|${log.date}|${log.mealType}`),
        (log) => log.date,
        (log) => `${log.mealType}|${log.athleteId}`,
      ),
      sleepSessions: sortByDate(
        dedupeByKey(args.payload.sleepSessions, sleepSessions, (sleep) => `${sleep.athleteId}|${sleep.date}`),
        (sleep) => sleep.date,
        (sleep) => sleep.athleteId,
      ),
      races: args.payload.races,
      equipment: args.payload.equipment,
    },
    generatedCounts: {
      TrainingSession: dailySessions.length,
      RecoveryMetrics: recoveryMetrics.length,
      NutritionLog: nutritionLogs.length,
      SleepSession: sleepSessions.length,
    },
  };
}

function parseJsonLines<T extends JsonRecord>(content: string | null): T[] {
  if (!content) {
    return [];
  }

  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

function ensureLakehousePayload(payload: LakehouseSeedPayload | null, athleteId: string, environment: string): LakehouseSeedPayload {
  if (!payload) {
    throw new Error(
      `Seed history exists for athlete '${athleteId}' in environment '${environment}', but the expected Lakehouse Files payload could not be read.`,
    );
  }

  return payload;
}

export class OneLakeFilesDailyGenerationStore extends OneLakeFilesSeedHistoryStore implements DailyGenerationStore {
  constructor(config: OneLakeConfig, credential: DefaultAzureCredential = new DefaultAzureCredential()) {
    super(config, credential);
  }

  async listSeededAthleteIds(environment: string): Promise<string[]> {
    const athleteIds = new Set<string>();

    try {
      for await (const path of this.fileSystemClient.listPaths({
        path: this.getEnvironmentRootPath(environment),
        recursive: false,
      })) {
        if (!path.isDirectory || !path.name) {
          continue;
        }

        athleteIds.add(path.name.split("/").at(-1) ?? "");
      }
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 404) {
        return [];
      }
      throw error;
    }

    return [...athleteIds].filter(Boolean).sort();
  }

  async readLakehousePayload(athleteId: string, environment: string): Promise<LakehouseSeedPayload | null> {
    const rootPath = this.getAthleteRootPath(athleteId, environment);
    const athlete = parseJsonLines<Athlete>(await this.readTextFile(`${rootPath}/${LAKEHOUSE_ENTITY_FILES.Athlete}`))[0] ?? null;
    const trainingBlock = parseJsonLines<TrainingBlock>(await this.readTextFile(`${rootPath}/${LAKEHOUSE_ENTITY_FILES.TrainingBlock}`))[0] ?? null;

    if (!athlete || !trainingBlock) {
      return null;
    }

    return {
      athlete,
      trainingBlock,
      phases: parseJsonLines<TrainingBlockPhase>(await this.readTextFile(`${rootPath}/${LAKEHOUSE_ENTITY_FILES.TrainingBlockPhase}`)),
      sessions: parseJsonLines<TrainingSession>(await this.readTextFile(`${rootPath}/${LAKEHOUSE_ENTITY_FILES.TrainingSession}`)),
      recoveryMetrics: parseJsonLines<RecoveryMetrics>(await this.readTextFile(`${rootPath}/${LAKEHOUSE_ENTITY_FILES.RecoveryMetrics}`)),
      nutritionLogs: parseJsonLines<NutritionLog>(await this.readTextFile(`${rootPath}/${LAKEHOUSE_ENTITY_FILES.NutritionLog}`)),
      sleepSessions: parseJsonLines<SleepSession>(await this.readTextFile(`${rootPath}/${LAKEHOUSE_ENTITY_FILES.SleepSession}`)),
      races: parseJsonLines<Race>(await this.readTextFile(`${rootPath}/${LAKEHOUSE_ENTITY_FILES.Race}`)),
      equipment: parseJsonLines<Equipment>(await this.readTextFile(`${rootPath}/${LAKEHOUSE_ENTITY_FILES.Equipment}`)),
    };
  }

  async readDailyGenerationState(athleteId: string, environment: string): Promise<DailyGenerationState | null> {
    const content = await this.readTextFile(`${this.getAthleteRootPath(athleteId, environment)}/${DAILY_GENERATION_STATE_FILE}`);
    return content ? (JSON.parse(content) as DailyGenerationState) : null;
  }

  async writeDailyGenerationState(state: DailyGenerationState): Promise<string> {
    const statePath = `${this.getAthleteRootPath(state.athleteId, state.environment)}/${DAILY_GENERATION_STATE_FILE}`;
    await this.writeTextFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    return statePath;
  }
}

/**
 * Uses the Container Apps Job's managed identity to run the same Fabric notebook the manual
 * PowerShell helper calls. The workspace id is already available through
 * `LAKEHOUSE_ONELAKE_FILESYSTEM`, and the notebook id is auto-discovered by display name so the
 * scheduled job does not require an extra Bicep env-var change.
 */
export class FabricNotebookLoadHistoryRunner implements DailyGenerationNotebookLoader {
  constructor(private readonly credential: TokenCredential = new DefaultAzureCredential()) {}

  async run(args: { environment: string; athleteId?: string }): Promise<DailyGenerationNotebookLoadResult> {
    const workspaceId = process.env.FABRIC_WORKSPACE_ID?.trim() || process.env.LAKEHOUSE_ONELAKE_FILESYSTEM?.trim();
    if (!workspaceId) {
      throw new Error(
        "Missing Fabric workspace id. Set FABRIC_WORKSPACE_ID or LAKEHOUSE_ONELAKE_FILESYSTEM before running daily generation.",
      );
    }

    const notebookId = process.env.LOAD_HISTORY_NOTEBOOK_ITEM_ID?.trim() || (await this.resolveNotebookId(workspaceId));
    const headers = await this.getHeaders();
    const parameters: Array<{ name: string; value: string; type: "Text" }> = [];
    if (args.athleteId) {
      parameters.push({ name: "athlete_id", value: args.athleteId, type: "Text" });
    }
    if (args.environment) {
      parameters.push({ name: "environment", value: args.environment, type: "Text" });
    }

    // The notebook release API explicitly supports MI and typed parameters. Omitting beta=false
    // selects the older contract; the generic scheduler does not define this notebook payload.
    // https://learn.microsoft.com/rest/api/fabric/notebook/background-jobs/run-on-demand-notebook
    const response = await fetch(
      `https://api.fabric.microsoft.com/v1/workspaces/${workspaceId}/notebooks/${notebookId}/jobs/execute/instances?beta=false`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ parameters, executionData: { compute: "Spark" } }),
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (response.status !== 202) {
      throw new Error(`Fabric notebook trigger failed with HTTP ${response.status}: ${await response.text()}`);
    }

    const pollUri = response.headers.get("Location");
    if (!pollUri) {
      throw new Error("Fabric notebook trigger response did not include a Location header.");
    }

    const instance = await this.waitForCompletion(pollUri, retryAfterMilliseconds(response));
    return {
      attempted: true,
      status: "completed",
      workspaceId,
      notebookId,
      jobInstanceId: instance.id,
    };
  }

  private async getHeaders(): Promise<Record<string, string>> {
    const token = await this.credential.getToken(FABRIC_SCOPE);
    if (!token?.token) {
      throw new Error("DefaultAzureCredential did not return a Fabric API access token.");
    }

    return {
      Authorization: `Bearer ${token.token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  private async resolveNotebookId(workspaceId: string): Promise<string> {
    let nextUri = `https://api.fabric.microsoft.com/v1/workspaces/${workspaceId}/items`;
    while (nextUri) {
      const response = await fetch(nextUri, { headers: await this.getHeaders(), signal: AbortSignal.timeout(30_000) });
      if (!response.ok) {
        throw new Error(`Failed to list Fabric items for notebook discovery: HTTP ${response.status}.`);
      }

      const body = (await response.json()) as FabricItemListResponse;
      const match = body.value?.find(
        (item) => item.type === "Notebook" && item.displayName && LOAD_HISTORY_NOTEBOOK_NAME_PATTERN.test(item.displayName),
      );

      if (match?.id) {
        return match.id;
      }

      nextUri = body.continuationUri ?? "";
    }

    throw new Error("No Fabric notebook named '*load-history-to-tables' is visible to the simulator identity.");
  }

  private async waitForCompletion(pollUri: string, initialDelayMs: number): Promise<FabricJobInstanceResponse> {
    const deadline = Date.now() + NOTEBOOK_TIMEOUT_MS;
    let delayMs = initialDelayMs;
    while (Date.now() < deadline) {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, deadline - Date.now())));
      }
      if (Date.now() >= deadline) {
        break;
      }
      const response = await fetch(pollUri, {
        headers: await this.getHeaders(),
        signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - Date.now()))),
      });
      if (!response.ok) {
        throw new Error(`Failed to poll Fabric notebook job status: HTTP ${response.status}.`);
      }

      const body = (await response.json()) as FabricJobInstanceResponse;
      if (body.status === "Completed") {
        return body;
      }

      if (body.status === "Failed" || body.status === "Cancelled" || body.status === "Deduped") {
        throw new Error(`Fabric notebook job finished with status '${body.status}': ${JSON.stringify(body.failureReason ?? null)}`);
      }
      if (body.status !== "NotStarted" && body.status !== "InProgress") {
        throw new Error(`Fabric notebook job returned an unrecognized status: ${JSON.stringify(body.status ?? null)}.`);
      }

      delayMs = Math.max(10_000, retryAfterMilliseconds(response));
    }
    throw new Error(`Timed out after ${NOTEBOOK_TIMEOUT_MS / 1000}s waiting for Fabric notebook job completion.`);
  }
}

export function createDefaultDailyGenerationStore(): DailyGenerationStore {
  return new OneLakeFilesDailyGenerationStore(getLakehouseConfigFromEnv());
}

export function createDefaultDailyGenerationNotebookLoader(): DailyGenerationNotebookLoader {
  return new FabricNotebookLoadHistoryRunner();
}

/**
 * Generates the current target day for a single athlete without backfilling missed dates; any gap
 * is recorded explicitly in the persisted state file and returned to the caller.
 */
export async function dailyGenerateAthlete(
  options: DailyGenerateAthleteOptions,
  dependencies: DailyGenerationDependencies = {},
): Promise<DailyGenerateAthleteResult> {
  const environment = resolveEnvironment(options.environment);
  const now = dependencies.now ?? (() => new Date());
  const targetDate = resolveTargetDate(options.targetDate, now);
  const store = dependencies.store ?? createDefaultDailyGenerationStore();
  const existingSeed = await store.getExistingSeed(options.athleteId, environment);

  if (!existingSeed) {
    throw new Error(`Cannot run daily generation for athlete '${options.athleteId}' before history seeding has completed.`);
  }

  const payload = ensureLakehousePayload(await store.readLakehousePayload(options.athleteId, environment), options.athleteId, environment);
  const existingState = await store.readDailyGenerationState(options.athleteId, environment);
  const lastGeneratedDate = maxIsoDate(
    existingSeed.referenceDate,
    inferLastGeneratedDate(payload, existingSeed.referenceDate),
    existingState?.lastGeneratedDate ?? existingSeed.referenceDate,
  );
  const gap = detectDailyGenerationGap({
    lastGeneratedDate,
    targetDate,
  });
  const runId = (dependencies.runIdFactory ?? randomUUID)();
  const lastRunAt = now().toISOString();
  const nextState: DailyGenerationState = {
    athleteId: options.athleteId,
    environment,
    lastGeneratedDate: gap.shouldGenerateTargetDate ? targetDate : lastGeneratedDate,
    lastRunId: runId,
    lastRunAt,
    activeGaps: mergeGapRecords(existingState?.activeGaps ?? [], gap, targetDate),
  };

  if (!gap.shouldGenerateTargetDate) {
    const statePath = await store.writeDailyGenerationState(nextState);
    return {
      athleteId: options.athleteId,
      environment,
      targetDate,
      outcome: "already-generated",
      status: "already-generated",
      lastGeneratedDateBeforeRun: lastGeneratedDate,
      gap,
      generatedCounts: {
        TrainingSession: 0,
        RecoveryMetrics: 0,
        NutritionLog: 0,
        SleepSession: 0,
      },
      lakehouseChanged: false,
      statePath,
    };
  }

  const updated = buildUpdatedPayload({
    payload,
    athleteId: options.athleteId,
    targetDate,
    seed: options.seed ?? DEFAULT_HISTORY_SEED,
  });
  const lakehouse = await store.writeLakehouseFiles({
    athleteId: options.athleteId,
    environment,
    payload: updated.payload,
  });
  const statePath = await store.writeDailyGenerationState(nextState);

  return {
    athleteId: options.athleteId,
    environment,
    targetDate,
    outcome: "generated",
    status: "completed",
    lastGeneratedDateBeforeRun: lastGeneratedDate,
    gap,
    generatedCounts: updated.generatedCounts,
    lakehouseChanged: true,
    lakehouse,
    statePath,
  };
}

/**
 * Scheduled-job orchestration: discover every seeded athlete in the environment when no explicit
 * athlete id is supplied, generate the current day for each, then run the Files->Tables notebook a
 * single time so dashboards/query paths see the new rows automatically.
 */
export async function runDailyGenerationJob(
  options: DailyGenerateJobOptions = {},
  dependencies: DailyGenerationDependencies = {},
): Promise<DailyGenerateJobResult> {
  const environment = resolveEnvironment(options.environment);
  const now = dependencies.now ?? (() => new Date());
  const targetDate = resolveTargetDate(options.targetDate, now);
  const store = dependencies.store ?? createDefaultDailyGenerationStore();
  const athleteIds = options.athleteId ? [options.athleteId] : await store.listSeededAthleteIds(environment);

  if (athleteIds.length === 0) {
    return {
      environment,
      targetDate,
      athleteIds: [],
      athleteResults: [],
      notebookLoad: {
        attempted: false,
        status: "skipped-no-athletes",
      },
    };
  }

  const athleteResults: DailyGenerateAthleteResult[] = [];
  for (const athleteId of athleteIds) {
    athleteResults.push(
      await dailyGenerateAthlete(
        {
          athleteId,
          environment,
          targetDate,
          seed: options.seed,
        },
        { ...dependencies, store },
      ),
    );
  }

  const notebookLoader = dependencies.notebookLoader ?? createDefaultDailyGenerationNotebookLoader();
  // The generation state only confirms Files writes, not a successful Delta load. Always
  // replay the idempotent MERGE, including retries after an earlier load failed or timed out.
  const notebookLoad = await notebookLoader.run({ environment });

  return {
    environment,
    targetDate,
    athleteIds,
    athleteResults,
    notebookLoad,
  };
}
