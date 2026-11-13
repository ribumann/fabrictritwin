import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createD01Simulation,
  D01EventstreamPublisher,
  type D01Publisher,
} from "@triathlon-twin/simulator/mining";
import { configuredMiningStore } from "./blob-store.js";
import { MiningCoordinationError } from "./store.js";
import {
  MiningRunCoordinator,
  type MiningClock,
  type MiningRunRecord,
  type MiningRunStatus,
  type StartMiningRun,
} from "./run-coordinator.js";
import {
  MiningIncidentRuntime,
  type MiningIncidentDependencies,
} from "../mining-incidents/runtime.js";
import { createD01IncidentRun } from "../mining-incidents/catalog.js";

const STEP_MS = 5_000;
const MAX_LATENESS_MS = 1_000;
const SEND_TIMEOUT_MS = 2_000;

export interface MiningScheduler {
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
}

/** Supplied only by a trusted host with delegated authorization and a curated source. */
export interface MiningPublisherIncidents {
  dependencies: MiningIncidentDependencies;
}

const systemClock: MiningClock = { now: Date.now, monotonic: () => performance.now() };
const systemScheduler: MiningScheduler = {
  wait: async (milliseconds, signal) => {
    await sleep(milliseconds, undefined, { signal });
  },
};

/** Explicit trusted-backend call only. Construction/status never launches a publisher. */
export class MiningPublisherRuntime {
  private readonly incidents = new Map<string, IncidentExecution>();

  constructor(
    private readonly coordinator: MiningRunCoordinator,
    private readonly publisher: () => D01Publisher,
    private readonly clock: MiningClock = systemClock,
    private readonly scheduler: MiningScheduler = systemScheduler,
  ) {}

  status(runId: string) {
    return this.coordinator.status(runId);
  }

  async requestStop(runId: string) {
    return this.coordinator.requestStop(
      runId,
      () => this.incidents.get(runId)?.requestStop(),
      (error) => this.incidents.get(runId)?.fail(error),
    );
  }

  /** Caller must await settlement, including transport cleanup. No adoption on observed admission. */
  async run(
    input: StartMiningRun,
    cancellation?: AbortSignal,
    incidents?: MiningPublisherIncidents,
  ): Promise<MiningRunStatus> {
    cancellation?.throwIfAborted();
    if (incidents && (input.durationSeconds ?? 1_200) % 60 !== 0) {
      throw new MiningCoordinationError("invalid", "Incident processing requires whole minutes.");
    }
    const admission = await this.coordinator.start(input);
    if (admission.kind === "observed") return admission.status;
    const { owner, run } = admission;
    const startedAt = Date.parse(run.startedAt);
    const firstTick = this.clock.monotonic() - (this.clock.now() - startedAt);
    const incidentFailure = new AbortController();
    const signal = AbortSignal.any(
      [owner.signal, cancellation, incidentFailure.signal].filter(
        (item): item is AbortSignal => item !== undefined,
      ),
    );
    let transport: D01Publisher | undefined;
    let failure: Error | undefined;
    let stopped = false;
    let incident: IncidentExecution | undefined;
    let stopIncident: (() => void) | undefined;
    try {
      if (incidents) {
        const execution = new IncidentExecution(run, incidents, (error) =>
          incidentFailure.abort(error),
        );
        incident = execution;
        this.incidents.set(run.runId, execution);
        owner.onBeforeComplete(() => execution.settle());
        stopIncident = () => execution.stop();
        signal.addEventListener("abort", stopIncident, { once: true });
        if (signal.aborted) stopIncident();
        await owner.heartbeat();
        if (owner.signal.aborted) {
          stopped = (await this.coordinator.status(run.runId))?.phase === "stopped";
          if (!stopped) throw new Error("Mining authority ended before incident activation.");
        } else {
          await incident.start();
        }
      }
      if (!stopped) {
        const activeTransport = this.publisher();
        transport = activeTransport;
        const simulation = createD01Simulation({ ...run, startedAt: new Date(startedAt) });
        for (let elapsed = STEP_MS; elapsed <= run.durationSeconds * 1_000; elapsed += STEP_MS) {
          const wallDeadline = startedAt + elapsed;
          const tickDeadline = firstTick + elapsed;
          while (this.clock.monotonic() < tickDeadline) {
            await this.scheduler.wait(tickDeadline - this.clock.monotonic(), signal);
            signal.throwIfAborted();
          }
          const checkDeadline = () => {
            const wallLate = this.clock.now() - wallDeadline;
            const tickLate = this.clock.monotonic() - tickDeadline;
            if (
              wallLate < 0 ||
              wallLate > MAX_LATENESS_MS ||
              tickLate < 0 ||
              tickLate > MAX_LATENESS_MS
            ) {
              throw new Error("Mining step missed its real-clock deadline; catch-up is forbidden.");
            }
          };
          checkDeadline();
          if (elapsed === run.durationSeconds * 1_000 && !run.finalFlushUntil) {
            throw new Error("Mining strict deadline leaves no final-batch delivery budget.");
          }
          await owner.heartbeat();
          if (owner.signal.aborted) {
            const status = await this.coordinator.status(run.runId);
            if (status?.phase !== "stopped") {
              throw new Error("Mining authority ended before all simulator batches were sent.");
            }
            stopped = true;
            break;
          }
          signal.throwIfAborted();
          checkDeadline();
          simulation.step(new Date(wallDeadline));
          const batch = simulation.getPendingBatch();
          if (batch) {
            const send = async (authority: AbortSignal) => {
              checkDeadline();
              const timeout = new AbortController();
              const timer = setTimeout(
                () => timeout.abort(new Error("Mining send timed out.")),
                SEND_TIMEOUT_MS,
              );
              const sendSignal = AbortSignal.any([authority, signal, timeout.signal]);
              const sendTick = this.clock.monotonic();
              const sendWall = this.clock.now();
              try {
                await activeTransport.publish(batch.events, sendSignal);
                sendSignal.throwIfAborted();
                if (
                  this.clock.monotonic() - sendTick >= SEND_TIMEOUT_MS ||
                  this.clock.now() < sendWall ||
                  this.clock.now() - sendWall >= SEND_TIMEOUT_MS
                ) {
                  throw new Error("Mining transport settled after its bounded deadline.");
                }
                simulation.acknowledgeBatch(batch.batch_id);
              } finally {
                clearTimeout(timer);
              }
            };
            if (elapsed === run.durationSeconds * 1_000 && run.finalFlushUntil) {
              await owner.runFinalBatch({ runId: run.runId, timestamp: batch.timestamp }, send);
            } else {
              await owner.runBatch(send);
            }
          }
        }
        if (!stopped) signal.throwIfAborted();
        if (
          !stopped &&
          (simulation.elapsedSecondsSoFar !== run.durationSeconds || simulation.getPendingBatch())
        ) {
          throw new Error("Mining final batch was not delivered; publisher is incomplete.");
        }
      }
    } catch (error) {
      if (incident?.stopRequested && isIncidentStop(error) && !cancellation?.aborted) {
        try {
          await owner.heartbeat();
          stopped = (await this.coordinator.status(run.runId))?.phase === "stopped";
        } catch (stopError) {
          failure = publisherError(stopError);
        }
      }
      if (
        !stopped &&
        error instanceof MiningCoordinationError &&
        error.code === "cancelled" &&
        !cancellation?.aborted
      ) {
        try {
          stopped = (await this.coordinator.status(run.runId))?.phase === "stopped";
        } catch (statusError) {
          failure = new AggregateError([error, statusError], "Mining cancellation is unconfirmed.");
        }
      }
      if (!stopped && !failure) failure = publisherError(error);
    }

    incident?.stop();
    // Close only after the actual send promise settles; never release authority around live I/O.
    if (transport) {
      try {
        await transport.close();
      } catch (error) {
        failure = failure
          ? new AggregateError([failure, error], "Mining send and transport cleanup failed.")
          : publisherError(error);
      }
    }
    if (incident) {
      try {
        await incident.settle();
      } catch (error) {
        if (error !== failure) {
          failure = failure
            ? new AggregateError([failure, error], "Mining execution and incident cleanup failed.")
            : publisherError(error);
        }
      }
    }
    try {
      await owner.finish(failure ? "failed" : "publisher_complete");
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], "Mining execution and terminal persistence failed.")
        : publisherError(error);
    }
    if (stopIncident) signal.removeEventListener("abort", stopIncident);
    if (incident && this.incidents.get(run.runId) === incident) this.incidents.delete(run.runId);
    if (failure) throw failure;
    const status = await this.coordinator.status(run.runId);
    if (!status) throw new Error("Mining terminal status is unavailable.");
    return status;
  }
}

const incidentStopped = new MiningCoordinationError("cancelled", "Incident lifecycle stopped.");

function isIncidentStop(error: unknown): boolean {
  return (
    error === incidentStopped ||
    (error instanceof Error && error.name === "AbortError" && error.cause === incidentStopped)
  );
}

class IncidentExecution {
  private readonly cancellation = new AbortController();
  private runtime?: MiningIncidentRuntime;
  private work?: Promise<{ error?: unknown; failed: boolean }>;
  private closing?: Promise<{ error?: unknown; failed: boolean }>;
  private stopping = false;
  stopRequested = false;

  constructor(
    private readonly run: MiningRunRecord,
    private readonly config: MiningPublisherIncidents,
    private readonly onFailure: (error: Error) => void,
  ) {}

  async start(): Promise<void> {
    const opening = MiningIncidentRuntime.open(
      createD01IncidentRun(this.run),
      "fresh",
      this.config.dependencies,
      this.cancellation.signal,
    );
    this.work = opening
      .then(async (runtime) => {
        this.runtime = runtime;
        if (this.stopping) this.close();
        else await runtime.runScheduled();
      })
      .then(
        () => ({ failed: false }),
        (error: unknown) => {
          if (!this.stopping) this.onFailure(publisherError(error));
          return { failed: true, error };
        },
      );
    await opening;
    this.cancellation.signal.throwIfAborted();
  }

  requestStop(): void {
    this.stopRequested = true;
    this.stop();
  }

  fail(error: unknown): void {
    this.onFailure(publisherError(error));
    this.stop();
  }

  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.cancellation.abort(incidentStopped);
    this.close();
  }

  private close(): void {
    if (this.runtime && !this.closing) {
      try {
        this.closing = this.runtime.close().then(
          () => ({ failed: false }),
          (error: unknown) => ({ failed: true, error }),
        );
      } catch (error) {
        this.closing = Promise.resolve({ failed: true, error });
      }
    }
  }

  async settle(): Promise<void> {
    this.stop();
    const work = await this.work;
    const closing = await this.closing;
    const errors: unknown[] = [];
    if (work?.failed && !isIncidentStop(work.error)) errors.push(work.error);
    if (closing?.failed) errors.push(closing.error);
    if (errors.length === 1) throw publisherError(errors[0]);
    if (errors.length > 1)
      throw new AggregateError(errors, "Incident processing and close failed.");
  }
}

function publisherError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Mining publisher failed.", { cause: error });
}

/** No HTTP/startup binding. Authenticated run authorization is an independent activation gate. */
export function configuredMiningPublisherRuntime(
  env: NodeJS.ProcessEnv = process.env,
): MiningPublisherRuntime | undefined {
  if (env.MINING_PUBLISHER_ENABLED === undefined || env.MINING_PUBLISHER_ENABLED === "false") {
    return undefined;
  }
  if (env.MINING_PUBLISHER_ENABLED !== "true") {
    throw new Error("MINING_PUBLISHER_ENABLED must be true or false.");
  }
  const connectionString = env.MINING_EVENTSTREAM_EVENTHUB_CONNECTION_STRING?.trim();
  if (!connectionString) {
    throw new Error("Mining requires its own MINING_EVENTSTREAM_EVENTHUB_CONNECTION_STRING.");
  }
  const store = configuredMiningStore(env);
  if (!store) throw new Error("Mining publisher requires enabled durable coordination.");
  const flushBudget = env.MINING_FINAL_FLUSH_MILLISECONDS;
  if (flushBudget !== undefined && !/^(?:0|[1-9][0-9]{0,3})$/.test(flushBudget)) {
    throw new Error("MINING_FINAL_FLUSH_MILLISECONDS must be an integer from 0 to 5000.");
  }
  return new MiningPublisherRuntime(
    new MiningRunCoordinator(store, systemClock, {
      finalFlushMilliseconds: flushBudget === undefined ? 0 : Number(flushBudget),
    }),
    () => new D01EventstreamPublisher(connectionString),
  );
}
