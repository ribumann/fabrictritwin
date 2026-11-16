import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { MiningCoordinationError, type MiningStore } from "./store.js";
import {
  assertD01RunContract,
  createD01RunContract,
  type D01RunContract,
} from "../mining-incidents/catalog.js";

const PLANT = "D01";
const PLANT_PATH = "plants/D01.json";
const AUTHORITY_MS = 45_000; // Conservative margin inside the service's 60-second lease.
const MAX_DURATION_SECONDS = 1_800;
const SCENARIOS = [
  "normal",
  "bearing-b",
  "dms-c",
  "shared-water-restriction",
  "communication-gap",
] as const;
export type MiningScenario = (typeof SCENARIOS)[number];
export type RunPhase =
  "running" | "stopping" | "stopped" | "publisher_complete" | "failed" | "interrupted";

export interface StartMiningRun {
  plantId: "D01";
  /** UUID also used as runId; callers retain this across retries. */
  requestId: string;
  durationSeconds?: number;
  scenario?: MiningScenario;
  seed?: number;
}

interface CommonRunSpec {
  plantId: "D01";
  runId: string;
  scenario: MiningScenario;
  seed: number;
}

interface BoundedRunSpec extends CommonRunSpec {
  durationSeconds: number;
  lifetime?: never;
}

interface ContinuousRunSpec extends CommonRunSpec {
  lifetime: { kind: "continuous"; generation: string };
}

type RunSpec = BoundedRunSpec | ContinuousRunSpec;

interface RunLifecycle {
  startedAt: string;
  authorityUntil: string;
  phase: RunPhase;
  /** Absent on legacy schema-1 records; never inferred from the current catalog. */
  contract?: D01RunContract;
}

export interface BoundedMiningRunRecord extends BoundedRunSpec, RunLifecycle {
  stopAt: string;
  /** Explicit optional final-batch budget; never beyond 1800s from startedAt. */
  finalFlushUntil?: string;
}

export interface ContinuousMiningRunRecord extends ContinuousRunSpec, RunLifecycle {
  contract: D01RunContract;
}

export type MiningRunRecord = BoundedMiningRunRecord | ContinuousMiningRunRecord;

export function isContinuousMiningRun(run: RunSpec): run is ContinuousRunSpec {
  return run.lifetime?.kind === "continuous";
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
  return { plantId: PLANT, runId: uuid(input.requestId), durationSeconds, scenario, seed };
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
  return spec({
    plantId: record.plantId,
    requestId: record.runId,
    durationSeconds: record.durationSeconds,
    scenario: record.scenario as MiningScenario,
    seed: record.seed,
  });
}

function parseAdmission(value: unknown): Admission {
  const record = object(value);
  if (!["pending", "accepted", "rejected"].includes(String(record.admission))) {
    invalid("Invalid persisted mining admission.");
  }
  return { spec: parseSpec(record.spec), admission: record.admission as Admission["admission"] };
}

function parseRun(value: unknown, version: 1 | 2 | 3): MiningRunRecord {
  const record = object(value);
  if (version !== 3 && "lifetime" in record) {
    invalid("Continuous Mining requires coordination schema 3.");
  }
  if (version === 1 && "contract" in record)
    invalid("Legacy mining records cannot claim a run contract.");
  if (version === 2 || version === 3) {
    const keys = new Set([
      "plantId",
      "runId",
      "durationSeconds",
      "scenario",
      "seed",
      "startedAt",
      "stopAt",
      "finalFlushUntil",
      "authorityUntil",
      "phase",
      "contract",
      ...(version === 3 ? ["lifetime"] : []),
    ]);
    if (Object.keys(record).some((key) => !keys.has(key)))
      invalid("Unexpected persisted mining run field.");
    try {
      assertD01RunContract(record.contract);
    } catch (cause) {
      throw new MiningCoordinationError("invalid", "Invalid persisted mining run contract.", {
        cause,
      });
    }
  }
  const identity = parseSpec(value);
  if (version === 3 && !isContinuousMiningRun(identity)) {
    invalid("Mining schema 3 requires a continuous lifetime.");
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
  if (
    !dates.every((date) => typeof date === "string" && Number.isFinite(Date.parse(date))) ||
    !["running", "stopping", "stopped", "publisher_complete", "failed", "interrupted"].includes(
      String(record.phase),
    )
  )
    invalid("Invalid persisted mining lifecycle.");
  const startedAt = record.startedAt as string;
  const stopAt = record.stopAt as string;
  if (Date.parse(stopAt) - Date.parse(startedAt) !== identity.durationSeconds * 1_000) {
    invalid("Persisted mining deadline does not match the bounded run.");
  }
  const finalFlushUntil = record.finalFlushUntil;
  if (
    finalFlushUntil !== undefined &&
    (typeof finalFlushUntil !== "string" ||
      !Number.isFinite(Date.parse(finalFlushUntil)) ||
      Date.parse(finalFlushUntil) <= Date.parse(stopAt) ||
      Date.parse(finalFlushUntil) >
        Math.min(Date.parse(stopAt) + 5_000, Date.parse(startedAt) + 1_800_000))
  )
    invalid("Invalid persisted mining final-flush deadline.");
  return {
    ...identity,
    startedAt,
    stopAt,
    ...(typeof finalFlushUntil === "string" ? { finalFlushUntil } : {}),
    authorityUntil: record.authorityUntil as string,
    phase: record.phase as RunPhase,
    ...(version === 2 ? { contract: createD01RunContract() } : {}),
  };
}

function parsePlant(value: unknown): MiningRunRecord | null {
  const record = object(value);
  if (record.version !== 1 && record.version !== 2 && record.version !== 3)
    invalid("Unsupported mining coordination document version.");
  if (Object.keys(record).sort().join() !== "run,version")
    invalid("Invalid mining coordination document.");
  return record.run === null ? null : parseRun(record.run, record.version);
}

function parseHistory(value: unknown): MiningRunRecord {
  const record = object(value);
  if ("version" in record) {
    if (
      (record.version !== 2 && record.version !== 3) ||
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
    : run.contract
      ? { version: 2, run }
      : run;
}

const plantDocument = (run: MiningRunRecord) => ({
  version: isContinuousMiningRun(run) ? 3 : 2,
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
  return !["running", "stopping"].includes(phase);
}

export class MiningRunCoordinator {
  private readonly finalFlushMilliseconds: number;
  private readonly minimumStartIntervalMs: number;

  constructor(
    private readonly store: MiningStore,
    private readonly clock: MiningClock = systemClock,
    options: { finalFlushMilliseconds?: number; minimumStartIntervalMs?: number } = {},
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
    return this.admit(spec(input));
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
    const contract = createD01RunContract();
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
      const lifecycle = {
        startedAt: new Date(acquiredAt).toISOString(),
        authorityUntil: new Date(acquiredAt + AUTHORITY_MS).toISOString(),
        phase: "running" as const,
        contract,
      };
      const run: MiningRunRecord = isContinuousMiningRun(identity)
        ? { ...identity, ...lifecycle }
        : {
            ...identity,
            ...lifecycle,
            stopAt: new Date(acquiredAt + identity.durationSeconds * 1_000).toISOString(),
          };
      if (!isContinuousMiningRun(run)) {
        const flushBudget = Math.min(
          this.finalFlushMilliseconds,
          (MAX_DURATION_SECONDS - run.durationSeconds) * 1_000,
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
    return (
      this.clock.monotonic() >= this.startTick + this.run.durationSeconds * 1_000 ||
      this.clock.now() >= Date.parse(this.run.stopAt)
    );
  }

  private lifetimeElapsed(): boolean {
    if (isContinuousMiningRun(this.run)) return false;
    const deadline = Date.parse(this.run.finalFlushUntil ?? this.run.stopAt);
    return (
      this.clock.now() >= deadline ||
      this.clock.monotonic() >= this.startTick + deadline - Date.parse(this.run.startedAt)
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
              Date.parse(this.run.startedAt) -
              this.clock.monotonic(),
            Date.parse(this.run.finalFlushUntil ?? this.run.stopAt) - this.clock.now(),
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
