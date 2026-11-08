import { DataLakeFileSystemClient, DataLakeServiceClient } from "@azure/storage-file-datalake";
import { DefaultAzureCredential } from "@azure/identity";
import { randomUUID } from "node:crypto";
import type {
  Athlete,
  Equipment,
  IsoDate,
  NutritionLog,
  Race,
  RecoveryMetrics,
  SessionMetric,
  SleepSession,
  TrainingBlock,
  TrainingBlockPhase,
  TrainingSession,
} from "../models/index.js";
import { injectAnomalies, type InjectedAnomaly } from "../generators/anomalies.js";
import { addDays, formatDate, toUtcDate, withUtcTime } from "../generators/date-utils.js";
import { generateDailyMetricsBundle } from "../generators/daily-metrics.js";
import { generatePeriodizedTrainingPlan } from "../generators/periodization.js";
import { createSeededRandom, deriveSeed, nextUuid } from "../generators/random.js";
import { generateSessionMetricsForSessions } from "../generators/session-metrics.js";
import {
  createDefaultEventstreamPublisher,
  EVENTSTREAM_ROUTE,
  type EventstreamPublisher,
  SESSIONMETRIC_MAPPING_NAME,
} from "./eventstream-client.js";

export const DEFAULT_HISTORY_SEED = 20_260_907;
const DEFAULT_ENVIRONMENT = "dev";
const LAKEHOUSE_CAVEAT =
  "Rows were written to the Lakehouse Files area only; a follow-up Fabric notebook/Data Pipeline must load Files/ into Delta Tables/ before dashboards can query them as Lakehouse tables.";
type LakehouseEntityName =
  | "Athlete"
  | "TrainingBlock"
  | "TrainingBlockPhase"
  | "TrainingSession"
  | "RecoveryMetrics"
  | "NutritionLog"
  | "SleepSession"
  | "Race"
  | "Equipment";

type LakehouseRowCounts = Record<LakehouseEntityName, number>;

export interface SeedHistoryCounts extends LakehouseRowCounts {
  SessionMetric: number;
}

export interface SeedHistoryLakehouseResult {
  mode: "files-pending-load";
  dataRootPath: string;
  manifestPath: string;
  files: Record<LakehouseEntityName, string>;
  rowCounts: LakehouseRowCounts;
  caveat: string;
}

export interface SeedHistoryEventhouseResult {
  publishedSessionMetricCount: number;
  fullyQualifiedNamespace: string;
  eventHubName: string;
  mappingName: "sessionmetric_json_map";
  route: "eventstream-custom-endpoint";
}

interface SeedHistoryResultBase {
  athleteId: string;
  runId: string;
  environment: string;
  referenceDate: IsoDate;
  seededAt: string;
  counts: SeedHistoryCounts;
  lakehouse: SeedHistoryLakehouseResult;
  eventhouse: SeedHistoryEventhouseResult;
  anomalies: InjectedAnomaly[];
}

export interface SeedHistoryFreshResult extends SeedHistoryResultBase {
  outcome: "seeded";
  status: "completed";
}

export interface SeedHistoryAlreadySeededResult extends SeedHistoryResultBase {
  outcome: "already-seeded";
  status: "already-seeded";
  existingStatus: "completed";
}

export type SeedHistoryResult = SeedHistoryFreshResult | SeedHistoryAlreadySeededResult;

export interface SeedHistoryOptions {
  athleteId: string;
  goalRaceId?: string;
  referenceDate?: Date | IsoDate;
  environment?: string;
  seed?: number;
}

interface LakehouseSeedPayload {
  athlete: Athlete;
  trainingBlock: TrainingBlock;
  phases: TrainingBlockPhase[];
  sessions: TrainingSession[];
  recoveryMetrics: RecoveryMetrics[];
  nutritionLogs: NutritionLog[];
  sleepSessions: SleepSession[];
  races: Race[];
  equipment: Equipment[];
}

export interface SeedHistoryDataset extends LakehouseSeedPayload {
  referenceDate: IsoDate;
  sessionMetrics: SessionMetric[];
  anomalies: InjectedAnomaly[];
}

interface PersistLakehouseInput {
  athleteId: string;
  environment: string;
  payload: LakehouseSeedPayload;
}

export interface SeedHistoryStore {
  getExistingSeed(athleteId: string, environment: string): Promise<SeedHistoryFreshResult | null>;
  writeLakehouseFiles(input: PersistLakehouseInput): Promise<SeedHistoryLakehouseResult>;
  writeCompletionMarker(result: SeedHistoryFreshResult): Promise<void>;
}

export interface SessionMetricPublisher {
  publish(metrics: readonly SessionMetric[]): Promise<number>;
  close?(): Promise<void>;
  describeTarget(): Pick<
    SeedHistoryEventhouseResult,
    "fullyQualifiedNamespace" | "eventHubName" | "mappingName" | "route"
  >;
}

export interface SeedHistoryDependencies {
  store?: SeedHistoryStore;
  sessionMetricPublisher?: SessionMetricPublisher;
  now?: () => Date;
  runIdFactory?: () => string;
}

export interface OneLakeConfig {
  accountUrl: string;
  fileSystem: string;
  lakehousePath: string;
}

function resolveReferenceDate(referenceDate?: Date | IsoDate): IsoDate {
  return formatDate(toUtcDate(referenceDate ?? new Date()));
}

function requireNonEmptyEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }

  return value;
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function getDirectoryPath(filePath: string): string {
  const normalized = trimSlashes(filePath);
  const separatorIndex = normalized.lastIndexOf("/");
  return separatorIndex === -1 ? "" : normalized.slice(0, separatorIndex);
}

function normalizeAccountUrl(value: string): string {
  return value.replace(/\/+$/g, "");
}

export function getLakehouseConfigFromEnv(): OneLakeConfig {
  return {
    accountUrl: normalizeAccountUrl(requireNonEmptyEnv("LAKEHOUSE_ONELAKE_ACCOUNT_URL")),
    fileSystem: requireNonEmptyEnv("LAKEHOUSE_ONELAKE_FILESYSTEM"),
    lakehousePath: trimSlashes(requireNonEmptyEnv("LAKEHOUSE_ONELAKE_PATH")),
  };
}

function buildDefaultAthlete(athleteId: string, referenceDate: IsoDate): Athlete {
  return {
    athleteId,
    displayName: "Alex Triathlete",
    functionalThresholdPower: 268,
    thresholdPace: {
      swim: 1.72,
      bike: 9.6,
      run: 3.95,
    },
    restingHeartRate: 46,
    thresholdHeartRate: 178,
    dateOfBirth: "1990-05-14",
    createdAt: withUtcTime(referenceDate, 5, 0),
  };
}

function buildSeedRaces(
  athleteId: string,
  goalRaceId: string,
  referenceDate: IsoDate,
  trainingBlock: TrainingBlock,
  seed: number,
): Race[] {
  const idRandom = createSeededRandom(deriveSeed(seed, "seed-races"));
  const completedFullRaceId = nextUuid(idRandom);
  const futureHalfRaceId = nextUuid(idRandom);

  return [
    {
      raceId: completedFullRaceId,
      athleteId,
      name: "Cascadia Full Triathlon",
      date: formatDate(addDays(trainingBlock.startDate, -7)),
      distance: "full",
      goalTimeSeconds: 39_900,
      status: "completed",
      predictedFinishTimeSeconds: null,
      actualFinishTimeSeconds: 40_380,
      pacingEvennessStdDev: 8.4,
    },
    {
      raceId: goalRaceId,
      athleteId,
      name: "Seattle Seafair Olympic Triathlon",
      date: formatDate(addDays(referenceDate, 3)),
      distance: "olympic",
      goalTimeSeconds: 8_550,
      status: "upcoming",
      predictedFinishTimeSeconds: null,
      actualFinishTimeSeconds: null,
      pacingEvennessStdDev: null,
    },
    {
      raceId: futureHalfRaceId,
      athleteId,
      name: "Lake Washington 70.3",
      date: formatDate(addDays(referenceDate, 210)),
      distance: "70.3",
      goalTimeSeconds: 19_800,
      status: "upcoming",
      predictedFinishTimeSeconds: null,
      actualFinishTimeSeconds: null,
      pacingEvennessStdDev: null,
    },
  ];
}

function buildSeedEquipment(athleteId: string, seed: number): Equipment[] {
  const idRandom = createSeededRandom(deriveSeed(seed, "seed-equipment"));

  return [
    {
      equipmentId: nextUuid(idRandom),
      athleteId,
      type: "bike",
      cumulativeDistanceKm: 5_420.5,
    },
    {
      equipmentId: nextUuid(idRandom),
      athleteId,
      type: "shoes",
      cumulativeDistanceKm: 812.3,
    },
    {
      equipmentId: nextUuid(idRandom),
      athleteId,
      type: "wetsuit",
      cumulativeDistanceKm: 96.4,
    },
  ];
}

function createLakehousePayload(dataset: SeedHistoryDataset): LakehouseSeedPayload {
  return {
    athlete: dataset.athlete,
    trainingBlock: dataset.trainingBlock,
    phases: dataset.phases,
    sessions: dataset.sessions,
    recoveryMetrics: dataset.recoveryMetrics,
    nutritionLogs: dataset.nutritionLogs,
    sleepSessions: dataset.sleepSessions,
    races: dataset.races,
    equipment: dataset.equipment,
  };
}

function computeCounts(dataset: SeedHistoryDataset): SeedHistoryCounts {
  return {
    Athlete: 1,
    TrainingBlock: 1,
    TrainingBlockPhase: dataset.phases.length,
    TrainingSession: dataset.sessions.length,
    RecoveryMetrics: dataset.recoveryMetrics.length,
    NutritionLog: dataset.nutritionLogs.length,
    SleepSession: dataset.sleepSessions.length,
    Race: dataset.races.length,
    Equipment: dataset.equipment.length,
    SessionMetric: dataset.sessionMetrics.length,
  };
}

function toAlreadySeededResult(existing: SeedHistoryFreshResult): SeedHistoryAlreadySeededResult {
  return {
    ...existing,
    outcome: "already-seeded",
    status: "already-seeded",
    existingStatus: "completed",
  };
}

function toJsonLines(records: readonly unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

/**
 * Deterministically derives the "goal race" id `seedHistory` will assign a given athlete when no
 * explicit `goalRaceId` override is supplied (the normal case -- no caller in this repo passes
 * one). Pure function of `athleteId` (and the same default seed `seedHistory` uses), so any
 * consumer -- e.g. Cockpit's "Trigger Race" action, which needs a real raceId to
 * pre-fill without an extra authenticated round-trip to the Streaming Backend/Lakehouse -- can
 * compute the exact same id `seedHistory` already wrote to the Race table, with no I/O.
 */
export function deriveGoalRaceId(athleteId: string, seed: number = DEFAULT_HISTORY_SEED): string {
  const baseSeed = deriveSeed(seed, athleteId);
  return nextUuid(createSeededRandom(deriveSeed(baseSeed, "goal-race-id")));
}

function buildSeedDataset(options: SeedHistoryOptions): SeedHistoryDataset {
  const referenceDate = resolveReferenceDate(options.referenceDate);
  const baseSeed = deriveSeed(options.seed ?? DEFAULT_HISTORY_SEED, options.athleteId);
  const athlete = buildDefaultAthlete(options.athleteId, referenceDate);
  const goalRaceId =
    options.goalRaceId ?? deriveGoalRaceId(options.athleteId, options.seed ?? DEFAULT_HISTORY_SEED);
  const plan = generatePeriodizedTrainingPlan({
    athleteId: options.athleteId,
    goalRaceId,
    referenceDate,
    seed: deriveSeed(baseSeed, "periodization"),
  });
  const dailyMetrics = generateDailyMetricsBundle({
    athleteId: options.athleteId,
    startDate: plan.trainingBlock.startDate,
    endDate: plan.trainingBlock.endDate,
    sessions: plan.sessions,
    seed: deriveSeed(baseSeed, "daily-metrics"),
  });
  const withAnomalies = injectAnomalies({
    trainingSessions: plan.sessions,
    recoveryMetrics: dailyMetrics.recoveryMetrics,
    sleepSessions: dailyMetrics.sleepSessions,
    nutritionLogs: dailyMetrics.nutritionLogs,
    seed: deriveSeed(baseSeed, "anomalies"),
  });

  return {
    athlete,
    trainingBlock: plan.trainingBlock,
    phases: plan.phases,
    sessions: withAnomalies.trainingSessions,
    recoveryMetrics: withAnomalies.recoveryMetrics,
    nutritionLogs: withAnomalies.nutritionLogs,
    sleepSessions: withAnomalies.sleepSessions,
    races: buildSeedRaces(
      options.athleteId,
      goalRaceId,
      referenceDate,
      plan.trainingBlock,
      baseSeed,
    ),
    equipment: buildSeedEquipment(options.athleteId, baseSeed),
    sessionMetrics: generateSessionMetricsForSessions(withAnomalies.trainingSessions, {
      seed: deriveSeed(baseSeed, "session-metrics"),
    }),
    anomalies: withAnomalies.anomalies,
    referenceDate,
  };
}

/**
 * Generates history without persistence, publishing, credentials, or wall-clock defaults.
 * The live seeding service uses the same dataset builder.
 */
export function generateSeedHistoryDataset(
  options: Omit<SeedHistoryOptions, "referenceDate" | "environment"> & { referenceDate: IsoDate },
): SeedHistoryDataset {
  if (!options.athleteId.trim()) {
    throw new Error("athleteId must not be empty.");
  }
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(options.referenceDate) ||
    !Number.isFinite(Date.parse(options.referenceDate)) ||
    new Date(options.referenceDate).toISOString().slice(0, 10) !== options.referenceDate
  ) {
    throw new Error("referenceDate must be a valid YYYY-MM-DD date.");
  }
  if (
    options.seed !== undefined &&
    (!Number.isSafeInteger(options.seed) || options.seed < 0 || options.seed > 0xffff_ffff)
  ) {
    throw new Error("seed must be an unsigned 32-bit integer.");
  }
  return buildSeedDataset(options);
}

export class OneLakeFilesSeedHistoryStore implements SeedHistoryStore {
  protected readonly fileSystemClient: DataLakeFileSystemClient;

  constructor(
    protected readonly config: OneLakeConfig,
    credential: DefaultAzureCredential = new DefaultAzureCredential(),
  ) {
    this.fileSystemClient = new DataLakeServiceClient(
      config.accountUrl,
      credential,
    ).getFileSystemClient(config.fileSystem);
  }

  async getExistingSeed(
    athleteId: string,
    environment: string,
  ): Promise<SeedHistoryFreshResult | null> {
    const manifestClient = this.fileSystemClient.getFileClient(
      this.getManifestPath(athleteId, environment),
    );
    if (!(await manifestClient.exists())) {
      return null;
    }

    const buffer = await manifestClient.readToBuffer();
    return JSON.parse(buffer.toString("utf8")) as SeedHistoryFreshResult;
  }

  async writeLakehouseFiles(input: PersistLakehouseInput): Promise<SeedHistoryLakehouseResult> {
    const dataRootPath = this.getAthleteRootPath(input.athleteId, input.environment);
    const manifestPath = this.getManifestPath(input.athleteId, input.environment);
    const files: Record<LakehouseEntityName, string> = {
      Athlete: `${dataRootPath}/Athlete.jsonl`,
      TrainingBlock: `${dataRootPath}/TrainingBlock.jsonl`,
      TrainingBlockPhase: `${dataRootPath}/TrainingBlockPhase.jsonl`,
      TrainingSession: `${dataRootPath}/TrainingSession.jsonl`,
      RecoveryMetrics: `${dataRootPath}/RecoveryMetrics.jsonl`,
      NutritionLog: `${dataRootPath}/NutritionLog.jsonl`,
      SleepSession: `${dataRootPath}/SleepSession.jsonl`,
      Race: `${dataRootPath}/Race.jsonl`,
      Equipment: `${dataRootPath}/Equipment.jsonl`,
    };

    const rowCounts: LakehouseRowCounts = {
      Athlete: 1,
      TrainingBlock: 1,
      TrainingBlockPhase: input.payload.phases.length,
      TrainingSession: input.payload.sessions.length,
      RecoveryMetrics: input.payload.recoveryMetrics.length,
      NutritionLog: input.payload.nutritionLogs.length,
      SleepSession: input.payload.sleepSessions.length,
      Race: input.payload.races.length,
      Equipment: input.payload.equipment.length,
    };

    await this.writeTextFile(files.Athlete, toJsonLines([input.payload.athlete]));
    await this.writeTextFile(files.TrainingBlock, toJsonLines([input.payload.trainingBlock]));
    await this.writeTextFile(files.TrainingBlockPhase, toJsonLines(input.payload.phases));
    await this.writeTextFile(files.TrainingSession, toJsonLines(input.payload.sessions));
    await this.writeTextFile(files.RecoveryMetrics, toJsonLines(input.payload.recoveryMetrics));
    await this.writeTextFile(files.NutritionLog, toJsonLines(input.payload.nutritionLogs));
    await this.writeTextFile(files.SleepSession, toJsonLines(input.payload.sleepSessions));
    await this.writeTextFile(files.Race, toJsonLines(input.payload.races));
    await this.writeTextFile(files.Equipment, toJsonLines(input.payload.equipment));

    return {
      mode: "files-pending-load",
      dataRootPath,
      manifestPath,
      files,
      rowCounts,
      caveat: LAKEHOUSE_CAVEAT,
    };
  }

  async writeCompletionMarker(result: SeedHistoryFreshResult): Promise<void> {
    await this.writeTextFile(
      this.getManifestPath(result.athleteId, result.environment),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  }

  protected getEnvironmentRootPath(environment: string): string {
    return `${this.config.lakehousePath}/Files/history-seeding/${trimSlashes(environment)}`;
  }

  protected getAthleteRootPath(athleteId: string, environment: string): string {
    return `${this.config.lakehousePath}/Files/history-seeding/${trimSlashes(environment)}/${athleteId}`;
  }

  protected getManifestPath(athleteId: string, environment: string): string {
    return `${this.getAthleteRootPath(athleteId, environment)}/seed-manifest.json`;
  }

  protected async ensureDirectoryExists(directoryPath: string): Promise<void> {
    const normalized = trimSlashes(directoryPath);
    if (!normalized) {
      return;
    }

    const segments = normalized.split("/");
    let currentPath = "";
    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      if (currentPath === this.config.lakehousePath) {
        continue;
      }

      await this.fileSystemClient.getDirectoryClient(currentPath).createIfNotExists();
    }
  }

  protected async readTextFile(path: string): Promise<string | null> {
    const fileClient = this.fileSystemClient.getFileClient(path);
    if (!(await fileClient.exists())) {
      return null;
    }

    const buffer = await fileClient.readToBuffer();
    return buffer.toString("utf8");
  }

  protected async writeTextFile(path: string, content: string): Promise<void> {
    const directoryPath = getDirectoryPath(path);
    if (directoryPath) {
      await this.ensureDirectoryExists(directoryPath);
    }

    const fileClient = this.fileSystemClient.getFileClient(path);
    const buffer = Buffer.from(content, "utf8");

    await fileClient.deleteIfExists();
    await fileClient.create();
    await fileClient.append(buffer, 0, buffer.length);
    await fileClient.flush(buffer.length);
  }
}

export class EventstreamSessionMetricPublisher implements SessionMetricPublisher {
  constructor(private readonly publisher: EventstreamPublisher) {}

  async publish(metrics: readonly SessionMetric[]): Promise<number> {
    return this.publisher.publishSessionMetrics(metrics);
  }

  describeTarget(): Pick<
    SeedHistoryEventhouseResult,
    "fullyQualifiedNamespace" | "eventHubName" | "mappingName" | "route"
  > {
    const target = this.publisher.describeTarget();
    return {
      fullyQualifiedNamespace: target.fullyQualifiedNamespace,
      eventHubName: target.eventHubName,
      mappingName: SESSIONMETRIC_MAPPING_NAME,
      route: EVENTSTREAM_ROUTE,
    };
  }

  async close(): Promise<void> {
    await this.publisher.close();
  }
}

export function createDefaultSeedHistoryStore(): SeedHistoryStore {
  return new OneLakeFilesSeedHistoryStore(getLakehouseConfigFromEnv());
}

export function createDefaultSessionMetricPublisher(): SessionMetricPublisher {
  return new EventstreamSessionMetricPublisher(createDefaultEventstreamPublisher());
}

export async function hasSeedHistoryBeenSeeded(
  athleteId: string,
  environment = process.env.SIMULATOR_ENVIRONMENT ?? DEFAULT_ENVIRONMENT,
  store: SeedHistoryStore = createDefaultSeedHistoryStore(),
): Promise<boolean> {
  return (await store.getExistingSeed(athleteId, environment)) !== null;
}

/**
 * In-flight seed runs keyed by `${environment}:${athleteId}`, used to coalesce concurrent calls
 * into a single execution (see `seedHistory` below). This closes a check-then-act race: without
 * it, two nearly-simultaneous callers (e.g. an impatient double-click, or a client retry) could
 * both observe "not yet seeded" from `getExistingSeed` and both proceed to seed the same athlete,
 * publishing duplicate SessionMetric telemetry and racing to write the same Lakehouse files. This
 * is process-local only (like `GlobalConcurrencyLock`), so it doesn't protect against concurrent
 * calls across multiple backend replicas -- acceptable for this demo's single-operator usage.
 */
const inFlightSeedRuns = new Map<string, Promise<SeedHistoryResult>>();

export async function seedHistory(
  options: SeedHistoryOptions,
  dependencies: SeedHistoryDependencies = {},
): Promise<SeedHistoryResult> {
  const environment =
    options.environment ?? process.env.SIMULATOR_ENVIRONMENT ?? DEFAULT_ENVIRONMENT;
  const inFlightKey = `${environment}:${options.athleteId}`;

  const existingRun = inFlightSeedRuns.get(inFlightKey);
  if (existingRun) {
    return existingRun;
  }

  const run = seedHistoryUncoalesced(options, dependencies, environment);
  inFlightSeedRuns.set(inFlightKey, run);
  try {
    return await run;
  } finally {
    if (inFlightSeedRuns.get(inFlightKey) === run) {
      inFlightSeedRuns.delete(inFlightKey);
    }
  }
}

async function seedHistoryUncoalesced(
  options: SeedHistoryOptions,
  dependencies: SeedHistoryDependencies,
  environment: string,
): Promise<SeedHistoryResult> {
  const store = dependencies.store ?? createDefaultSeedHistoryStore();
  const publisher = dependencies.sessionMetricPublisher ?? createDefaultSessionMetricPublisher();
  const closePublisher = dependencies.sessionMetricPublisher
    ? undefined
    : publisher.close?.bind(publisher);

  try {
    const existing = await store.getExistingSeed(options.athleteId, environment);
    if (existing) {
      return toAlreadySeededResult(existing);
    }

    const dataset = buildSeedDataset({ ...options, environment });
    const lakehouse = await store.writeLakehouseFiles({
      athleteId: options.athleteId,
      environment,
      payload: createLakehousePayload(dataset),
    });
    const publishedSessionMetricCount = await publisher.publish(dataset.sessionMetrics);
    const counts = computeCounts(dataset);
    const seededAt = (dependencies.now ?? (() => new Date()))().toISOString();
    const freshResult: SeedHistoryFreshResult = {
      athleteId: options.athleteId,
      runId: (dependencies.runIdFactory ?? randomUUID)(),
      outcome: "seeded",
      status: "completed",
      environment,
      referenceDate: dataset.referenceDate,
      seededAt,
      counts,
      lakehouse,
      eventhouse: {
        ...publisher.describeTarget(),
        publishedSessionMetricCount,
      },
      anomalies: dataset.anomalies,
    };

    await store.writeCompletionMarker(freshResult);
    return freshResult;
  } finally {
    if (closePublisher) {
      await closePublisher();
    }
  }
}
