import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { configuredMiningStore } from "./blob-store.js";
import { MiningPublisherHost } from "./publisher-host.js";
import { configuredMiningPublisherRuntime } from "./publisher-runtime.js";
import { MiningRunCoordinator } from "./run-coordinator.js";

export function miningContinuousConfiguration(env: NodeJS.ProcessEnv): string | undefined {
  const enabled = env.MINING_CONTINUOUS_ENABLED;
  if (enabled === undefined || enabled === "false") return undefined;
  if (enabled !== "true") throw new Error("MINING_CONTINUOUS_ENABLED must be true or false.");
  const generation = env.MINING_CONTINUOUS_GENERATION;
  if (!generation || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(generation)) {
    throw new Error("Continuous Mining requires an explicit MINING_CONTINUOUS_GENERATION.");
  }
  if (env.MINING_PUBLISHER_ENABLED !== "true") {
    throw new Error("Continuous Mining requires the durable publisher enabled.");
  }
  return generation;
}

/** App lifetime, never browser lifetime. All replicas compete through the same plant lease. */
export class MiningContinuousWorker {
  private readonly cancellation = new AbortController();
  private execution?: Promise<void>;
  private closing?: Promise<void>;

  constructor(
    private readonly generation: string,
    private readonly host: Pick<MiningPublisherHost, "startContinuous" | "close">,
    private readonly coordinator: Pick<
      MiningRunCoordinator,
      "currentStatus" | "continuousGenerationHeld"
    >,
    private readonly wait = (milliseconds: number, signal: AbortSignal) =>
      sleep(milliseconds, undefined, { signal }),
  ) {}

  start(): void {
    if (this.execution || this.cancellation.signal.aborted) return;
    this.execution = this.run();
    void this.execution.catch((cause: unknown) => {
      console.error("[mining-continuous] Worker stopped unexpectedly; restart required", cause);
    });
  }

  private async run(): Promise<void> {
    const signal = this.cancellation.signal;
    let backoffMs = 30_000;
    while (!signal.aborted) {
      let delay = 30_000;
      try {
        const held = await this.coordinator.continuousGenerationHeld(this.generation, signal);
        const status = held ? undefined : await this.coordinator.currentStatus(signal);
        signal.throwIfAborted();
        if (!held && (!status || !["running", "stopping"].includes(status.phase))) {
          const execution = this.host.startContinuous({
            plantId: "D01",
            requestId: randomUUID(),
            generation: this.generation,
          });
          // Joining completion also joins actual I/O. Never abandon a send to admit a replacement.
          await execution.completion;
        }
        backoffMs = 30_000;
      } catch (cause) {
        if (signal.aborted) break;
        console.error(
          "[mining-continuous] Publisher unavailable; retry after bounded backoff",
          cause,
        );
        delay = backoffMs;
        backoffMs = Math.min(300_000, backoffMs * 2);
      }
      if (!signal.aborted) {
        try {
          await this.wait(delay, signal);
        } catch (cause) {
          if (!signal.aborted) throw cause;
        }
      }
    }
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.cancellation.abort(new Error("Continuous Mining worker is shutting down."));
      this.closing = Promise.allSettled([this.host.close(), this.execution]).then((results) => {
        const failures = results
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason as unknown);
        if (failures.length)
          throw new AggregateError(failures, "Continuous Mining shutdown failed.");
      });
    }
    return this.closing;
  }
}

export function configuredMiningContinuousWorker(env: NodeJS.ProcessEnv = process.env) {
  const snapshot = { ...env };
  const generation = miningContinuousConfiguration(snapshot);
  if (!generation) return undefined;
  const store = configuredMiningStore(snapshot);
  if (!store) throw new Error("Continuous Mining requires durable Blob coordination.");
  const runtime = configuredMiningPublisherRuntime(snapshot);
  if (!runtime) throw new Error("Continuous Mining publisher is unavailable.");
  return new MiningContinuousWorker(
    generation,
    new MiningPublisherHost(() => runtime),
    new MiningRunCoordinator(store),
  );
}
