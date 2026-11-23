import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { MiningCoordinationError, type MiningStore } from "./store.js";
import {
  D01_CONNECTION_PROFILE_VERSION,
  D01_CONNECTION_REQUIRED_DRAIN_DOWN_SECONDS,
  D01_CATALOG_VERSION,
  D01_PUBLISH_PROFILE_VERSION,
  D01_CONNECTION_MEASUREMENT_CATALOG_VERSION,
  D01_LEGACY_FLOW_PROJECTION_PROFILE_VERSION,
  D01_RECEIPT_START_POLICY,
} from "@triathlon-twin/simulator/mining";
import {
  assertD01RunContract,
  createD01RunContract,
  createD01SharedFlowRunContract,
  type D01RunContract,
  type D01SharedFlowRunContract,
} from "../mining-incidents/catalog.js";

const PLANT = "D01";
const PLANT_PATH = "plants/D01.json";
const AUTHORITY_MS = 45_000; // Conservative margin inside the service's 60-second lease.
const MAX_DURATION_SECONDS = 1_800;
export const SHARED_FLOW_PIN_TIMEOUT_MS = 120_000;
export const SHARED_FLOW_ACTIVATION_MARGIN_MS = 5_000;
export const SHARED_FLOW_PREPARE_LEAD_MS =
  SHARED_FLOW_PIN_TIMEOUT_MS + SHARED_FLOW_ACTIVATION_MARGIN_MS;
export const SHARED_FLOW_RECEIPT_START_DELAY_MS = 31_000;
export const MINING_OWNER_HEARTBEAT_INTERVAL_MS = 10_000;
const SCENARIOS = [
  "normal",
  "bearing-b",
  "dms-c",
  "shared-water-restriction",
  "communication-gap",
] as const;
export type MiningScenario = (typeof SCENARIOS)[number];
export type RunPhase =
  | "preparing"
  | "scheduled"
  | "running"
  | "stopping"
  | "stopped"
  | "publisher_complete"
  | "failed"
  | "interrupted";

export interface StartMiningRun {
  plantId: "D01";
  /** UUID also used as runId; callers retain this across retries. */
  requestId: string;
  durationSeconds?: number;
  scenario?: MiningScenario;
  seed?: number;
  /** Omit to keep the legacy run profile. Shared-flow is never selected by default. */
  profileVersion?: typeof D01_PUBLISH_PROFILE_VERSION | typeof D01_CONNECTION_PROFILE_VERSION;
  shutdownAtSeconds?: number;
  drainDownSeconds?: number;
}

interface CommonRunSpec {
  plantId: "D01";
  runId: string;
  scenario: MiningScenario;
  seed: number;
}

interface LegacyBoundedRunSpec extends CommonRunSpec {
  profileVersion: typeof D01_PUBLISH_PROFILE_VERSION;
  durationSeconds: number;
  shutdownAtSeconds?: never;
  drainDownSeconds?: never;
  lifetime?: never;
}

interface SharedFlowBoundedRunSpec extends CommonRunSpec {
  profileVersion: typeof D01_CONNECTION_PROFILE_VERSION;
  durationSeconds: number;
  shutdownAtSeconds: number;
  drainDownSeconds: number;
  lifetime?: never;
}

type BoundedRunSpec = LegacyBoundedRunSpec | SharedFlowBoundedRunSpec;

interface ContinuousRunSpec extends CommonRunSpec {
  lifetime: { kind: "continuous"; generation: string };
}

type RunSpec = BoundedRunSpec | ContinuousRunSpec;

interface RunLifecycle {
  startedAt: string;
  /** Present only on the version-4 shared-flow prepare/activate contract. */
  admittedAt?: string;
  /** Absolute deadline for exact shared-flow pin confirmation. */
  pinDeadlineAt?: string;
  startPolicy?: typeof D01_RECEIPT_START_POLICY;
  pinReceivedAt?: string;
  authorityUntil: string;
  phase: RunPhase;
  /** Absent on legacy schema-1 records; never inferred from the current catalog. */
  contract?: D01RunContract;
  /** Separate versioned contract keeps legacy consumers source-compatible. */
  connectionProfileContract?: D01SharedFlowRunContract;
}

export type BoundedMiningRunRecord = BoundedRunSpec &
  RunLifecycle & {
    stopAt: string;
    /** Explicit optional final-batch deadline, bounded from startedAt (legacy) or admittedAt (v4). */
    finalFlushUntil?: string;
  };
export type PreparedSharedFlowRunRecord = BoundedMiningRunRecord & {
  profileVersion: typeof D01_CONNECTION_PROFILE_VERSION;
  admittedAt: string;
  pinDeadlineAt: string;
  finalFlushUntil: string;
};

export interface ContinuousMiningRunRecord extends ContinuousRunSpec, RunLifecycle {
  contract: D01RunContract;
}

export type MiningRunRecord = BoundedMiningRunRecord | ContinuousMiningRunRecord;

export function isContinuousMiningRun(run: RunSpec): run is ContinuousRunSpec {
  return run.lifetime?.kind === "continuous";
}

export function isPreparedSharedFlowRun(run: MiningRunRecord): run is PreparedSharedFlowRunRecord {
  return (
    !isContinuousMiningRun(run) &&
    "profileVersion" in run &&
    run.profileVersion === D01_CONNECTION_PROFILE_VERSION &&
    typeof run.admittedAt === "string" &&
    typeof run.pinDeadlineAt === "string" &&
    typeof run.finalFlushUntil === "string"
  );
}

export function assertBoundedMiningRun(
  run: MiningRunRecord,
): asserts run is BoundedMiningRunRecord {
  if (run.lifetime !== undefined) {
    invalid("Continuous Mining cannot use a bounded-run operation.");
  }
}

export interface StartContinuousMiningRun {
  plantId: "D01";
  requestId: string;
  generation: string;
  scenario?: MiningScenario;
  seed?: number;
}

interface Admission {
  spec: RunSpec;
  admission: "pending" | "accepted" | "rejected";
}

export interface MiningRunStatus {
  runId: string;
  admission: Admission["admission"];
  /** Unknown admission is never a successful start or permission to launch a sender. */
  phase: RunPhase | "admission_unknown" | "rejected";
  stopRequested: boolean;
  run?: MiningRunRecord;
}

export interface MiningConnectionRunProfilePin {
  plant_id: "D01";
  run_id: string;
  catalog_version: typeof D01_CATALOG_VERSION;
  measurement_catalog_version: typeof D01_CONNECTION_MEASUREMENT_CATALOG_VERSION;
  profile_version: typeof D01_CONNECTION_PROFILE_VERSION;
  started_at: string;
  start_policy?: typeof D01_RECEIPT_START_POLICY;
}

export function receiptAnchoredStart(receivedAt: string, latestStart: string): string {
  const receipt = Date.parse(receivedAt);
  const latest = Date.parse(latestStart);
  if (!Number.isFinite(receipt) || !Number.isFinite(latest)) {
    invalid("Invalid shared-flow pin receipt or latest start.");
  }
  return new Date(
    Math.min(latest, Math.floor(receipt / 1_000) * 1_000 + SHARED_FLOW_RECEIPT_START_DELAY_MS),
  ).toISOString();
}

/** Candidate row for an external immutable Fabric pin; pinned_at belongs to the writer. */
export function createMiningConnectionRunProfilePin(
  run: MiningRunRecord,
): MiningConnectionRunProfilePin {
  if (
    !("profileVersion" in run) ||
    run.profileVersion !== D01_CONNECTION_PROFILE_VERSION ||
    !run.connectionProfileContract ||
    run.connectionProfileContract.profileVersion !== D01_CONNECTION_PROFILE_VERSION ||
    run.connectionProfileContract.measurementCatalogVersion !==
      D01_CONNECTION_MEASUREMENT_CATALOG_VERSION ||
    run.connectionProfileContract.legacyProjectionProfileVersion !==
      D01_LEGACY_FLOW_PROJECTION_PROFILE_VERSION ||
    run.connectionProfileContract.catalogVersion !== D01_CATALOG_VERSION
  ) {
    invalid("A Fabric profile pin requires a verified shared-flow run record.");
  }
  if (run.startPolicy && !run.admittedAt) {
    invalid("A receipt-anchored pin requires a durable admission.");
  }
  return {
    plant_id: run.plantId,
    run_id: run.runId,
    catalog_version: run.connectionProfileContract.catalogVersion as typeof D01_CATALOG_VERSION,
    measurement_catalog_version: run.connectionProfileContract
      .measurementCatalogVersion as typeof D01_CONNECTION_MEASUREMENT_CATALOG_VERSION,
    profile_version: run.connectionProfileContract.profileVersion,
    started_at:
      run.startPolicy && run.admittedAt
        ? new Date(Date.parse(run.admittedAt) + SHARED_FLOW_PREPARE_LEAD_MS).toISOString()
        : run.startedAt,
    ...(run.startPolicy ? { start_policy: run.startPolicy } : {}),
  };
}

export interface MiningClock {
  now(): number;
  monotonic(): number;
}

const systemClock: MiningClock = { now: Date.now, monotonic: () => performance.now() };
const requestPath = (id: string) => `requests/${id}.json`;
const stopPath = (id: string) => `stops/${id}.json`;
const historyPath = (id: string) => `history/${id}.json`;
const holdPath = (generation: string) => `continuous/holds/${generation}.json`;

function assertGeneration(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    invalid("Mining continuous generation must be an explicit operator configuration identifier.");
  }
}

async function generationHeld(
  store: MiningStore,
  generation: string,
  signal?: AbortSignal,
): Promise<boolean> {
  assertGeneration(generation);
  const document = await store.read(holdPath(generation), signal);
  signal?.throwIfAborted();
  if (!document) return false;
  const value = object(document.value);
  if (
    Object.keys(value).sort().join() !== "generation,plantId,requestedAt,version" ||
    value.version !== 1 ||
    value.plantId !== PLANT ||
    value.generation !== generation ||
    typeof value.requestedAt !== "string" ||
    !Number.isFinite(Date.parse(value.requestedAt))
  )
    invalid("Invalid persisted Mining generation stop.");
  return true;
}

async function stopRequested(
  store: MiningStore,
  run: RunSpec,
  signal?: AbortSignal,
): Promise<boolean> {
  return (
    Boolean(await store.read(stopPath(run.runId), signal)) ||
    (isContinuousMiningRun(run) && (await generationHeld(store, run.lifetime.generation, signal)))
  );
}

function invalid(message: string): never {
  throw new MiningCoordinationError("invalid", message);
}

function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    invalid("Mining requestId/runId must be a lowercase UUID.");
  }
  return value;
}

function spec(input: StartMiningRun): BoundedRunSpec {
  if ("lifetime" in input || "generation" in input) {
    invalid("Continuous Mining requires its separate trusted admission boundary.");
  }
  if (input.plantId !== PLANT) invalid("Only allowlisted mining plant D01 is supported.");
  const durationSeconds = input.durationSeconds ?? 1_200;
  const scenario = input.scenario ?? "normal";
  const seed = input.seed ?? 1;
  const profileVersion = input.profileVersion ?? D01_PUBLISH_PROFILE_VERSION;
  if (
    !Number.isInteger(durationSeconds) ||
    durationSeconds < 5 ||
    durationSeconds % 5 !== 0 ||
    durationSeconds > MAX_DURATION_SECONDS
  ) {
    invalid("Mining durationSeconds must be a multiple of 5 from 5 to 1800 (default 1200).");
  }
  if (!SCENARIOS.includes(scenario)) invalid("Unsupported mining scenario.");
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    invalid("Mining seed must be an unsigned 32-bit integer.");
  }
  if (profileVersion === D01_PUBLISH_PROFILE_VERSION) {
    if (input.shutdownAtSeconds !== undefined || input.drainDownSeconds !== undefined) {
      invalid("Shutdown and drain-down settings are valid only for the shared-flow profile.");
    }
    return {
      plantId: PLANT,
      runId: uuid(input.requestId),
      profileVersion,
      durationSeconds,
      scenario,
      seed,
    };
  }
  if (profileVersion !== D01_CONNECTION_PROFILE_VERSION) {
    invalid("Unsupported mining profileVersion.");
  }
  if (scenario !== "normal" || (input.seed !== undefined && seed !== 1)) {
    invalid("The shared-flow profile supports only its fixed normal scenario.");
  }
  const drainDownSeconds = input.drainDownSeconds ?? D01_CONNECTION_REQUIRED_DRAIN_DOWN_SECONDS;
  const shutdownAtSeconds = input.shutdownAtSeconds ?? durationSeconds - drainDownSeconds;
  if (
    !Number.isSafeInteger(drainDownSeconds) ||
    drainDownSeconds < D01_CONNECTION_REQUIRED_DRAIN_DOWN_SECONDS ||
    drainDownSeconds % 5 !== 0 ||
    !Number.isSafeInteger(shutdownAtSeconds) ||
    shutdownAtSeconds < 5 ||
    shutdownAtSeconds % 5 !== 0 ||
    shutdownAtSeconds + drainDownSeconds !== durationSeconds
  ) {
    invalid(
      `Shared-flow durationSeconds must equal shutdownAtSeconds plus at least ${D01_CONNECTION_REQUIRED_DRAIN_DOWN_SECONDS} seconds of five-second drain-down.`,
    );
  }
  return {
    plantId: PLANT,
    runId: uuid(input.requestId),
    profileVersion,
    durationSeconds,
    shutdownAtSeconds,
    drainDownSeconds,
    scenario,
    seed,
  };
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid("Invalid persisted mining document.");
  }
  return value as Record<string, unknown>;
}

function parseSpec(value: unknown): RunSpec {
  const record = object(value);
  if ("lifetime" in record) {
    const lifetime = object(record.lifetime);
    if (
      Object.keys(lifetime).sort().join() !== "generation,kind" ||
      lifetime.kind !== "continuous" ||
      "profileVersion" in record ||
      "shutdownAtSeconds" in record ||
      "drainDownSeconds" in record ||
      "durationSeconds" in record ||
      "stopAt" in record ||
      "finalFlushUntil" in record
    )
      invalid("Invalid continuous Mining lifetime.");
    assertGeneration(lifetime.generation);
    const bounded = parseSpec({
      plantId: record.plantId,
      runId: record.runId,
      scenario: record.scenario,
      seed: record.seed,
      durationSeconds: 1200,
    });
    if (isContinuousMiningRun(bounded) || bounded.profileVersion !== D01_PUBLISH_PROFILE_VERSION) {
      invalid("Continuous Mining must retain the legacy profile.");
    }
    return {
      plantId: bounded.plantId,
      runId: bounded.runId,
      scenario: bounded.scenario,
      seed: bounded.seed,
      lifetime: { kind: "continuous", generation: lifetime.generation },
    };
  }
  if (
    record.plantId !== PLANT ||
    typeof record.runId !== "string" ||
    typeof record.durationSeconds !== "number" ||
    typeof record.scenario !== "string" ||
    !SCENARIOS.some((scenario) => scenario === record.scenario) ||
    typeof record.seed !== "number"
  )
    invalid("Invalid persisted mining run identity.");
  if (
    record.profileVersion === D01_CONNECTION_PROFILE_VERSION &&
    (!("shutdownAtSeconds" in record) || !("drainDownSeconds" in record))
  ) {
    invalid("Shared-flow run schedule is incomplete.");
  }
  return spec({
    plantId: record.plantId,
    requestId: record.runId,
    durationSeconds: record.durationSeconds,
    scenario: record.scenario as MiningScenario,
    seed: record.seed,
    ...(record.profileVersion !== undefined
      ? { profileVersion: record.profileVersion as StartMiningRun["profileVersion"] }
      : {}),
    ...(record.shutdownAtSeconds !== undefined
      ? { shutdownAtSeconds: record.shutdownAtSeconds as number }
      : {}),
    ...(record.drainDownSeconds !== undefined
      ? { drainDownSeconds: record.drainDownSeconds as number }
      : {}),
  });
}

function parseAdmission(value: unknown): Admission {
  const record = object(value);
  if (!["pending", "accepted", "rejected"].includes(String(record.admission))) {
    invalid("Invalid persisted mining admission.");
  }
  return { spec: parseSpec(record.spec), admission: record.admission as Admission["admission"] };
}

function parseRun(value: unknown, version: 1 | 2 | 3 | 4 | 5): MiningRunRecord {
  const record = object(value);
  if (version !== 3 && "lifetime" in record) {
    invalid("Continuous Mining requires coordination schema 3.");
  }
  if (version === 1 && "contract" in record)
    invalid("Legacy mining records cannot claim a run contract.");
  if (version === 2 || version === 3 || version === 4 || version === 5) {
    const keys = new Set([
      "plantId",
      "runId",
      "profileVersion",
      "durationSeconds",
      "shutdownAtSeconds",
      "drainDownSeconds",
      "scenario",
      "seed",
      "startedAt",
      "stopAt",
      "finalFlushUntil",
      "authorityUntil",
      "phase",
      "contract",
      "connectionProfileContract",
      ...(version === 3 ? ["lifetime"] : []),
      ...(version === 4 || version === 5 ? ["admittedAt", "pinDeadlineAt"] : []),
      ...(version === 5 ? ["startPolicy", "pinReceivedAt"] : []),
    ]);
    if (Object.keys(record).some((key) => !keys.has(key)))
      invalid("Unexpected persisted mining run field.");
    for (const persistedContract of [record.contract, record.connectionProfileContract]) {
      if (persistedContract === undefined) continue;
      try {
        assertD01RunContract(persistedContract);
      } catch (cause) {
        throw new MiningCoordinationError("invalid", "Invalid persisted mining run contract.", {
          cause,
        });
      }
    }
  }
  const identity = parseSpec(value);
  const identityProfileVersion =
    !isContinuousMiningRun(identity) && "profileVersion" in identity
      ? identity.profileVersion
      : D01_PUBLISH_PROFILE_VERSION;
  const persistedProfileContract =
    identityProfileVersion === D01_CONNECTION_PROFILE_VERSION
      ? record.connectionProfileContract
      : record.contract;
  if (
    (version === 4 || version === 5) &&
    (isContinuousMiningRun(identity) || identityProfileVersion !== D01_CONNECTION_PROFILE_VERSION)
  ) {
    invalid("Coordination schema 4 is reserved for prepared shared-flow runs.");
  }
  if (
    (version === 1 && identityProfileVersion !== D01_PUBLISH_PROFILE_VERSION) ||
    (version !== 1 &&
      ((persistedProfileContract as Record<string, unknown> | undefined)?.profileVersion !==
        identityProfileVersion ||
        (identityProfileVersion === D01_CONNECTION_PROFILE_VERSION
          ? record.contract !== undefined
          : record.connectionProfileContract !== undefined)))
  ) {
    invalid("Mining run profile does not match its durable profile contract.");
  }
  if (version === 3 && !isContinuousMiningRun(identity)) {
    invalid("Mining schema 3 requires a continuous lifetime.");
  }
  if ((version === 4 || version === 5) && isContinuousMiningRun(identity)) {
    invalid("Mining schema 4 cannot contain a continuous lifetime.");
  }
  if (isContinuousMiningRun(identity)) {
    if (
      record.phase === "publisher_complete" ||
      !["running", "stopping", "stopped", "failed", "interrupted"].includes(String(record.phase)) ||
      ![record.startedAt, record.authorityUntil].every(
        (date) => typeof date === "string" && Number.isFinite(Date.parse(date)),
      )
    )
      invalid("Invalid continuous Mining lifecycle.");
    return {
      ...identity,
      startedAt: record.startedAt as string,
      authorityUntil: record.authorityUntil as string,
      phase: record.phase as RunPhase,
      contract: createD01RunContract(),
    };
  }
  const dates = [record.startedAt, record.stopAt, record.authorityUntil];
  const lifecyclePhases = [
    "running",
    "stopping",
    "stopped",
    "publisher_complete",
    "failed",
    "interrupted",
    ...(version === 4 || version === 5 ? ["preparing", "scheduled"] : []),
  ];
  if (
    !dates.every((date) => typeof date === "string" && Number.isFinite(Date.parse(date))) ||
    !lifecyclePhases.includes(String(record.phase))
  )
    invalid("Invalid persisted mining lifecycle.");
  const startedAt = record.startedAt as string;
  const stopAt = record.stopAt as string;
  const admittedAt = record.admittedAt;
  const pinDeadlineAt = record.pinDeadlineAt;
  if (version === 4 || version === 5) {
    if (
      typeof admittedAt !== "string" ||
      typeof pinDeadlineAt !== "string" ||
      !Number.isFinite(Date.parse(admittedAt)) ||
      !Number.isFinite(Date.parse(pinDeadlineAt))
    ) {
      invalid("Prepared shared-flow runs require valid admission and pin deadlines.");
    }
    const admittedAtMs = Date.parse(admittedAt);
    const pinDeadlineAtMs = Date.parse(pinDeadlineAt);
    const startedAtMs = Date.parse(startedAt);
    const deadlineValid = [30_000, SHARED_FLOW_PIN_TIMEOUT_MS].includes(
      pinDeadlineAtMs - admittedAtMs,
    );
    const latestStart = pinDeadlineAtMs + SHARED_FLOW_ACTIVATION_MARGIN_MS;
    const receipt = record.pinReceivedAt;
    const receiptMs = typeof receipt === "string" ? Date.parse(receipt) : NaN;
    const receiptValid = Number.isFinite(receiptMs);
    if (
      !deadlineValid ||
      (version === 4 && startedAtMs !== latestStart) ||
      (version === 5 &&
        (record.startPolicy !== D01_RECEIPT_START_POLICY ||
          pinDeadlineAtMs - admittedAtMs !== SHARED_FLOW_PIN_TIMEOUT_MS ||
          (receipt !== undefined && !receiptValid) ||
          (receiptValid &&
            (receiptMs < admittedAtMs - 5_000 || receiptMs > pinDeadlineAtMs + 5_000)) ||
          (["scheduled", "running", "publisher_complete"].includes(String(record.phase)) &&
            !receiptValid) ||
          (receiptValid && typeof receipt === "string"
            ? startedAt !== receiptAnchoredStart(receipt, new Date(latestStart).toISOString())
            : startedAtMs !== latestStart)))
    ) {
      invalid("Prepared shared-flow schedule violates its bounded pin lead.");
    }
  }
  if (Date.parse(stopAt) - Date.parse(startedAt) !== identity.durationSeconds * 1_000) {
    invalid("Persisted mining deadline does not match the bounded run.");
  }
  const finalFlushUntil = record.finalFlushUntil;
  const totalLifetimeAnchor =
    version === 4 || version === 5 ? Date.parse(admittedAt as string) : Date.parse(startedAt);
  if (
    ((version === 4 || version === 5) && typeof finalFlushUntil !== "string") ||
    (finalFlushUntil !== undefined &&
      (typeof finalFlushUntil !== "string" ||
        !Number.isFinite(Date.parse(finalFlushUntil)) ||
        Date.parse(finalFlushUntil) <= Date.parse(stopAt) ||
        Date.parse(finalFlushUntil) >
          Math.min(Date.parse(stopAt) + 5_000, totalLifetimeAnchor + 1_800_000)))
  )
    invalid("Invalid persisted mining final-flush deadline.");
  return {
    ...identity,
    startedAt,
    ...(version === 4 || version === 5
      ? {
          admittedAt: admittedAt as string,
          pinDeadlineAt: pinDeadlineAt as string,
        }
      : {}),
    ...(version === 5
      ? {
          startPolicy: D01_RECEIPT_START_POLICY,
          ...(typeof record.pinReceivedAt === "string"
            ? { pinReceivedAt: record.pinReceivedAt }
            : {}),
        }
      : {}),
    stopAt,
    ...(typeof finalFlushUntil === "string" ? { finalFlushUntil } : {}),
    authorityUntil: record.authorityUntil as string,
    phase: record.phase as RunPhase,
    ...((version === 2 || version === 4 || version === 5) && record.contract !== undefined
      ? { contract: record.contract as D01RunContract }
      : {}),
    ...((version === 2 || version === 4 || version === 5) &&
    record.connectionProfileContract !== undefined
      ? { connectionProfileContract: record.connectionProfileContract as D01SharedFlowRunContract }
      : {}),
  };
}

function parsePlant(value: unknown): MiningRunRecord | null {
  const record = object(value);
  if (
    record.version !== 1 &&
    record.version !== 2 &&
    record.version !== 3 &&
    record.version !== 4 &&
    record.version !== 5
  )
    invalid("Unsupported mining coordination document version.");
  if (Object.keys(record).sort().join() !== "run,version")
    invalid("Invalid mining coordination document.");
  return record.run === null ? null : parseRun(record.run, record.version);
}

function parseHistory(value: unknown): MiningRunRecord {
  const record = object(value);
  if ("version" in record) {
    if (
      (record.version !== 2 &&
        record.version !== 3 &&
        record.version !== 4 &&
        record.version !== 5) ||
      Object.keys(record).sort().join() !== "run,version"
    )
      invalid("Unsupported mining history document version.");
    return parseRun(record.run, record.version);
  }
  return parseRun(record, 1);
}

function history(run: MiningRunRecord): unknown {
  return isContinuousMiningRun(run)
    ? { version: 3, run }
    : run.startPolicy
      ? { version: 5, run }
      : run.admittedAt
        ? { version: 4, run }
        : run.contract || run.connectionProfileContract
          ? { version: 2, run }
          : run;
}

const plantDocument = (run: MiningRunRecord) => ({
  version: isContinuousMiningRun(run) ? 3 : run.startPolicy ? 5 : run.admittedAt ? 4 : 2,
  run,
});

async function saveHistory(store: MiningStore, run: MiningRunRecord): Promise<void> {
  const path = historyPath(run.runId);
  const value = history(run);
  if (await store.create(path, value)) return;
  const existing = await store.read(path);
  if (
    !existing ||
    JSON.stringify(parseHistory(existing.value)) !== JSON.stringify(parseHistory(value))
  )
    invalid("Existing mining history conflicts with the authoritative run.");
}

function terminal(phase: RunPhase): boolean {
  return !["preparing", "scheduled", "running", "stopping"].includes(phase);
}

export class MiningRunCoordinator {
  /** Read-only stop check also used while no run is active. Malformed holds fail closed. */
  continuousGenerationHeld(generation: string, signal?: AbortSignal): Promise<boolean> {
    return generationHeld(this.store, generation, signal);
  }
  private readonly finalFlushMilliseconds: number;
  private readonly minimumStartIntervalMs: number;
  private readonly receiptStartEnabled: boolean;

  constructor(
    private readonly store: MiningStore,
    private readonly clock: MiningClock = systemClock,
    options: {
      finalFlushMilliseconds?: number;
      minimumStartIntervalMs?: number;
      receiptStartEnabled?: boolean;
    } = {},
  ) {
    const budget = options.finalFlushMilliseconds ?? 0;
    if (!Number.isInteger(budget) || budget < 0 || budget > 5_000) {
      invalid("Mining final-flush budget must be an explicit integer from 0 to 5000ms.");
    }
    this.finalFlushMilliseconds = budget;
    const interval = options.minimumStartIntervalMs ?? 0;
    if (!Number.isSafeInteger(interval) || interval < 0 || interval > 86_400_000) {
      invalid("Mining minimum start interval must be between 0 and 86400000ms.");
    }
    this.minimumStartIntervalMs = interval;
    this.receiptStartEnabled = options.receiptStartEnabled === true;
  }

  async currentStatus(signal?: AbortSignal): Promise<MiningRunStatus | undefined> {
    const document = await this.store.read(PLANT_PATH, signal);
    signal?.throwIfAborted();
    const run = document ? parsePlant(document.value) : null;
    return run ? this.status(run.runId, signal) : undefined;
  }

  async status(runId: string, signal?: AbortSignal): Promise<MiningRunStatus | undefined> {
    uuid(runId);
    const read = async (path: string) => {
      if (signal?.aborted)
        throw new MiningCoordinationError("cancelled", "Mining status cancelled.");
      const document = await this.store.read(path, signal);
      if (signal?.aborted)
        throw new MiningCoordinationError("cancelled", "Mining status cancelled.");
      return document;
    };
    const receipt = await read(requestPath(runId));
    if (!receipt) return undefined;
    const admission = parseAdmission(receipt.value);
    if (admission.spec.runId !== runId) invalid("Mining admission identity mismatch.");
    const archived = await read(historyPath(runId));
    const plant = archived ? undefined : await read(PLANT_PATH);
    let run = archived ? parseHistory(archived.value) : plant ? parsePlant(plant.value) : null;
    if (run && run.runId !== runId) {
      if (archived) invalid("Mining history identity mismatch.");
      run = null;
    }
    if (run && JSON.stringify(parseSpec(run)) !== JSON.stringify(admission.spec)) {
      invalid("Mining run does not match its admission.");
    }
    if (
      run &&
      !terminal(run.phase) &&
      ((!archived && !plant?.leased) ||
        this.clock.now() >= Date.parse(run.authorityUntil) ||
        (!isContinuousMiningRun(run) &&
          this.clock.now() >= Date.parse(run.finalFlushUntil ?? run.stopAt)))
    ) {
      run = { ...run, phase: "interrupted" };
    }
    return {
      runId,
      admission: admission.admission,
      phase: run?.phase ?? (admission.admission === "rejected" ? "rejected" : "admission_unknown"),
      stopRequested: await stopRequested(this.store, admission.spec, signal),
      ...(run ? { run } : {}),
    };
  }

  async start(input: StartMiningRun) {
    const identity = spec(input);
    if (identity.profileVersion === D01_CONNECTION_PROFILE_VERSION) {
      if (this.finalFlushMilliseconds <= 0) {
        invalid("Shared-flow Mining requires a positive final-flush budget from 1 to 5000ms.");
      }
      if (
        identity.durationSeconds * 1_000 +
          SHARED_FLOW_PREPARE_LEAD_MS +
          this.finalFlushMilliseconds >
        MAX_DURATION_SECONDS * 1_000
      ) {
        invalid(
          "Shared-flow prepare lead, duration, and final-flush budget must fit within 1800 seconds from admission.",
        );
      }
    }
    return this.admit(identity);
  }

  /** Source-only capability. No startup or HTTP boundary activates continuous publication. */
  async startContinuous(input: StartContinuousMiningRun) {
    assertGeneration(input.generation);
    const bounded = spec({
      plantId: input.plantId,
      requestId: input.requestId,
      scenario: input.scenario,
      seed: input.seed,
    });
    return this.admit({
      plantId: bounded.plantId,
      runId: bounded.runId,
      scenario: bounded.scenario,
      seed: bounded.seed,
      lifetime: { kind: "continuous", generation: input.generation },
    });
  }

  private async admit(
    identity: RunSpec,
  ): Promise<
    | { kind: "started"; run: MiningRunRecord; owner: MiningRunOwner }
    | { kind: "observed"; status: MiningRunStatus }
  > {
    const sharedFlow =
      !isContinuousMiningRun(identity) &&
      identity.profileVersion === D01_CONNECTION_PROFILE_VERSION;
    const legacyContract = createD01RunContract();
    const contract = sharedFlow ? undefined : legacyContract;
    const connectionProfileContract = sharedFlow ? createD01SharedFlowRunContract() : undefined;
    if (
      isContinuousMiningRun(identity) &&
      (await generationHeld(this.store, identity.lifetime.generation))
    ) {
      throw new MiningCoordinationError(
        "conflict",
        "This continuous Mining generation is stopped.",
      );
    }
    const path = requestPath(identity.runId);
    const created = await this.store.create(path, { spec: identity, admission: "pending" });
    const receipt = await this.store.read(path);
    if (!receipt)
      throw new MiningCoordinationError("uncertain", "Mining admission cannot be reconciled.");
    const admission = parseAdmission(receipt.value);
    if (JSON.stringify(admission.spec) !== JSON.stringify(identity)) {
      throw new MiningCoordinationError(
        "conflict",
        "Mining request ID is bound to different run parameters.",
      );
    }
    if (!created) {
      const status = await this.status(identity.runId);
      if (!status)
        throw new MiningCoordinationError("uncertain", "Mining retry has no durable admission.");
      return { kind: "observed", status };
    }

    if (!(await this.store.read(PLANT_PATH))) {
      await this.store.create(PLANT_PATH, { version: 2, run: null });
    }
    const leaseId = randomUUID();
    const acquiredAt = this.clock.now();
    const acquiredTick = this.clock.monotonic();
    // Never retry acquisition with the same lease ID: Azure permits same-ID reacquisition.
    if (!(await this.store.acquire(PLANT_PATH, leaseId))) {
      await this.store.write(path, { spec: identity, admission: "rejected" }, receipt.etag);
      throw new MiningCoordinationError("conflict", "D01 already has an authoritative mining run.");
    }

    try {
      const current = await this.store.read(PLANT_PATH);
      if (!current)
        throw new MiningCoordinationError("uncertain", "Leased mining plant document disappeared.");
      const previous = parsePlant(current.value);
      if (
        isContinuousMiningRun(identity) &&
        (await generationHeld(this.store, identity.lifetime.generation))
      ) {
        await this.store.write(path, { spec: identity, admission: "rejected" }, receipt.etag);
        throw new MiningCoordinationError(
          "conflict",
          "This continuous Mining generation is stopped.",
        );
      }
      if (
        previous &&
        this.minimumStartIntervalMs > 0 &&
        acquiredAt - Date.parse(previous.startedAt) < this.minimumStartIntervalMs
      ) {
        await this.store.write(path, { spec: identity, admission: "rejected" }, receipt.etag);
        throw new MiningCoordinationError("conflict", "Mining start cooldown is active.");
      }
      if (previous) {
        const archived = terminal(previous.phase)
          ? previous
          : { ...previous, phase: "interrupted" as const };
        await saveHistory(this.store, archived);
      }
      if (this.clock.monotonic() - acquiredTick >= AUTHORITY_MS) {
        throw new MiningCoordinationError(
          "lease_lost",
          "Mining acquisition exceeded its safe lease window.",
        );
      }
      const preparedSharedFlow = sharedFlow;
      const admittedAt = new Date(acquiredAt).toISOString();
      const startedAtMs = acquiredAt + (preparedSharedFlow ? SHARED_FLOW_PREPARE_LEAD_MS : 0);
      const lifecycle: RunLifecycle = {
        startedAt: new Date(startedAtMs).toISOString(),
        authorityUntil: new Date(acquiredAt + AUTHORITY_MS).toISOString(),
        phase: (preparedSharedFlow ? "preparing" : "running") as RunPhase,
        ...(preparedSharedFlow
          ? {
              admittedAt,
              pinDeadlineAt: new Date(acquiredAt + SHARED_FLOW_PIN_TIMEOUT_MS).toISOString(),
              ...(this.receiptStartEnabled ? { startPolicy: D01_RECEIPT_START_POLICY } : {}),
            }
          : {}),
      };
      const run: MiningRunRecord = isContinuousMiningRun(identity)
        ? { ...identity, ...lifecycle, contract: legacyContract }
        : {
            ...identity,
            ...lifecycle,
            ...(contract ? { contract } : {}),
            ...(connectionProfileContract ? { connectionProfileContract } : {}),
            stopAt: new Date(startedAtMs + identity.durationSeconds * 1_000).toISOString(),
          };
      if (!isContinuousMiningRun(run)) {
        const flushBudget = Math.min(
          this.finalFlushMilliseconds,
          MAX_DURATION_SECONDS * 1_000 -
            (Date.parse(run.startedAt) - Date.parse(run.admittedAt ?? run.startedAt)) -
            run.durationSeconds * 1_000,
        );
        if (flushBudget > 0) {
          run.finalFlushUntil = new Date(Date.parse(run.stopAt) + flushBudget).toISOString();
        }
      }
      const etag = await this.store.write(PLANT_PATH, plantDocument(run), current.etag, leaseId);
      await this.store.write(path, { spec: identity, admission: "accepted" }, receipt.etag);
      if (this.clock.monotonic() - acquiredTick >= AUTHORITY_MS) {
        throw new MiningCoordinationError(
          "lease_lost",
          "Mining admission exceeded its safe lease window.",
        );
      }
      const owner = new MiningRunOwner(this.store, run, etag, leaseId, this.clock, acquiredTick);
      return { kind: "started", run: structuredClone(run), owner };
    } catch (error) {
      // On uncertain admission, release no authority to callers; the finite lease is the fallback.
      try {
        await this.store.release(PLANT_PATH, leaseId);
      } catch (releaseError) {
        throw new MiningCoordinationError(
          "uncertain",
          "Mining admission failed and lease release is unconfirmed.",
          {
            cause: new AggregateError([error, releaseError]),
          },
        );
      }
      throw error;
    }
  }

  /** Persist generation-wide intent first: a racing/new run cannot bypass this hold. */
  async requestContinuousStop(generation: string, signal?: AbortSignal) {
    assertGeneration(generation);
    signal?.throwIfAborted();
    await this.store.create(holdPath(generation), {
      version: 1,
      plantId: PLANT,
      generation,
      requestedAt: new Date(this.clock.now()).toISOString(),
    });
    if (!(await generationHeld(this.store, generation, signal))) {
      throw new MiningCoordinationError("uncertain", "Continuous Mining stop cannot be confirmed.");
    }
    const current = await this.currentStatus(signal);
    return {
      accepted: true as const,
      generation,
      stopRequested: true as const,
      status:
        current?.run &&
        isContinuousMiningRun(current.run) &&
        current.run.lifetime.generation === generation
          ? current
          : null,
    };
  }

  /** Authorization belongs to the caller. No lease acquisition, break, or takeover occurs here. */
  async requestStop(
    runId: string,
    onPersisted?: () => void,
    onUncertain?: (error: unknown) => void,
    signal?: AbortSignal,
  ): Promise<{ accepted: true; status: MiningRunStatus }> {
    const current = await this.status(uuid(runId), signal);
    if (!current || current.admission !== "accepted") {
      throw new MiningCoordinationError("conflict", "Stop requires a durably admitted mining run.");
    }
    signal?.throwIfAborted();
    try {
      if (current.run && isContinuousMiningRun(current.run)) {
        await this.requestContinuousStop(current.run.lifetime.generation, signal);
      } else {
        await this.store.create(stopPath(runId), {
          runId,
          requestedAt: new Date(this.clock.now()).toISOString(),
        });
      }
    } catch (error) {
      onUncertain?.(error);
      throw error;
    }
    onPersisted?.();
    const status = await this.status(runId, signal);
    if (!status) throw new MiningCoordinationError("uncertain", "Mining stop status disappeared.");
    return { accepted: true, status };
  }
}

/**
 * An ephemeral capability, never reconstructed on retry/restart. The runner must heartbeat
 * at least every 30s and await each batch. No simulator, publisher, or evaluator is started here.
 */
export class MiningRunOwner {
  private readonly cancellation = new AbortController();
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private leaseTick: number;
  private readonly startTick: number;
  private busy = false;
  private inFlight = false;
  private lost = false;
  private closed = false;
  private stopObserved = false;
  private finalBatchAdmitted = false;
  private cancellationReason: "stopped" | "publisher_complete" | "failed" | undefined;
  private beforeComplete?: () => Promise<void>;

  constructor(
    private readonly store: MiningStore,
    private run: MiningRunRecord,
    private etag: string,
    private readonly leaseId: string,
    private readonly clock: MiningClock,
    acquiredTick: number,
  ) {
    this.leaseTick = acquiredTick;
    this.startTick = acquiredTick;
    this.armDeadline();
  }

  get signal(): AbortSignal {
    return this.cancellation.signal;
  }

  /** Register once before starting owner work; completion waits for dependent work to settle. */
  onBeforeComplete(action: () => Promise<void>): void {
    if (this.beforeComplete || this.closed || this.busy || this.signal.aborted) {
      throw new MiningCoordinationError(
        "conflict",
        "Mining completion participant is unavailable.",
      );
    }
    this.beforeComplete = action;
  }

  private withinAuthority(): boolean {
    return (
      !this.lost &&
      !this.closed &&
      this.clock.monotonic() < this.leaseTick + AUTHORITY_MS &&
      this.clock.now() < Date.parse(this.run.authorityUntil)
    );
  }

  private durationElapsed(): boolean {
    if (isContinuousMiningRun(this.run)) return false;
    const admissionAnchor = Date.parse(this.run.admittedAt ?? this.run.startedAt);
    const scheduledStartTick = this.startTick + Date.parse(this.run.startedAt) - admissionAnchor;
    return (
      this.clock.monotonic() >= scheduledStartTick + this.run.durationSeconds * 1_000 ||
      this.clock.now() >= Date.parse(this.run.stopAt)
    );
  }

  private lifetimeElapsed(): boolean {
    if (isContinuousMiningRun(this.run)) return false;
    const deadline = Date.parse(this.run.finalFlushUntil ?? this.run.stopAt);
    const anchor = Date.parse(this.run.admittedAt ?? this.run.startedAt);
    return (
      this.clock.now() >= deadline || this.clock.monotonic() >= this.startTick + deadline - anchor
    );
  }

  private pinDeadlineElapsed(): boolean {
    return (
      isPreparedSharedFlowRun(this.run) &&
      this.run.phase === "preparing" &&
      (this.clock.now() >= Date.parse(this.run.pinDeadlineAt) ||
        this.clock.monotonic() >=
          this.startTick + Date.parse(this.run.pinDeadlineAt) - Date.parse(this.run.admittedAt))
    );
  }

  private cancel(reason: "stopped" | "publisher_complete" | "failed"): void {
    if (reason === "failed" || this.cancellationReason === undefined) {
      this.cancellationReason = reason;
    }
    this.cancellation.abort(new MiningCoordinationError("cancelled", `Mining run ${reason}.`));
  }

  private lose(error: unknown): never {
    this.lost = true;
    clearTimeout(this.deadline);
    this.cancellation.abort(error);
    throw error;
  }

  private armDeadline(): void {
    clearTimeout(this.deadline);
    if (this.closed || this.lost) return;
    const remaining = Math.min(
      this.leaseTick + AUTHORITY_MS - this.clock.monotonic(),
      Date.parse(this.run.authorityUntil) - this.clock.now(),
      ...(this.cancellationReason || isContinuousMiningRun(this.run)
        ? []
        : [
            this.startTick +
              Date.parse(this.run.finalFlushUntil ?? this.run.stopAt) -
              Date.parse(this.run.admittedAt ?? this.run.startedAt) -
              this.clock.monotonic(),
            Date.parse(this.run.finalFlushUntil ?? this.run.stopAt) - this.clock.now(),
          ]),
      ...(this.cancellationReason ||
      !isPreparedSharedFlowRun(this.run) ||
      this.run.phase !== "preparing"
        ? []
        : [
            this.startTick +
              Date.parse(this.run.pinDeadlineAt) -
              Date.parse(this.run.admittedAt) -
              this.clock.monotonic(),
            Date.parse(this.run.pinDeadlineAt) - this.clock.now(),
          ]),
    );
    this.deadline = setTimeout(
      () => {
        if (!this.withinAuthority()) {
          this.lost = true;
          this.cancellation.abort(
            new MiningCoordinationError("lease_lost", "Mining lease heartbeat expired."),
          );
          return;
        }
        if (this.lifetimeElapsed()) {
          this.cancel(
            !isContinuousMiningRun(this.run) && this.run.finalFlushUntil
              ? "failed"
              : "publisher_complete",
          );
        }
        if (this.pinDeadlineElapsed()) this.cancel("failed");
        this.armDeadline();
      },
      Math.max(1, remaining),
    );
    this.deadline.unref();
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy)
      throw new MiningCoordinationError("conflict", "Await the current mining owner operation.");
    this.busy = true;
    try {
      return await action();
    } finally {
      this.busy = false;
    }
  }

  private assertAuthority(): void {
    if (!this.withinAuthority()) {
      this.lose(
        new MiningCoordinationError(
          "lease_lost",
          "Mining owner no longer has safe lease authority.",
        ),
      );
    }
  }

  private async persist(): Promise<void> {
    this.assertAuthority();
    this.etag = await this.store.write(
      PLANT_PATH,
      plantDocument(this.run),
      this.etag,
      this.leaseId,
    );
    this.assertAuthority();
  }

  private async refresh(): Promise<void> {
    this.assertAuthority();
    const at = this.clock.now();
    const tick = this.clock.monotonic();
    try {
      await this.store.renew(PLANT_PATH, this.leaseId);
      // Azure can renew an expired lease. This capability must never resurrect itself.
      this.assertAuthority();
      this.leaseTick = tick;
      this.run = { ...this.run, authorityUntil: new Date(at + AUTHORITY_MS).toISOString() };
      if (await stopRequested(this.store, this.run)) {
        this.stopObserved = true;
        this.cancel("stopped");
        this.run = { ...this.run, phase: "stopping" };
      }
      if (this.pinDeadlineElapsed()) this.cancel("failed");
      if (this.lifetimeElapsed()) {
        this.cancel(
          !isContinuousMiningRun(this.run) && this.run.finalFlushUntil
            ? "failed"
            : "publisher_complete",
        );
      }
      await this.persist();
      this.armDeadline();
    } catch (error) {
      this.lose(error);
    }
  }

  async heartbeat(): Promise<void> {
    return this.exclusive(async () => {
      await this.refresh();
      if (this.signal.aborted) await this.complete("publisher_complete");
    });
  }

  /** Immutable shared-flow start anchor; only the injected profile-pin path can activate it. */
  get scheduledStartAt(): string {
    if (!isPreparedSharedFlowRun(this.run)) {
      throw new MiningCoordinationError("invalid", "Run has no prepared shared-flow start.");
    }
    return this.run.startedAt;
  }

  get scheduledStartMonotonic(): number {
    if (!isPreparedSharedFlowRun(this.run)) {
      throw new MiningCoordinationError("invalid", "Run has no prepared shared-flow start.");
    }
    return this.startTick + Date.parse(this.run.startedAt) - Date.parse(this.run.admittedAt);
  }

  /** Transition preparing -> scheduled only after exact external pin readback has returned. */
  async activatePreparedRun(pinReceivedAt?: string): Promise<MiningRunRecord> {
    return this.exclusive(async () => {
      await this.refresh();
      if (this.signal.aborted) {
        await this.complete("publisher_complete");
        throw new MiningCoordinationError("cancelled", "Prepared Mining run was cancelled.");
      }
      if (!isPreparedSharedFlowRun(this.run) || this.run.phase !== "preparing") {
        throw new MiningCoordinationError(
          "conflict",
          "Only an unexpired prepared shared-flow run can be activated.",
        );
      }
      if (this.pinDeadlineElapsed()) {
        this.cancel("failed");
        await this.persist();
        await this.complete("failed");
        throw new MiningCoordinationError("cancelled", "Shared-flow profile pin timed out.");
      }
      if (this.run.startPolicy === D01_RECEIPT_START_POLICY) {
        const received = pinReceivedAt === undefined ? NaN : Date.parse(pinReceivedAt);
        const admission = Date.parse(this.run.admittedAt);
        if (
          !Number.isFinite(received) ||
          received < admission - 5_000 ||
          received > this.clock.now() + 5_000
        ) {
          throw new MiningCoordinationError("invalid", "Shared-flow pin receipt time is invalid.");
        }
        if (pinReceivedAt === undefined) {
          throw new MiningCoordinationError("invalid", "Shared-flow pin receipt is missing.");
        }
        const startedAt = receiptAnchoredStart(pinReceivedAt, this.run.startedAt);
        const startMs = Date.parse(startedAt);
        if (
          startMs - this.clock.now() < SHARED_FLOW_ACTIVATION_MARGIN_MS ||
          this.startTick + startMs - admission - this.clock.monotonic() <
            SHARED_FLOW_ACTIVATION_MARGIN_MS
        ) {
          throw new MiningCoordinationError("cancelled", "Shared-flow start preparation was late.");
        }
        const flushBudget = Date.parse(this.run.finalFlushUntil) - Date.parse(this.run.stopAt);
        const stopAtMs = startMs + this.run.durationSeconds * 1_000;
        this.run = {
          ...this.run,
          pinReceivedAt,
          startedAt,
          stopAt: new Date(stopAtMs).toISOString(),
          finalFlushUntil: new Date(stopAtMs + flushBudget).toISOString(),
        };
      }
      this.run = { ...this.run, phase: "scheduled" };
      await this.persist();
      this.armDeadline();
      return structuredClone(this.run);
    });
  }

  /** Transition scheduled -> running at, never before, the durable future start anchor. */
  async beginScheduledRun(): Promise<boolean> {
    return this.exclusive(async () => {
      await this.refresh();
      if (this.signal.aborted) {
        await this.complete("publisher_complete");
        return false;
      }
      if (!isPreparedSharedFlowRun(this.run) || this.run.phase !== "scheduled") {
        throw new MiningCoordinationError(
          "conflict",
          "Mining run is not awaiting scheduled start.",
        );
      }
      if (
        this.clock.now() < Date.parse(this.run.startedAt) ||
        this.clock.monotonic() < this.scheduledStartMonotonic
      ) {
        return false;
      }
      this.run = { ...this.run, phase: "running" };
      await this.persist();
      return true;
    });
  }

  /** One authorization/check per batch. A concurrent stop may drain only this authorized batch. */
  async runBatch<T>(publish: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.authorizeBatch(publish, false);
  }

  /** Opt-in only: one genuine terminal simulator batch, never an additional model step. */
  async runFinalBatch<T>(
    batch: { runId: string; timestamp: string },
    publish: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (
      isContinuousMiningRun(this.run) ||
      !this.run.finalFlushUntil ||
      this.finalBatchAdmitted ||
      batch.runId !== this.run.runId ||
      batch.timestamp !== this.run.stopAt ||
      !this.durationElapsed()
    ) {
      throw new MiningCoordinationError(
        "invalid",
        "No final mining batch capability is available.",
      );
    }
    return this.authorizeBatch(publish, true);
  }

  private async authorizeBatch<T>(
    publish: (signal: AbortSignal) => Promise<T>,
    final: boolean,
  ): Promise<T> {
    return this.exclusive(async () => {
      if (final) {
        if (this.finalBatchAdmitted) {
          throw new MiningCoordinationError(
            "invalid",
            "No final mining batch capability is available.",
          );
        }
        // Reserve before refresh yields; a failed attempt never makes this capability reusable.
        this.finalBatchAdmitted = true;
      }
      await this.refresh();
      if (this.signal.aborted || (!final && this.durationElapsed())) {
        await this.complete("publisher_complete");
        throw new MiningCoordinationError(
          "cancelled",
          "Mining sender is cancelled; finish after draining.",
        );
      }
      if (this.run.phase !== "running") {
        throw new MiningCoordinationError(
          "conflict",
          "Mining batches are unavailable before the run is active.",
        );
      }
      // This is the batch-admission linearization point; no later batch can bypass stop intent.
      let stop: boolean;
      try {
        stop = await stopRequested(this.store, this.run);
      } catch (error) {
        this.lose(error);
      }
      if (stop) {
        this.stopObserved = true;
        this.cancel("stopped");
        await this.complete("publisher_complete");
        throw new MiningCoordinationError(
          "cancelled",
          "Mining stop requested before batch admission.",
        );
      }
      this.assertAuthority();
      if ((!final && this.durationElapsed()) || this.lifetimeElapsed()) {
        this.cancel("publisher_complete");
        throw new MiningCoordinationError(
          "cancelled",
          "Mining duration elapsed before batch admission.",
        );
      }
      this.inFlight = true;
      try {
        return await publish(this.signal);
      } catch (error) {
        this.cancel("failed");
        throw error;
      } finally {
        this.inFlight = false;
      }
    });
  }

  /** Call after the batch settles; publisher_complete is NOT evidence of Fabric ingestion. */
  async finish(outcome: "publisher_complete" | "failed" = "publisher_complete"): Promise<void> {
    return this.exclusive(async () => {
      if (this.closed) return;
      if (this.inFlight)
        throw new MiningCoordinationError(
          "conflict",
          "Mining batch must drain before stop acknowledgement.",
        );
      await this.refresh();
      await this.complete(outcome);
    });
  }

  private async complete(outcome: "publisher_complete" | "failed"): Promise<void> {
    if (
      isContinuousMiningRun(this.run) &&
      outcome === "publisher_complete" &&
      !this.stopObserved &&
      this.cancellationReason !== "failed"
    ) {
      invalid("Continuous Mining cannot claim finite publisher completion.");
    }
    this.cancel(outcome);
    let participantError: unknown;
    let participantFailed = false;
    try {
      if (this.beforeComplete) await this.beforeComplete();
    } catch (error) {
      participantFailed = true;
      participantError = error;
      this.cancel("failed");
    }
    this.run = {
      ...this.run,
      phase:
        this.cancellationReason === "failed"
          ? "failed"
          : this.stopObserved
            ? "stopped"
            : (this.cancellationReason ?? outcome),
    };
    try {
      await this.persist();
      await saveHistory(this.store, this.run);
      this.assertAuthority();
      await this.store.release(PLANT_PATH, this.leaseId);
      this.closed = true;
      clearTimeout(this.deadline);
    } catch (error) {
      if (participantFailed) {
        this.lose(
          new AggregateError([participantError, error], "Mining completion and cleanup failed."),
        );
      }
      this.lose(error);
    }
    if (participantFailed) throw participantError;
  }
}
