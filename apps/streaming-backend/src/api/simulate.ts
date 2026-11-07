import express, { Router } from "express";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  createDefaultEventstreamPublisher,
  createLiveSessionGenerator,
  createRaceDayGenerator,
  seedHistory,
  type EventstreamPublisher,
  type RaceDistance,
  type SeedHistoryFreshResult,
  type SeedHistoryResult,
  type TrainingDiscipline,
} from "@triathlon-twin/simulator";
import { requireAthleteAuthorization, type ForbiddenErrorBody } from "../auth/authorization.js";
import {
  globalConcurrencyLock,
  type GlobalConcurrencyLock,
  type LiveSimulationKind,
} from "../services/concurrency-lock.js";
import {
  createDefaultSeededHistoryPreconditionChecker,
  type SeededHistoryPreconditionChecker,
} from "../services/preconditions.js";
import { realtimeStreamBroker, type RealtimeStreamBroker } from "../services/realtime-stream.js";
import { raceStateStore } from "../services/race-state.js";

interface AthleteRequestBody {
  athleteId?: string;
}

interface TriggerSessionRequestBody extends AthleteRequestBody {
  discipline?: TrainingDiscipline;
}

interface TriggerRaceRequestBody extends AthleteRequestBody {
  raceId?: string;
}

export interface SeedHistoryAcceptedResponse {
  runId: string;
  status: "started";
}

export interface SeedHistoryConflictResponse {
  runId: string;
  status: "already-seeded";
  existingStatus: "completed";
}

type SeedHistoryRouteResponse =
  | SeedHistoryAcceptedResponse
  | SeedHistoryConflictResponse
  | ForbiddenErrorBody
  | {
      error: {
        code: "seed_history_failed";
        message: string;
      };
    };

export interface TriggerAcceptedResponse {
  runId: string;
  status: "started";
}

export interface LiveSimulationConflictErrorBody {
  error: {
    code: "live_simulation_in_progress";
    message: "A live session or race simulation is already in progress.";
    runId: string;
    athleteId: string;
    kind: LiveSimulationKind;
  };
}

export interface MissingSeedHistoryErrorBody {
  error: {
    code: "seed_history_required";
    message: "Seed history must exist for this athlete before starting a live simulation.";
  };
}

export interface InvalidDisciplineErrorBody {
  error: {
    code: "invalid_discipline";
    message: string;
  };
}

type TriggerRouteErrorBody =
  | ForbiddenErrorBody
  | LiveSimulationConflictErrorBody
  | MissingSeedHistoryErrorBody
  | InvalidDisciplineErrorBody
  | {
      error: {
        code: "trigger_session_failed" | "trigger_race_failed";
        message: string;
      };
    };

type TriggerRouteResponse = TriggerAcceptedResponse | TriggerRouteErrorBody;

interface StartLiveSessionOptions {
  runId: string;
  athleteId: string;
  discipline: TrainingDiscipline;
  concurrencyLock: GlobalConcurrencyLock;
  eventstreamPublisherFactory: () => EventstreamPublisher;
  streamBroker: RealtimeStreamBroker;
}

interface StartRaceSimulationOptions {
  runId: string;
  athleteId: string;
  raceId: string;
  assumedDistance: RaceDistance;
  concurrencyLock: GlobalConcurrencyLock;
  eventstreamPublisherFactory: () => EventstreamPublisher;
  streamBroker: RealtimeStreamBroker;
}

export interface CreateSimulateRouterOptions {
  environment?: string;
  seedHistoryImpl?: (options: {
    athleteId: string;
    environment: string;
  }) => Promise<SeedHistoryResult>;
  triggerSessionImpl?: (options: StartLiveSessionOptions) => Promise<void>;
  triggerRaceImpl?: (options: StartRaceSimulationOptions) => Promise<void>;
  seededHistoryPreconditionChecker?: SeededHistoryPreconditionChecker;
  concurrencyLock?: GlobalConcurrencyLock;
  eventstreamPublisherFactory?: () => EventstreamPublisher;
  streamBroker?: RealtimeStreamBroker;
  runIdFactory?: () => string;
}

const LIVE_SESSION_SAMPLE_COUNT = 36;
const LIVE_SESSION_EMIT_INTERVAL_MS = 2_000;
const LIVE_RACE_SPLIT_COUNT = 48;
const LIVE_RACE_EMIT_INTERVAL_MS = 1_000;

function resolveSeedEnvironment(options?: CreateSimulateRouterOptions): string {
  return options?.environment ?? process.env.SIMULATOR_ENVIRONMENT ?? "dev";
}

function getRequestedAthleteId(req: Request): string | undefined {
  const body = req.body as AthleteRequestBody | undefined;
  return typeof body?.athleteId === "string" ? body.athleteId : undefined;
}

const VALID_DISCIPLINES: ReadonlySet<string> = new Set<TrainingDiscipline>([
  "swim",
  "bike",
  "run",
  "strength",
]);

function isValidDiscipline(value: unknown): value is TrainingDiscipline {
  return typeof value === "string" && VALID_DISCIPLINES.has(value);
}

/** Raw, unvalidated discipline value from the request body -- used to distinguish "missing" (403,
 * existing behavior) from "present but not a supported discipline" (400, see isValidDiscipline). */
function getRawDiscipline(req: Request): unknown {
  const body = req.body as TriggerSessionRequestBody | undefined;
  return body?.discipline;
}

function getRequestedRaceId(req: Request): string | undefined {
  const body = req.body as TriggerRaceRequestBody | undefined;
  return typeof body?.raceId === "string" ? body.raceId : undefined;
}

function buildAcceptedResponse(result: SeedHistoryFreshResult): SeedHistoryAcceptedResponse {
  return {
    runId: result.runId,
    status: "started",
  };
}

function buildConflictResponse(
  result: Extract<SeedHistoryResult, { outcome: "already-seeded" }>,
): SeedHistoryConflictResponse {
  return {
    runId: result.runId,
    status: "already-seeded",
    existingStatus: result.existingStatus,
  };
}

function buildLiveSimulationConflictBody(lock: {
  runId: string;
  athleteId: string;
  kind: LiveSimulationKind;
}): LiveSimulationConflictErrorBody {
  return {
    error: {
      code: "live_simulation_in_progress",
      message: "A live session or race simulation is already in progress.",
      runId: lock.runId,
      athleteId: lock.athleteId,
      kind: lock.kind,
    },
  };
}

function buildSeedHistoryRequiredBody(): MissingSeedHistoryErrorBody {
  return {
    error: {
      code: "seed_history_required",
      message: "Seed history must exist for this athlete before starting a live simulation.",
    },
  };
}

async function startLiveSessionSimulation(options: StartLiveSessionOptions): Promise<void> {
  // Demo-speed assumption: compress a ~45-75 minute session into ~72 seconds of wall-clock time
  // by emitting 36 samples every 2 seconds while timestamps still span the session's full planned
  // duration. This keeps the cockpit visibly "live" without waiting through a real workout.
  void (async () => {
    let publisher: EventstreamPublisher | undefined;
    let sessionId: string | undefined;

    try {
      publisher = options.eventstreamPublisherFactory();

      for (const tick of createLiveSessionGenerator({
        athleteId: options.athleteId,
        discipline: options.discipline,
        sessionId: options.runId,
        sampleCount: LIVE_SESSION_SAMPLE_COUNT,
      })) {
        sessionId = tick.session.sessionId;
        await publisher.publishSessionMetrics([tick.metric]);
        options.streamBroker.publishMetric(options.athleteId, tick.session.sessionId, tick.metric);

        if (!tick.isFinal) {
          await delay(LIVE_SESSION_EMIT_INTERVAL_MS);
        }
      }

      if (sessionId) {
        options.streamBroker.publishSessionStatus(options.athleteId, sessionId, "completed");
      }
    } catch (error) {
      // Logged server-side (not just surfaced via the broker's "missed" status) because this loop
      // runs detached from the original HTTP response -- console.error is the only remaining signal
      // for diagnosing a mid-run failure (publish error, generator bug, etc.).
      console.error("[streaming-backend] live session simulation failed", {
        runId: options.runId,
        athleteId: options.athleteId,
        error,
      });
      if (sessionId) {
        options.streamBroker.publishSessionStatus(options.athleteId, sessionId, "missed");
      }
    } finally {
      // publisher.close() is isolated in its own try/catch so a close failure can never prevent the
      // concurrency lock release below -- otherwise the demo would be stuck unable to start any new
      // simulation until the process restarts.
      if (publisher) {
        try {
          await publisher.close();
        } catch (closeError) {
          console.error("[streaming-backend] failed to close eventstream publisher", {
            runId: options.runId,
            error: closeError,
          });
        }
      }
      options.concurrencyLock.release(options.runId);
    }
  })().catch((error) => {
    // Safety net: releases the lock even if an error escapes the try/finally above (e.g. a throw
    // from the broker calls inside the catch block itself). release() is idempotent/no-op if the
    // lock was already released for this runId, so calling it twice is safe.
    console.error("[streaming-backend] unhandled error in live session simulation", {
      runId: options.runId,
      error,
    });
    options.concurrencyLock.release(options.runId);
  });
}

async function startRaceSimulation(options: StartRaceSimulationOptions): Promise<void> {
  // The current API contract provides only `raceId`; until a Lakehouse-backed race lookup lands,
  // assume the seeded demo's default next-race path (Olympic distance) for the built-in runner.
  void (async () => {
    let publisher: EventstreamPublisher | undefined;

    try {
      publisher = options.eventstreamPublisherFactory();
      raceStateStore.startRace({
        athleteId: options.athleteId,
        raceId: options.raceId,
      });

      for (const tick of createRaceDayGenerator({
        raceId: options.raceId,
        distance: options.assumedDistance,
        splitCount: LIVE_RACE_SPLIT_COUNT,
        seed: Number.parseInt(options.runId.replaceAll("-", "").slice(0, 8), 16),
      })) {
        await publisher.publishRaceSplits([tick.split]);
        raceStateStore.recordSplit({
          athleteId: options.athleteId,
          raceId: options.raceId,
          split: tick.split,
          projectedFinishTimeSeconds: tick.projectedFinishTimeSeconds,
        });
        options.streamBroker.publishRaceSplit(options.athleteId, options.raceId, tick.split);

        if (!tick.isFinal) {
          await delay(LIVE_RACE_EMIT_INTERVAL_MS);
        }
      }
    } catch (error) {
      // Logged server-side since this loop runs detached from the original HTTP response --
      // console.error is the only remaining signal for diagnosing a mid-run failure.
      console.error("[streaming-backend] race simulation failed", {
        runId: options.runId,
        athleteId: options.athleteId,
        raceId: options.raceId,
        error,
      });
    } finally {
      // publisher.close() is isolated in its own try/catch so a close failure can never prevent the
      // concurrency lock release below -- otherwise the demo would be stuck unable to start any new
      // simulation until the process restarts.
      if (publisher) {
        try {
          await publisher.close();
        } catch (closeError) {
          console.error("[streaming-backend] failed to close eventstream publisher", {
            runId: options.runId,
            error: closeError,
          });
        }
      }
      options.concurrencyLock.release(options.runId);
    }
  })().catch((error) => {
    // Safety net: releases the lock even if an error escapes the try/finally above. release() is
    // idempotent/no-op if the lock was already released for this runId, so calling it twice is safe.
    console.error("[streaming-backend] unhandled error in race simulation", {
      runId: options.runId,
      error,
    });
    options.concurrencyLock.release(options.runId);
  });
}

export function createSimulateRouter(options: CreateSimulateRouterOptions = {}): Router {
  const router = Router();
  const environment = resolveSeedEnvironment(options);
  const runSeedHistory =
    options.seedHistoryImpl ??
    ((request: { athleteId: string; environment: string }) =>
      seedHistory({ athleteId: request.athleteId, environment: request.environment }));
  const seededHistoryPreconditionChecker =
    options.seededHistoryPreconditionChecker ?? createDefaultSeededHistoryPreconditionChecker();
  const concurrencyLock = options.concurrencyLock ?? globalConcurrencyLock;
  const eventstreamPublisherFactory =
    options.eventstreamPublisherFactory ?? createDefaultEventstreamPublisher;
  const streamBroker = options.streamBroker ?? realtimeStreamBroker;
  const triggerSessionImpl = options.triggerSessionImpl ?? startLiveSessionSimulation;
  const triggerRaceImpl = options.triggerRaceImpl ?? startRaceSimulation;
  const runIdFactory = options.runIdFactory ?? randomUUID;

  router.use(express.json());
  router.post(
    "/seed-history",
    requireAthleteAuthorization(getRequestedAthleteId),
    async (req: Request, res: Response<SeedHistoryRouteResponse>): Promise<void> => {
      const athleteId = getRequestedAthleteId(req);
      if (!athleteId) {
        res.status(403).json({
          error: {
            code: "forbidden",
            message: "Not authorized for this athlete.",
          },
        });
        return;
      }

      try {
        const result = await runSeedHistory({
          athleteId,
          environment,
        });

        if (result.outcome === "already-seeded") {
          res.status(409).json(buildConflictResponse(result));
          return;
        }

        res.status(202).json(buildAcceptedResponse(result));
      } catch (error) {
        // Logged server-side because the HTTP response only carries `error.message`, which can be
        // empty/uninformative for some SDK error types (e.g. Azure Storage/Event Hubs errors) --
        // the full error/stack is needed to diagnose issues like credential or connectivity failures.
        console.error("[streaming-backend] seed-history failed", error);
        res.status(500).json({
          error: {
            code: "seed_history_failed",
            message: error instanceof Error ? error.message : "History seeding failed.",
          },
        });
      }
    },
  );

  router.post(
    "/trigger-session",
    requireAthleteAuthorization(getRequestedAthleteId),
    async (req: Request, res: Response<TriggerRouteResponse>): Promise<void> => {
      const athleteId = getRequestedAthleteId(req);
      const rawDiscipline = getRawDiscipline(req);
      if (!athleteId || rawDiscipline === undefined) {
        res.status(403).json({
          error: {
            code: "forbidden",
            message: "Not authorized for this athlete.",
          },
        });
        return;
      }

      if (!isValidDiscipline(rawDiscipline)) {
        res.status(400).json({
          error: {
            code: "invalid_discipline",
            message: `Unsupported discipline "${String(rawDiscipline)}". Expected one of: swim, bike, run, strength.`,
          },
        });
        return;
      }
      const discipline = rawDiscipline;

      try {
        if (!(await seededHistoryPreconditionChecker.hasSeededHistory(athleteId, environment))) {
          res.status(422).json(buildSeedHistoryRequiredBody());
          return;
        }

        const runId = runIdFactory();
        const acquireResult = concurrencyLock.tryAcquire({ runId, athleteId, kind: "session" });
        if (!acquireResult.acquired) {
          res.status(409).json(buildLiveSimulationConflictBody(acquireResult.currentLock));
          return;
        }

        try {
          await triggerSessionImpl({
            runId,
            athleteId,
            discipline,
            concurrencyLock,
            eventstreamPublisherFactory,
            streamBroker,
          });
        } catch (error) {
          concurrencyLock.release(runId);
          throw error;
        }

        res.status(202).json({ runId, status: "started" });
      } catch (error) {
        console.error("[streaming-backend] trigger-session failed", error);
        res.status(500).json({
          error: {
            code: "trigger_session_failed",
            message: error instanceof Error ? error.message : "Trigger session failed.",
          },
        });
      }
    },
  );

  router.post(
    "/trigger-race",
    requireAthleteAuthorization(getRequestedAthleteId),
    async (req: Request, res: Response<TriggerRouteResponse>): Promise<void> => {
      const athleteId = getRequestedAthleteId(req);
      const raceId = getRequestedRaceId(req);
      if (!athleteId || !raceId) {
        res.status(403).json({
          error: {
            code: "forbidden",
            message: "Not authorized for this athlete.",
          },
        });
        return;
      }

      try {
        if (!(await seededHistoryPreconditionChecker.hasSeededHistory(athleteId, environment))) {
          res.status(422).json(buildSeedHistoryRequiredBody());
          return;
        }

        const runId = runIdFactory();
        const acquireResult = concurrencyLock.tryAcquire({ runId, athleteId, kind: "race" });
        if (!acquireResult.acquired) {
          res.status(409).json(buildLiveSimulationConflictBody(acquireResult.currentLock));
          return;
        }

        try {
          await triggerRaceImpl({
            runId,
            athleteId,
            raceId,
            assumedDistance: "olympic",
            concurrencyLock,
            eventstreamPublisherFactory,
            streamBroker,
          });
        } catch (error) {
          concurrencyLock.release(runId);
          throw error;
        }

        res.status(202).json({ runId, status: "started" });
      } catch (error) {
        console.error("[streaming-backend] trigger-race failed", error);
        res.status(500).json({
          error: {
            code: "trigger_race_failed",
            message: error instanceof Error ? error.message : "Trigger race failed.",
          },
        });
      }
    },
  );

  return router;
}
