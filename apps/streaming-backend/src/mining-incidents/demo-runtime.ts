import { setTimeout as sleep } from "node:timers/promises";
import { configuredMiningStore } from "../mining/blob-store.js";
import {
  MiningRunCoordinator,
  assertBoundedMiningRun,
  type MiningRunRecord,
  type BoundedMiningRunRecord,
} from "../mining/run-coordinator.js";
import { MiningCoordinationError } from "../mining/store.js";
import { createBoundedMiningQuery, MiningQueryError } from "../mining/read/bounded-query.js";
import { mapMiningIngestion } from "../mining/read/ingestion-dto.js";
import { createD01VersionedIncidentRun, type D01RunContract } from "./catalog.js";
import {
  assertReconciledIncidentObservations,
  createFabricIncidentSource,
} from "./fabric-source.js";
import {
  MiningIncidentRuntime,
  readMiningIncidentJournal,
  type MiningIncidentStore,
} from "./runtime.js";

type Query = ReturnType<typeof createBoundedMiningQuery>;
interface Dependencies {
  store: MiningIncidentStore;
  query: Query;
  approvedRun(signal: AbortSignal): Promise<MiningRunRecord | undefined>;
  now?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export const demoIncidentPath = (path: string) => `public-demo-reconciliation/${path}`;

function assertRun(
  run: MiningRunRecord,
): asserts run is BoundedMiningRunRecord & { contract: D01RunContract } {
  assertBoundedMiningRun(run);
  if (
    !run.contract ||
    run.durationSeconds !== 300 ||
    run.scenario !== "normal" ||
    run.phase !== "publisher_complete"
  ) {
    throw new MiningCoordinationError(
      "invalid",
      "Incident reconciliation requires a completed public demo run.",
    );
  }
  createD01VersionedIncidentRun({ ...run, contract: run.contract });
}

/**
 * Explicit service-owned lifecycle after publication. GETs never activate it.
 * Evaluations describe reconciled event time, not what an operator knew then.
 */
export class MiningDemoIncidentProcessor {
  private readonly cancellation = new AbortController();
  private active?: { runId: string; work: Promise<void> };
  private readonly now: () => number;
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly store: MiningIncidentStore;
  private readonly closeReason = new MiningCoordinationError(
    "cancelled",
    "Incident reconciliation host closed.",
  );

  constructor(private readonly dependencies: Dependencies) {
    this.now = dependencies.now ?? Date.now;
    this.wait = dependencies.wait ?? ((ms, signal) => sleep(ms, undefined, { signal }));
    const store = dependencies.store;
    this.store = {
      read: (path, signal) => store.read(demoIncidentPath(path), signal),
      create: (path, value) => store.create(demoIncidentPath(path), value),
      write: (path, value, etag, leaseId) =>
        store.write(demoIncidentPath(path), value, etag, leaseId),
      acquire: (path, leaseId) => store.acquire(demoIncidentPath(path), leaseId),
      renew: (path, leaseId) => store.renew(demoIncidentPath(path), leaseId),
      release: (path, leaseId) => store.release(demoIncidentPath(path), leaseId),
    };
  }

  async recoverCurrent(): Promise<void> {
    const run = await this.dependencies.approvedRun(this.cancellation.signal);
    if (run?.phase === "publisher_complete") await this.start(run.runId);
  }

  start(runId: string): Promise<void> {
    this.cancellation.signal.throwIfAborted();
    if (this.active) {
      if (this.active.runId === runId) return this.active.work;
      throw new MiningCoordinationError(
        "conflict",
        "An incident reconciliation is already active.",
      );
    }
    const work = this.reconcile(runId);
    const active = { runId, work };
    this.active = active;
    void work.then(
      () => {
        if (this.active === active) this.active = undefined;
      },
      (cause: unknown) => {
        if (!this.isCloseCancellation(cause)) {
          console.error(
            "[mining-demo-incidents] Reconciliation failed; incident assessments unavailable",
            cause,
          );
        }
        if (this.active === active) this.active = undefined;
      },
    );
    return work;
  }

  async close(): Promise<void> {
    this.cancellation.abort(this.closeReason);
    try {
      await this.active?.work;
    } catch (cause) {
      if (!this.isCloseCancellation(cause)) throw cause;
    }
  }

  private isCloseCancellation(cause: unknown): boolean {
    return (
      cause === this.closeReason ||
      (cause instanceof Error && cause.name === "AbortError" && cause.cause === this.closeReason)
    );
  }

  private async reconcile(runId: string): Promise<void> {
    const signal = AbortSignal.any([this.cancellation.signal, AbortSignal.timeout(480_000)]);
    const readRun = async (currentSignal = signal) => {
      currentSignal.throwIfAborted();
      const run = await this.dependencies.approvedRun(currentSignal);
      if (!run || run.runId !== runId) {
        throw new MiningCoordinationError(
          "invalid",
          "The incident run is no longer the authorized public demo.",
        );
      }
      assertRun(run);
      return run;
    };
    const run = await readRun();
    const definition = createD01VersionedIncidentRun({ ...run, contract: run.contract });
    const binding = JSON.stringify(definition);
    const checkRun = async (currentSignal = signal) => {
      const current = await readRun(currentSignal);
      if (
        JSON.stringify(
          createD01VersionedIncidentRun({ ...current, contract: current.contract }),
        ) !== binding
      ) {
        throw new MiningCoordinationError("invalid", "The approved incident run binding changed.");
      }
    };
    const ingestion = async () => {
      const asOf = new Date(this.now()).toISOString();
      const rows = await this.dependencies.query(
        { kind: "ingestion", runId, asOf, maxRows: 5 },
        signal,
      );
      return mapMiningIngestion(run, asOf, rows).status;
    };
    while ((await ingestion()) !== "complete") {
      await checkRun();
      await this.wait(5_000, signal);
      signal.throwIfAborted();
    }
    const batch = await createFabricIncidentSource(
      definition,
      this.dependencies.query,
      this.now,
    ).read({
      runId,
      asOf: run.stopAt,
      committed: [],
      signal,
    });
    assertReconciledIncidentObservations(run, batch.observations);
    if ((await ingestion()) !== "complete") {
      throw new MiningQueryError(
        "upstream",
        "Incident source reconciliation changed during capture.",
      );
    }
    await checkRun();
    const existing = await readMiningIncidentJournal(this.store, definition, {
      signal,
      includeObservations: true,
    });
    assertReconciledIncidentObservations(run, batch.observations, existing?.observations);
    if (existing?.asOf === run.stopAt) {
      assertReconciledIncidentObservations(run, existing.observations ?? []);
      return;
    }
    const runtime = await MiningIncidentRuntime.open(
      definition,
      existing ? "recover" : "fresh",
      {
        store: this.store,
        now: this.now,
        authority: {
          authorize: async (operation, _run, operationSignal) => {
            if (operation === "acknowledge") {
              throw new MiningCoordinationError(
                "invalid",
                "Public demo incident acknowledgement is not enabled.",
              );
            }
            await checkRun(AbortSignal.any([signal, operationSignal]));
          },
          checkRun: async (_run, operationSignal) =>
            checkRun(AbortSignal.any([signal, operationSignal])),
        },
        source: {
          read: async ({ asOf, committed, signal: readSignal }) => {
            readSignal.throwIfAborted();
            const known = new Set(committed.map((observation) => observation.eventId));
            return {
              observations: batch.observations.filter(
                (observation) => observation.timestamp <= asOf && !known.has(observation.eventId),
              ),
              receivedAt: batch.receivedAt,
            };
          },
        },
      },
      signal,
    );
    try {
      for (let minute = 0; minute <= 5; minute++) {
        await runtime.processMinute(
          new Date(Date.parse(run.startedAt) + minute * 60_000).toISOString(),
        );
      }
    } catch (cause) {
      try {
        await runtime.close();
      } catch (cleanup) {
        throw new AggregateError([cause, cleanup], "Incident reconciliation and cleanup failed.", {
          cause: cleanup,
        });
      }
      throw cause;
    }
    await runtime.close();
  }
}

export function configuredMiningDemoIncidentProcessor(env: NodeJS.ProcessEnv = process.env) {
  if (
    env.MINING_PUBLIC_DEMO_ENABLED !== "true" ||
    env.MINING_PUBLIC_DEMO_READ_ENABLED !== "true" ||
    env.MINING_INGESTION_RECONCILIATION_ENABLED !== "true"
  )
    return undefined;
  const store = configuredMiningStore(env);
  if (!store)
    throw new MiningCoordinationError("configuration", "Demo incident persistence is unavailable.");
  const coordinator = new MiningRunCoordinator(store);
  const query = createBoundedMiningQuery({
    ...env,
    EVENTHOUSE_QUERY_URI: env.MINING_EVENTHOUSE_QUERY_URI,
    EVENTHOUSE_DATABASE_NAME: env.MINING_EVENTHOUSE_DATABASE_NAME,
  });
  return new MiningDemoIncidentProcessor({
    store,
    query,
    approvedRun: async (signal) => {
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
      return status.run;
    },
  });
}
