import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { traceTwinSend } from "../services/twin-latency.js";
import {
  D01_CONNECTION_PROFILE_VERSION,
  D01_CONNECTION_BALANCE_TOLERANCE,
  createD01Simulation,
  createD01SharedFlowSimulation,
  D01EventstreamPublisher,
  D01ConnectionEventstreamPublisher,
  getD01EventstreamTarget,
  assertD01ConnectionEventstreamConfiguration,
  D01_CONNECTION_MAX_BATCH_EVENTS,
  toD01TransportBody,
  type D01Publisher,
  type D01ConnectionPublisher,
  type D01TransportBody,
  type D01ConnectionMeasurementEvent,
} from "@triathlon-twin/simulator/mining";
import { configuredMiningStore } from "./blob-store.js";
import { MiningCoordinationError } from "./store.js";
import {
  MiningRunCoordinator,
  isContinuousMiningRun,
  isPreparedSharedFlowRun,
  MINING_OWNER_HEARTBEAT_INTERVAL_MS,
  type BoundedMiningRunRecord,
  type MiningClock,
  type MiningRunStatus,
  type MiningConnectionRunProfilePin,
  type StartMiningRun,
  type StartContinuousMiningRun,
  createMiningConnectionRunProfilePin,
} from "./run-coordinator.js";
import {
  MiningIncidentRuntime,
  type MiningIncidentDependencies,
} from "../mining-incidents/runtime.js";
import { createD01VersionedIncidentRun } from "../mining-incidents/catalog.js";

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

export interface MiningPublisherAdmission {
  kind: "started" | "observed";
  status: MiningRunStatus;
}

export interface MiningStartupPreview {
  runId: string;
  sampleTime: string;
  hopperTonnes: number;
}
export type MiningPreviewObserver = (
  preview: MiningStartupPreview,
  elapsedSeconds: number,
  signal: AbortSignal,
) => void | Promise<void>;
export type MiningBatchObserver = (
  runId: string,
  sampleTime: string,
  events: readonly D01TransportBody[],
  signal: AbortSignal,
) => void;
export type MiningConnectionRunProfilePinHandler = (
  profile: MiningConnectionRunProfilePin,
  signal: AbortSignal,
) => void | string | Promise<void | string>;

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
    private readonly publisher: (sharedFlow?: boolean) => D01Publisher,
    private readonly clock: MiningClock = systemClock,
    private readonly scheduler: MiningScheduler = systemScheduler,
    private readonly connectionPublisher?: () => D01ConnectionPublisher,
    private readonly connectionRunProfilePin?: MiningConnectionRunProfilePinHandler,
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
    onAdmission?: (admission: MiningPublisherAdmission) => void,
    onStartup?: (preview: MiningStartupPreview) => void,
    onBatch?: MiningBatchObserver,
    onPreview?: MiningPreviewObserver,
    connectionRunProfilePin?: MiningConnectionRunProfilePinHandler,
  ): Promise<MiningRunStatus> {
    cancellation?.throwIfAborted();
    const profilePin = connectionRunProfilePin ?? this.connectionRunProfilePin;
    if (input.profileVersion === D01_CONNECTION_PROFILE_VERSION) {
      if (!this.connectionPublisher) {
        throw new MiningCoordinationError(
          "configuration",
          "The shared-flow connection transport is not enabled.",
        );
      }
      if (!profilePin) {
        throw new MiningCoordinationError(
          "configuration",
          "The shared-flow run requires an awaited external profile pin.",
        );
      }
      if (incidents) {
        throw new MiningCoordinationError(
          "invalid",
          "Legacy incident processing cannot run on the shared-flow profile.",
        );
      }
    }
    if (incidents && (input.durationSeconds ?? 1_200) % 60 !== 0) {
      throw new MiningCoordinationError("invalid", "Incident processing requires whole minutes.");
    }
    return this.execute(
      () => this.coordinator.start(input),
      cancellation,
      incidents,
      onAdmission,
      onStartup,
      onBatch,
      onPreview,
      profilePin,
    );
  }

  /** Trusted worker only. Continuous execution never activates finite incident processing. */
  runContinuous(
    input: StartContinuousMiningRun,
    cancellation?: AbortSignal,
    onAdmission?: (admission: MiningPublisherAdmission) => void,
  ): Promise<MiningRunStatus> {
    return this.execute(
      () => this.coordinator.startContinuous(input),
      cancellation,
      undefined,
      onAdmission,
    );
  }

  private async execute(
    admit: () => ReturnType<MiningRunCoordinator["start"]>,
    cancellation?: AbortSignal,
    incidents?: MiningPublisherIncidents,
    onAdmission?: (admission: MiningPublisherAdmission) => void,
    onStartup?: (preview: MiningStartupPreview) => void,
    onBatch?: MiningBatchObserver,
    onPreview?: MiningPreviewObserver,
    profilePin?: MiningConnectionRunProfilePinHandler,
  ): Promise<MiningRunStatus> {
    cancellation?.throwIfAborted();
    const admission = await admit();
    if (admission.kind === "observed") {
      cancellation?.throwIfAborted();
      onAdmission?.({ kind: "observed", status: admission.status });
      return admission.status;
    }
    const { owner, run } = admission;
    const continuous = isContinuousMiningRun(run);
    const preparedSharedFlow = isPreparedSharedFlowRun(run);
    const sharedFlow =
      !continuous &&
      "profileVersion" in run &&
      run.profileVersion === D01_CONNECTION_PROFILE_VERSION;
    const durationMs = continuous ? null : run.durationSeconds * 1_000;
    let startedAt = Date.parse(run.startedAt);
    let firstTick = this.clock.monotonic() - (this.clock.now() - startedAt);
    const incidentFailure = new AbortController();
    const signal = AbortSignal.any(
      [owner.signal, cancellation, incidentFailure.signal].filter(
        (item): item is AbortSignal => item !== undefined,
      ),
    );
    let transport: D01Publisher | undefined;
    let connectionTransport: D01ConnectionPublisher | undefined;
    let transportPreparation: Promise<void> | undefined;
    let failure: Error | undefined;
    let stopped = false;
    let incident: IncidentExecution | undefined;
    let stopIncident: (() => void) | undefined;
    try {
      signal.throwIfAborted();
      if (onAdmission) {
        const status = preparedSharedFlow
          ? {
              runId: run.runId,
              admission: "accepted" as const,
              phase: run.phase,
              stopRequested: false,
              run: structuredClone(run),
            }
          : await this.coordinator.status(run.runId, signal);
        if (!preparedSharedFlow) signal.throwIfAborted();
        if (!status || status.admission !== "accepted" || status.runId !== run.runId) {
          throw new MiningCoordinationError("uncertain", "Mining admission cannot be confirmed.");
        }
        onAdmission({ kind: "started", status });
        signal.throwIfAborted();
      }
      if (sharedFlow) {
        if (!preparedSharedFlow || !profilePin) {
          throw new MiningCoordinationError(
            "configuration",
            "Shared-flow run does not have a durable prepared-pin contract.",
          );
        }
        await owner.heartbeat();
        signal.throwIfAborted();
        const pinDeadlineWall = Date.parse(run.pinDeadlineAt);
        const pinDeadlineTick = owner.scheduledStartMonotonic - (startedAt - pinDeadlineWall);
        const pinSignalController = new AbortController();
        const pinSignal = AbortSignal.any([signal, pinSignalController.signal]);
        const pinWork = Promise.resolve().then(async () => {
          const pinReceivedAt = await profilePin(
            createMiningConnectionRunProfilePin(run),
            pinSignal,
          );
          pinSignal.throwIfAborted();
          transport = this.publisher(true);
          connectionTransport = this.connectionPublisher!();
          if (!transport.prepare || !connectionTransport.prepare) {
            throw new MiningCoordinationError(
              "configuration",
              "Shared-flow transports must support preparation.",
            );
          }
          const preparations = [
            Promise.resolve().then(() => transport!.prepare!(pinSignal)),
            Promise.resolve().then(() => connectionTransport!.prepare!(pinSignal)),
          ];
          transportPreparation = Promise.allSettled(preparations).then((results) => {
            const failures = results.flatMap((result) =>
              result.status === "rejected" ? [result.reason] : [],
            );
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1) {
              throw new AggregateError(failures, "Shared-flow transport preparation failed.");
            }
          });
          await transportPreparation;
          pinSignal.throwIfAborted();
          return pinReceivedAt;
        });
        // Keep a late rejected callback handled if timeout/stop wins the race.
        void pinWork.catch(() => undefined);
        try {
          while (true) {
            signal.throwIfAborted();
            const remainingMs = Math.min(
              pinDeadlineWall - this.clock.now(),
              pinDeadlineTick - this.clock.monotonic(),
            );
            if (remainingMs <= 0) {
              const timeout = new MiningCoordinationError(
                "cancelled",
                "Shared-flow profile pin missed its bounded preparation deadline.",
              );
              pinSignalController.abort(timeout);
              throw timeout;
            }
            const waitController = new AbortController();
            const waitSignal = AbortSignal.any([signal, waitController.signal]);
            const wait = this.scheduler
              .wait(Math.min(remainingMs, MINING_OWNER_HEARTBEAT_INTERVAL_MS), waitSignal)
              .then(
                () => "heartbeat" as const,
                (error: unknown) => {
                  if (signal.aborted) return "cancelled" as const;
                  throw error;
                },
              );
            const result = await Promise.race([
              pinWork.then((receipt) => ({ kind: "confirmed" as const, receipt })),
              wait,
            ]);
            waitController.abort();
            if (typeof result === "object" && result.kind === "confirmed") {
              signal.throwIfAborted();
              if (
                this.clock.now() >= pinDeadlineWall ||
                this.clock.monotonic() >= pinDeadlineTick
              ) {
                throw new MiningCoordinationError(
                  "cancelled",
                  "Shared-flow profile pin confirmation arrived after its deadline.",
                );
              }
              const activated = await owner.activatePreparedRun(result.receipt || undefined);
              startedAt = Date.parse(activated.startedAt);
              firstTick = owner.scheduledStartMonotonic;
              break;
            }
            if (result === "cancelled") signal.throwIfAborted();
            await owner.heartbeat();
            signal.throwIfAborted();
          }
        } finally {
          pinSignalController.abort();
        }
        while (!(await owner.beginScheduledRun())) {
          signal.throwIfAborted();
          const remainingMs = Math.min(
            startedAt - this.clock.now(),
            owner.scheduledStartMonotonic - this.clock.monotonic(),
          );
          await this.scheduler.wait(
            Math.max(1, Math.min(remainingMs, MINING_OWNER_HEARTBEAT_INTERVAL_MS)),
            signal,
          );
          await owner.heartbeat();
        }
      }
      if (incidents) {
        if (isContinuousMiningRun(run))
          throw new Error("Continuous incident processing is unavailable.");
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
        const activeTransport = transport ?? this.publisher();
        transport = activeTransport;
        const sharedSimulation = sharedFlow
          ? createD01SharedFlowSimulation(
              {
                runId: run.runId,
                startedAt: new Date(startedAt),
                durationSeconds: run.durationSeconds,
                shutdownAtSeconds: run.shutdownAtSeconds,
                drainDownSeconds: run.drainDownSeconds,
                scenario: "normal",
              },
              this.clock.now,
            )
          : undefined;
        const legacySimulation = sharedFlow
          ? undefined
          : createD01Simulation({
              runId: run.runId,
              seed: run.seed,
              scenario: run.scenario,
              startedAt: new Date(startedAt),
              flushStartup: onStartup !== undefined,
              ...(continuous ? { continuous: true } : { durationSeconds: run.durationSeconds }),
            });
        let lastSharedFlowStep:
          ReturnType<NonNullable<typeof sharedSimulation>["step"]> | undefined;
        for (
          let elapsed = STEP_MS;
          durationMs === null || elapsed <= durationMs;
          elapsed += STEP_MS
        ) {
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
          if (!isContinuousMiningRun(run) && elapsed === durationMs && !run.finalFlushUntil) {
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
          const sampleTime = new Date(wallDeadline).toISOString();
          let legacyEvents: readonly D01TransportBody[] = [];
          let connectionEvents: readonly D01ConnectionMeasurementEvent[] = [];
          let legacyBatch: ReturnType<NonNullable<typeof legacySimulation>["getPendingBatch"]> =
            null;
          let hopperTonnes = 0;
          if (sharedSimulation) {
            const step = sharedSimulation.step(new Date(wallDeadline));
            lastSharedFlowStep = step;
            connectionEvents = step.batch.events;
            legacyEvents = [
              ...(elapsed === STEP_MS
                ? sharedSimulation.initial_legacy_state_events.map((event) =>
                    toD01TransportBody(event),
                  )
                : []),
              ...step.legacy_transport_events,
            ];
            hopperTonnes = step.inventory.hopper_tonnes;
          } else {
            const simulation = legacySimulation!;
            simulation.step(new Date(wallDeadline));
            legacyBatch = simulation.getPendingBatch();
            legacyEvents = legacyBatch?.events ?? [];
            hopperTonnes = simulation.inventory.hopper_tonnes;
          }
          const previewDelivery =
            !continuous && !signal.aborted
              ? onPreview?.(
                  {
                    runId: run.runId,
                    sampleTime,
                    hopperTonnes,
                  },
                  elapsed / 1_000,
                  signal,
                )
              : undefined;
          if (legacyEvents.length > 0 || connectionEvents.length > 0) {
            if (connectionEvents.length > D01_CONNECTION_MAX_BATCH_EVENTS) {
              throw new Error("D01 connection sample exceeds the 200-event send bound.");
            }
            const emittedAt = new Date().toISOString();
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
                if (connectionEvents.length > 0 && !connectionTransport) {
                  throw new MiningCoordinationError(
                    "configuration",
                    "The shared-flow connection transport is unavailable.",
                  );
                }
                const sends: Promise<void>[] = [];
                if (legacyEvents.length > 0) {
                  sends.push(
                    Promise.resolve().then(() => activeTransport.publish(legacyEvents, sendSignal)),
                  );
                }
                if (connectionEvents.length > 0) {
                  sends.push(
                    Promise.resolve().then(() =>
                      connectionTransport!.publish(connectionEvents, sendSignal),
                    ),
                  );
                }
                const publishAll = async () => {
                  const results = await Promise.allSettled(sends);
                  const failures = results.flatMap((result) =>
                    result.status === "rejected" ? [result.reason] : [],
                  );
                  if (failures.length === 1) throw failures[0];
                  if (failures.length > 1) {
                    throw new AggregateError(failures, "Mining profile transports did not settle.");
                  }
                };
                if (continuous) {
                  await publishAll();
                } else {
                  await traceTwinSend(
                    {
                      scenario: "mining",
                      runId: run.runId,
                      sampleTime,
                      emittedAt,
                      eventCount: legacyEvents.length + connectionEvents.length,
                      legacyEventCount: legacyEvents.length,
                      connectionEventCount: connectionEvents.length,
                      eventId: connectionEvents[0]?.event_id ?? legacyEvents[0]?.event_id,
                    },
                    publishAll,
                  );
                }
                sendSignal.throwIfAborted();
                if (
                  this.clock.monotonic() - sendTick >= SEND_TIMEOUT_MS ||
                  this.clock.now() < sendWall ||
                  this.clock.now() - sendWall >= SEND_TIMEOUT_MS
                ) {
                  throw new Error("Mining transport settled after its bounded deadline.");
                }
                if (legacyBatch) legacySimulation!.acknowledgeBatch(legacyBatch.batch_id);
              } finally {
                clearTimeout(timer);
              }
            };
            if (!continuous && elapsed === durationMs && run.finalFlushUntil) {
              await owner.runFinalBatch({ runId: run.runId, timestamp: sampleTime }, send);
            } else {
              await owner.runBatch(send);
            }
            if (elapsed === STEP_MS && !continuous && !signal.aborted) {
              onStartup?.({
                runId: run.runId,
                sampleTime,
                hopperTonnes,
              });
            }
            if (!continuous && !signal.aborted && legacyEvents.length > 0) {
              onBatch?.(run.runId, sampleTime, legacyEvents, signal);
            }
          }
          if (elapsed === durationMs) await previewDelivery;
        }
        if (!stopped) signal.throwIfAborted();
        if (!stopped && !continuous) {
          if (sharedSimulation) {
            if (
              sharedSimulation.elapsedSecondsSoFar !== run.durationSeconds ||
              !lastSharedFlowStep?.completed ||
              lastSharedFlowStep.inventory.in_transit_solids_tonnes >
                D01_CONNECTION_BALANCE_TOLERANCE ||
              lastSharedFlowStep.inventory.in_transit_water_m3 > D01_CONNECTION_BALANCE_TOLERANCE
            ) {
              throw new Error("Shared-flow run ended before its scheduled drain-down completed.");
            }
          } else if (
            !legacySimulation ||
            legacySimulation.elapsedSecondsSoFar !== run.durationSeconds ||
            legacySimulation.getPendingBatch()
          ) {
            throw new Error("Mining final batch was not delivered; publisher is incomplete.");
          }
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
    if (transportPreparation) {
      try {
        await transportPreparation;
      } catch (error) {
        if (error !== failure && (!signal.aborted || error !== signal.reason)) {
          failure = failure
            ? new AggregateError([failure, error], "Mining preparation and execution failed.")
            : publisherError(error);
        }
      }
    }
    // Close only after the actual send promise settles; never release authority around live I/O.
    const closeResults = await Promise.allSettled(
      [transport, connectionTransport]
        .filter((publisher): publisher is D01Publisher | D01ConnectionPublisher => !!publisher)
        .map((publisher) => Promise.resolve().then(() => publisher.close())),
    );
    const closeFailures = closeResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (closeFailures.length > 0) {
      const cleanupError =
        closeFailures.length === 1
          ? closeFailures[0]
          : new AggregateError(closeFailures, "Mining profile transports failed to close.");
      failure = failure
        ? new AggregateError([failure, cleanupError], "Mining send and transport cleanup failed.")
        : publisherError(cleanupError);
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
    private readonly run: BoundedMiningRunRecord,
    private readonly config: MiningPublisherIncidents,
    private readonly onFailure: (error: Error) => void,
  ) {}

  async start(): Promise<void> {
    if (!this.run.contract) {
      throw new MiningCoordinationError("invalid", "Incident run contract is missing.");
    }
    const opening = MiningIncidentRuntime.open(
      createD01VersionedIncidentRun({ ...this.run, contract: this.run.contract }),
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
  options: {
    minimumStartIntervalMs?: number;
    connectionRunProfilePin?: MiningConnectionRunProfilePinHandler;
  } = {},
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
  const sharedFlowSetting = env.MINING_CONNECTION_FLOW_ENABLED;
  if (
    sharedFlowSetting !== undefined &&
    sharedFlowSetting !== "true" &&
    sharedFlowSetting !== "false"
  ) {
    throw new Error("MINING_CONNECTION_FLOW_ENABLED must be true or false.");
  }
  const receiptStartSetting = env.MINING_CONNECTION_RECEIPT_START_ENABLED;
  if (receiptStartSetting !== undefined && !["true", "false"].includes(receiptStartSetting)) {
    throw new Error("MINING_CONNECTION_RECEIPT_START_ENABLED must be true or false.");
  }
  if (receiptStartSetting === "true" && sharedFlowSetting !== "true") {
    throw new Error("Receipt-based starts require shared connection flows.");
  }
  let connectionPublisher: (() => D01ConnectionPublisher) | undefined;
  if (sharedFlowSetting === "true") {
    const connectionStringFlow =
      env.MINING_CONNECTION_EVENTSTREAM_EVENTHUB_CONNECTION_STRING?.trim();
    if (connectionStringFlow) {
      const legacyTarget = getD01EventstreamTarget(connectionString);
      const connectionTarget = assertD01ConnectionEventstreamConfiguration(connectionStringFlow);
      if (
        legacyTarget.fullyQualifiedNamespace.toLowerCase() ===
          connectionTarget.fullyQualifiedNamespace.toLowerCase() &&
        legacyTarget.eventHubName.toLowerCase() === connectionTarget.eventHubName.toLowerCase()
      ) {
        throw new Error(
          "Mining shared-flow observations require a separate Eventstream source from legacy telemetry.",
        );
      }
      connectionPublisher = () => new D01ConnectionEventstreamPublisher(connectionStringFlow);
    }
  }
  return new MiningPublisherRuntime(
    new MiningRunCoordinator(store, systemClock, {
      finalFlushMilliseconds: flushBudget === undefined ? 0 : Number(flushBudget),
      minimumStartIntervalMs: options.minimumStartIntervalMs,
      receiptStartEnabled: receiptStartSetting === "true",
    }),
    (sharedFlow) =>
      new D01EventstreamPublisher(connectionString, undefined, sharedFlow ? 10_000 : 2_000),
    systemClock,
    systemScheduler,
    connectionPublisher,
    options.connectionRunProfilePin,
  );
}
