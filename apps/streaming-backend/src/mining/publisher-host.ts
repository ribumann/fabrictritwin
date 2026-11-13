import {
  configuredMiningPublisherRuntime,
  type MiningPublisherAdmission,
  type MiningPublisherIncidents,
  type MiningPublisherRuntime,
} from "./publisher-runtime.js";
import type { MiningRunStatus, StartMiningRun } from "./run-coordinator.js";
import { MiningCoordinationError } from "./store.js";

export interface MiningPublisherExecution {
  admission: Promise<MiningPublisherAdmission>;
  completion: Promise<MiningRunStatus>;
}

/** Trusted-host lifecycle only; authentication and activation remain the caller's responsibility. */
export class MiningPublisherHost {
  private readonly factory: () => MiningPublisherRuntime | undefined;
  private active?: { controller: AbortController; execution: MiningPublisherExecution };
  private closed = false;
  private closing?: Promise<void>;

  constructor(factory?: () => MiningPublisherRuntime | undefined) {
    const env = { ...process.env };
    this.factory = factory ?? (() => configuredMiningPublisherRuntime(env));
  }

  start(
    input: StartMiningRun,
    requestSignal?: AbortSignal,
    incidents?: MiningPublisherIncidents,
  ): MiningPublisherExecution {
    if (this.closed) {
      throw new MiningCoordinationError("cancelled", "Mining publisher host is shutting down.");
    }
    if (this.active) {
      throw new MiningCoordinationError(
        "conflict",
        "This host already owns an execution. Reconcile durable run status instead of restarting.",
      );
    }
    requestSignal?.throwIfAborted();
    const runtime = this.factory();
    if (!runtime) {
      throw new MiningCoordinationError("configuration", "Mining publisher is not enabled.");
    }
    const snapshot = { ...input };
    const controller = new AbortController();
    const abortAdmission = () => controller.abort(requestSignal?.reason);
    requestSignal?.addEventListener("abort", abortAdmission, { once: true });
    if (requestSignal?.aborted) abortAdmission();
    let resolveAdmission!: (admission: MiningPublisherAdmission) => void;
    let rejectAdmission!: (cause: unknown) => void;
    const admission = new Promise<MiningPublisherAdmission>((resolve, reject) => {
      resolveAdmission = resolve;
      rejectAdmission = reject;
    });
    // Keep early rejection observable; the completion observer reports the same failure.
    void admission.catch(() => {});
    let notified = false;
    const completion = Promise.resolve()
      .then(() =>
        runtime.run(snapshot, controller.signal, incidents, (result) => {
          requestSignal?.throwIfAborted();
          requestSignal?.removeEventListener("abort", abortAdmission);
          notified = true;
          resolveAdmission(result);
        }),
      )
      .then((status) => {
        if (!notified) {
          throw new MiningCoordinationError(
            "uncertain",
            "Publisher settled without an admission notification.",
          );
        }
        return status;
      });
    const execution = { admission, completion };
    this.active = { controller, execution };
    const release = () => {
      requestSignal?.removeEventListener("abort", abortAdmission);
      if (this.active?.execution === execution) this.active = undefined;
    };
    void completion.then(
      () => {
        release();
      },
      (cause: unknown) => {
        rejectAdmission(cause);
        console.error("[mining-publisher-host] Execution failed; reconcile durable status", cause);
        release();
      },
    );
    return execution;
  }

  /** Stops new calls, aborts owned work, and joins actual transport and persistence settlement. */
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      const active = this.active;
      active?.controller.abort(new Error("Mining publisher host is shutting down."));
      this.closing = active ? active.execution.completion.then(() => {}) : Promise.resolve();
    }
    return this.closing;
  }
}
