import { setTimeout as sleep } from "node:timers/promises";
import {
  D01_CONNECTION_PROFILE_VERSION,
  toD01ConnectionMeasurementBindingRecords,
} from "@triathlon-twin/simulator/mining";
import { configuredMiningStore } from "../blob-store.js";
import { MiningRunCoordinator, type MiningRunStatus } from "../run-coordinator.js";
import { MiningCoordinationError, type MiningStore } from "../store.js";
import {
  createBoundedMiningQuery,
  MiningQueryError,
  MINING_FLOW_CUTOFF_MARGIN_MS,
} from "./bounded-query.js";
import { createMiningConnectionFlowProvider } from "./connection-flow-provider.js";
import { connectionRunIdentity, readConnectionRunEvidence } from "./connection-run-evidence.js";

type Provider = ReturnType<typeof createMiningConnectionFlowProvider>;
type Evidence = Awaited<ReturnType<typeof readConnectionRunEvidence>>;
type StatusReader = (signal: AbortSignal) => Promise<MiningRunStatus | undefined>;
type Snapshot = {
  version: 1;
  runId: string;
  binding: string;
  evidence: Evidence;
};
const path = (runId: string) => `public-demo-connection-evidence/${runId}.json`;
const reconciliationDeadlineMs = 480_000;
const retryDelaysMs = [5_000, 30_000];

function snapshot(value: unknown, status: MiningRunStatus): Snapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MiningQueryError("malformed", "Invalid connection evidence snapshot.");
  }
  const saved = value as Partial<Snapshot>;
  const run = status.run;
  const evidence = saved.evidence;
  const expected =
    run && "durationSeconds" in run
      ? (run.durationSeconds / 5) * toD01ConnectionMeasurementBindingRecords().length
      : 0;
  if (
    saved.version !== 1 ||
    saved.runId !== status.runId ||
    saved.binding !== connectionRunIdentity(status) ||
    !evidence ||
    evidence.completeAtCutoff !== true ||
    evidence.expectedCount !== expected ||
    !Number.isFinite(Date.parse(evidence.asOf)) ||
    !run ||
    !("stopAt" in run) ||
    Date.parse(evidence.asOf) < Date.parse(run.stopAt) ||
    !Number.isSafeInteger(evidence.rawRows) ||
    evidence.rawRows < expected ||
    !Number.isSafeInteger(evidence.validatedRows) ||
    evidence.validatedRows < expected ||
    evidence.payloadMismatches !== 0 ||
    evidence.unexpectedRawCopies !== 0 ||
    evidence.unexpectedValidatedCopies !== 0 ||
    evidence.rawReceiptTimeMissing !== 0 ||
    evidence.validatedReceiptTimeMissing !== 0 ||
    !evidence.statusCounts ||
    Object.values(evidence.statusCounts).some(
      (count) => !Number.isSafeInteger(count) || count < 0,
    ) ||
    (evidence.statusCounts.OBSERVED_MATCH ?? 0) + (evidence.statusCounts.DUPLICATE_MATCH ?? 0) !==
      expected ||
    Object.keys(evidence.statusCounts).some(
      (key) => !["OBSERVED_MATCH", "DUPLICATE_MATCH"].includes(key),
    )
  )
    throw new MiningQueryError("malformed", "Invalid connection evidence snapshot.");
  return saved as Snapshot;
}

/** Service-owned background capture; GET requests never initiate a full reconciliation. */
export class MiningConnectionEvidenceWorker {
  private readonly cancellation = new AbortController();
  private readonly closeReason = new MiningCoordinationError(
    "cancelled",
    "Connection evidence host closed.",
  );
  private active?: { runId: string; work: Promise<void> };
  constructor(
    private readonly dependencies: {
      store: Pick<MiningStore, "read" | "create">;
      provider: Pick<Provider, "expectedSet" | "runRowTotals">;
      approvedStatus: StatusReader;
      now?: () => number;
      wait?: (ms: number, signal: AbortSignal) => Promise<void>;
    },
  ) {}

  async recoverCurrent(): Promise<void> {
    const status = await this.dependencies.approvedStatus(this.cancellation.signal);
    if (
      status?.phase === "publisher_complete" &&
      !status.stopRequested &&
      status.run &&
      "profileVersion" in status.run &&
      status.run.profileVersion === D01_CONNECTION_PROFILE_VERSION
    )
      await this.start(status.runId);
  }

  start(runId: string): Promise<void> {
    this.cancellation.signal.throwIfAborted();
    if (this.active) {
      if (this.active.runId === runId) return this.active.work;
      throw new MiningCoordinationError(
        "conflict",
        "A connection reconciliation is already active.",
      );
    }
    const work = this.reconcileWithRetry(runId);
    const current = { runId, work };
    this.active = current;
    void work.then(
      () => {
        if (this.active === current) this.active = undefined;
      },
      (cause: unknown) => {
        if (!this.cancellation.signal.aborted) {
          console.error("[mining-connection-evidence] Reconciliation failed", cause);
        }
        if (this.active === current) this.active = undefined;
      },
    );
    return work;
  }

  async close(): Promise<void> {
    this.cancellation.abort(this.closeReason);
    try {
      await this.active?.work;
    } catch (cause) {
      if (
        cause !== this.closeReason &&
        !(cause instanceof Error && cause.name === "AbortError" && cause.cause === this.closeReason)
      )
        throw cause;
    }
  }

  private async reconcileWithRetry(runId: string): Promise<void> {
    const signal = AbortSignal.any([
      this.cancellation.signal,
      AbortSignal.timeout(reconciliationDeadlineMs),
    ]);
    const initial = await this.dependencies.approvedStatus(signal);
    if (!initial || initial.runId !== runId) {
      throw new MiningCoordinationError("invalid", "The flow run is no longer the approved demo.");
    }
    const binding = connectionRunIdentity(initial);
    const wait =
      this.dependencies.wait ??
      ((ms: number, currentSignal: AbortSignal) => sleep(ms, undefined, { signal: currentSignal }));
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.reconcile(runId, binding, signal);
      } catch (cause) {
        signal.throwIfAborted();
        const retryable =
          (cause instanceof MiningQueryError &&
            ["timeout", "cancelled", "upstream"].includes(cause.code)) ||
          (cause instanceof MiningCoordinationError && cause.code === "storage") ||
          (cause instanceof Error && cause.name === "TimeoutError");
        if (!retryable || attempt >= retryDelaysMs.length) throw cause;
        console.warn(
          "[mining-connection-evidence] Retrying reconciliation after a transient failure",
          {
            runId,
            attempt: attempt + 1,
            cause,
          },
        );
        await wait(retryDelaysMs[attempt], signal);
      }
    }
  }

  private async reconcile(runId: string, binding: string, signal: AbortSignal): Promise<void> {
    const initial = await this.dependencies.approvedStatus(signal);
    if (!initial || initial.runId !== runId || connectionRunIdentity(initial) !== binding) {
      throw new MiningCoordinationError("invalid", "The flow run is no longer the approved demo.");
    }
    const readStatus = async (id: string, currentSignal: AbortSignal) => {
      const current = await this.dependencies.approvedStatus(currentSignal);
      if (!current || current.runId !== id || connectionRunIdentity(current) !== binding) {
        throw new MiningCoordinationError("invalid", "The flow run changed during reconciliation.");
      }
      return current;
    };
    const existing = await this.dependencies.store.read(path(runId), signal);
    if (existing) {
      snapshot(existing.value, initial);
      return;
    }
    const wait =
      this.dependencies.wait ??
      ((ms: number, currentSignal: AbortSignal) => sleep(ms, undefined, { signal: currentSignal }));
    for (;;) {
      const cutoff = (this.dependencies.now ?? Date.now)() - MINING_FLOW_CUTOFF_MARGIN_MS;
      if (initial.run && "stopAt" in initial.run && cutoff < Date.parse(initial.run.stopAt)) {
        await wait(5_000, signal);
        continue;
      }
      const asOf = new Date(cutoff).toISOString();
      const evidence = await readConnectionRunEvidence(
        initial,
        asOf,
        this.dependencies.provider,
        readStatus,
        signal,
      );
      if (evidence.completeAtCutoff) {
        await readStatus(runId, signal);
        const document: Snapshot = { version: 1, runId, binding, evidence };
        snapshot(document, initial);
        const created = await this.dependencies.store.create(path(runId), document);
        signal.throwIfAborted();
        if (!created) {
          const current = await this.dependencies.store.read(path(runId), signal);
          if (!current)
            throw new MiningCoordinationError(
              "uncertain",
              "Connection evidence creation could not be reconciled.",
            );
          snapshot(current.value, initial);
        }
        return;
      }
      await wait(5_000, signal);
    }
  }
}

/** Recheck row counts for late arrivals before presenting the immutable capture. */
export async function readConnectionEvidenceSnapshot(
  status: MiningRunStatus,
  store: Pick<MiningStore, "read">,
  provider: Pick<Provider, "runRowTotals">,
  readStatus: StatusReader,
  signal: AbortSignal,
  now: () => number = Date.now,
) {
  const document = await store.read(path(status.runId), signal);
  if (!document) {
    const stopAt = status.run && "stopAt" in status.run ? Date.parse(status.run.stopAt) : NaN;
    return {
      status:
        Number.isFinite(stopAt) && now() > stopAt + reconciliationDeadlineMs
          ? ("unknown" as const)
          : ("pending" as const),
    };
  }
  const saved = snapshot(document.value, status);
  const asOf = new Date(now() - MINING_FLOW_CUTOFF_MARGIN_MS).toISOString();
  if (Date.parse(asOf) < Date.parse(saved.evidence.asOf)) {
    throw new MiningQueryError("malformed", "Connection evidence is from the future.");
  }
  const totals = await provider.runRowTotals({ runId: status.runId, asOf }, signal);
  const current = await readStatus(signal);
  if (connectionRunIdentity(current) !== saved.binding) {
    throw new MiningQueryError("upstream", "Connection run changed during evidence read.");
  }
  const unchanged =
    totals.rawRows === saved.evidence.rawRows &&
    totals.validatedRows === saved.evidence.validatedRows &&
    totals.rawReceiptTimeMissing === 0 &&
    totals.validatedReceiptTimeMissing === 0;
  return {
    status: unchanged ? ("complete" as const) : ("changed" as const),
    asOf: saved.evidence.asOf,
    checkedAt: asOf,
    provenance: "fabric-connection-reconciliation-v1" as const,
  };
}

export function configuredMiningConnectionEvidenceWorker(env: NodeJS.ProcessEnv = process.env) {
  if (
    env.MINING_UNPINNED_STREAM_ENABLED === "true" ||
    env.MINING_PUBLIC_DEMO_ENABLED !== "true" ||
    env.MINING_PUBLIC_DEMO_READ_ENABLED !== "true" ||
    env.MINING_CONNECTION_FLOW_READ_ENABLED !== "true" ||
    env.MINING_PUBLIC_DEMO_CONNECTION_FLOW_ENABLED !== "true"
  )
    return undefined;
  const store = configuredMiningStore(env);
  if (!store)
    throw new MiningCoordinationError(
      "configuration",
      "Connection evidence persistence is unavailable.",
    );
  const coordinator = new MiningRunCoordinator(store);
  const provider = createMiningConnectionFlowProvider(
    createBoundedMiningQuery({
      ...env,
      EVENTHOUSE_QUERY_URI: env.MINING_EVENTHOUSE_QUERY_URI,
      EVENTHOUSE_DATABASE_NAME: env.MINING_EVENTHOUSE_DATABASE_NAME,
    }),
  );
  return new MiningConnectionEvidenceWorker({
    store,
    provider,
    approvedStatus: async (signal) => {
      const status = await coordinator.currentStatus(signal);
      if (status?.admission !== "accepted" || status.stopRequested || !status.run) return undefined;
      const marker = await store.read(`public-demo/${status.runId}.json`, signal);
      const value = marker?.value;
      if (
        !value ||
        typeof value !== "object" ||
        !("version" in value) ||
        value.version !== 1 ||
        !("runId" in value) ||
        value.runId !== status.runId
      )
        return undefined;
      return status;
    },
  });
}
