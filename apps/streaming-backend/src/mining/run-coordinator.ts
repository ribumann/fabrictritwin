import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { MiningCoordinationError, type MiningStore } from "./store.js";

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

interface RunSpec {
  plantId: "D01";
  runId: string;
  durationSeconds: number;
  scenario: MiningScenario;
  seed: number;
}

export interface MiningRunRecord extends RunSpec {
  startedAt: string;
  stopAt: string;
  /** Explicit optional final-batch budget; never beyond 1800s from startedAt. */
  finalFlushUntil?: string;
  authorityUntil: string;
  phase: RunPhase;
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

function invalid(message: string): never {
  throw new MiningCoordinationError("invalid", message);
}

function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    invalid("Mining requestId/runId must be a lowercase UUID.");
  }
  return value;
}

function spec(input: StartMiningRun): RunSpec {
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

function parseRun(value: unknown): MiningRunRecord {
  const record = object(value);
  const identity = parseSpec(value);
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
  };
}

function parsePlant(value: unknown): MiningRunRecord | null {
  const record = object(value);
  if (record.version !== 1) invalid("Unsupported mining coordination document version.");
  return record.run === null ? null : parseRun(record.run);
}

function terminal(phase: RunPhase): boolean {
  return !["running", "stopping"].includes(phase);
}

export class MiningRunCoordinator {
  private readonly finalFlushMilliseconds: number;

  constructor(
    private readonly store: MiningStore,
    private readonly clock: MiningClock = systemClock,
    options: { finalFlushMilliseconds?: number } = {},
  ) {
    const budget = options.finalFlushMilliseconds ?? 0;
    if (!Number.isInteger(budget) || budget < 0 || budget > 5_000) {
      invalid("Mining final-flush budget must be an explicit integer from 0 to 5000ms.");
    }
    this.finalFlushMilliseconds = budget;
  }

  async status(runId: string): Promise<MiningRunStatus | undefined> {
    uuid(runId);
    const receipt = await this.store.read(requestPath(runId));
    if (!receipt) return undefined;
    const admission = parseAdmission(receipt.value);
    if (admission.spec.runId !== runId) invalid("Mining admission identity mismatch.");
    const archived = await this.store.read(historyPath(runId));
    const plant = archived ? undefined : await this.store.read(PLANT_PATH);
    let run = archived ? parseRun(archived.value) : plant ? parsePlant(plant.value) : null;
    if (run?.runId !== runId) run = null;
    if (
      run &&
      !terminal(run.phase) &&
      ((!archived && !plant?.leased) ||
        this.clock.now() >= Date.parse(run.authorityUntil) ||
        this.clock.now() >= Date.parse(run.finalFlushUntil ?? run.stopAt))
    ) {
      run = { ...run, phase: "interrupted" };
    }
    return {
      runId,
      admission: admission.admission,
      phase: run?.phase ?? (admission.admission === "rejected" ? "rejected" : "admission_unknown"),
      stopRequested: Boolean(await this.store.read(stopPath(runId))),
      ...(run ? { run } : {}),
    };
  }

  async start(
    input: StartMiningRun,
  ): Promise<
    | { kind: "started"; run: MiningRunRecord; owner: MiningRunOwner }
    | { kind: "observed"; status: MiningRunStatus }
  > {
    const identity = spec(input);
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
      await this.store.create(PLANT_PATH, { version: 1, run: null });
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
      if (previous) {
        const archived = terminal(previous.phase)
          ? previous
          : { ...previous, phase: "interrupted" as const };
        await this.store.create(historyPath(previous.runId), archived);
      }
      if (this.clock.monotonic() - acquiredTick >= AUTHORITY_MS) {
        throw new MiningCoordinationError(
          "lease_lost",
          "Mining acquisition exceeded its safe lease window.",
        );
      }
      const run: MiningRunRecord = {
        ...identity,
        startedAt: new Date(acquiredAt).toISOString(),
        stopAt: new Date(acquiredAt + identity.durationSeconds * 1_000).toISOString(),
        authorityUntil: new Date(acquiredAt + AUTHORITY_MS).toISOString(),
        phase: "running",
      };
      const flushBudget = Math.min(
        this.finalFlushMilliseconds,
        (MAX_DURATION_SECONDS - identity.durationSeconds) * 1_000,
      );
      if (flushBudget > 0) {
        run.finalFlushUntil = new Date(Date.parse(run.stopAt) + flushBudget).toISOString();
      }
      const etag = await this.store.write(PLANT_PATH, { version: 1, run }, current.etag, leaseId);
      await this.store.write(path, { spec: identity, admission: "accepted" }, receipt.etag);
      if (this.clock.monotonic() - acquiredTick >= AUTHORITY_MS) {
        throw new MiningCoordinationError(
          "lease_lost",
          "Mining admission exceeded its safe lease window.",
        );
      }
      const owner = new MiningRunOwner(this.store, run, etag, leaseId, this.clock, acquiredTick);
      return { kind: "started", run: { ...run }, owner };
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

  /** Authorization belongs to the caller. No lease acquisition, break, or takeover occurs here. */
  async requestStop(runId: string): Promise<{ accepted: true; status: MiningRunStatus }> {
    const current = await this.status(uuid(runId));
    if (!current || current.admission !== "accepted") {
      throw new MiningCoordinationError("conflict", "Stop requires a durably admitted mining run.");
    }
    await this.store.create(stopPath(runId), {
      runId,
      requestedAt: new Date(this.clock.now()).toISOString(),
    });
    const status = await this.status(runId);
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

  private withinAuthority(): boolean {
    return (
      !this.lost &&
      !this.closed &&
      this.clock.monotonic() < this.leaseTick + AUTHORITY_MS &&
      this.clock.now() < Date.parse(this.run.authorityUntil)
    );
  }

  private durationElapsed(): boolean {
    return (
      this.clock.monotonic() >= this.startTick + this.run.durationSeconds * 1_000 ||
      this.clock.now() >= Date.parse(this.run.stopAt)
    );
  }

  private lifetimeElapsed(): boolean {
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
      ...(this.cancellationReason
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
          this.cancel(this.run.finalFlushUntil ? "failed" : "publisher_complete");
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
      { version: 1, run: this.run },
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
      if (await this.store.read(stopPath(this.run.runId))) {
        this.stopObserved = true;
        this.cancel("stopped");
        this.run = { ...this.run, phase: "stopping" };
      }
      if (this.lifetimeElapsed()) {
        this.cancel(this.run.finalFlushUntil ? "failed" : "publisher_complete");
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
        stop = Boolean(await this.store.read(stopPath(this.run.runId)));
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
    this.cancel(outcome);
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
      await this.store.create(historyPath(this.run.runId), this.run);
      this.assertAuthority();
      await this.store.release(PLANT_PATH, this.leaseId);
      this.closed = true;
      clearTimeout(this.deadline);
    } catch (error) {
      this.lose(error);
    }
  }
}
