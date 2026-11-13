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
  type MiningRunStatus,
  type StartMiningRun,
} from "./run-coordinator.js";

const STEP_MS = 5_000;
const MAX_LATENESS_MS = 1_000;
const SEND_TIMEOUT_MS = 2_000;

export interface MiningScheduler {
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
}

const systemClock: MiningClock = { now: Date.now, monotonic: () => performance.now() };
const systemScheduler: MiningScheduler = {
  wait: async (milliseconds, signal) => {
    await sleep(milliseconds, undefined, { signal });
  },
};

/** Explicit trusted-backend call only. Construction/status never launches a publisher. */
export class MiningPublisherRuntime {
  constructor(
    private readonly coordinator: MiningRunCoordinator,
    private readonly publisher: () => D01Publisher,
    private readonly clock: MiningClock = systemClock,
    private readonly scheduler: MiningScheduler = systemScheduler,
  ) {}

  status(runId: string) {
    return this.coordinator.status(runId);
  }

  requestStop(runId: string) {
    return this.coordinator.requestStop(runId);
  }

  /** Caller must await settlement, including transport cleanup. No adoption on observed admission. */
  async run(input: StartMiningRun, cancellation?: AbortSignal): Promise<MiningRunStatus> {
    cancellation?.throwIfAborted();
    const admission = await this.coordinator.start(input);
    if (admission.kind === "observed") return admission.status;
    const { owner, run } = admission;
    const startedAt = Date.parse(run.startedAt);
    const firstTick = this.clock.monotonic() - (this.clock.now() - startedAt);
    const signal = cancellation ? AbortSignal.any([owner.signal, cancellation]) : owner.signal;
    let transport: D01Publisher | undefined;
    let failure: Error | undefined;
    let stopped = false;
    try {
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
    } catch (error) {
      if (
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
    try {
      await owner.finish(failure ? "failed" : "publisher_complete");
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], "Mining execution and terminal persistence failed.")
        : publisherError(error);
    }
    if (failure) throw failure;
    const status = await this.coordinator.status(run.runId);
    if (!status) throw new Error("Mining terminal status is unavailable.");
    return status;
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
