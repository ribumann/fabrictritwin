import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { traceTwinAdmission } from "../services/twin-latency.js";
import { Router, type Request, type Response } from "express";
import type { JWTPayload } from "jose";
import {
  D01_CATALOG_VERSION,
  D01_CONNECTION_PROFILE_VERSION,
  D01_PLANT_CATALOG,
} from "@triathlon-twin/simulator/mining";
import { verifyMcpCallerClaimsWithErrors } from "../auth/mcp-caller.js";
import { configuredMiningStore } from "../mining/blob-store.js";
import { MiningPublisherHost } from "../mining/publisher-host.js";
import {
  createMiningDemoSignal,
  createMiningNativeLive,
  type MiningNativeReceipt,
} from "../mining/native-live.js";
import {
  configuredMiningPublisherRuntime,
  type MiningStartupPreview,
} from "../mining/publisher-runtime.js";
import {
  MiningRunCoordinator,
  createMiningConnectionRunProfilePin,
  isContinuousMiningRun,
} from "../mining/run-coordinator.js";
import { MiningCoordinationError, type MiningStore } from "../mining/store.js";
import {
  assertMiningDemoQueryConfiguration,
  createMiningDemoProvider,
} from "../mining/read/demo-provider.js";
import type {
  MiningCuratedProvider,
  MiningCuratedRequest,
} from "../mining/read/curated-provider.js";
import { validateMiningReadQuery, type MiningReadRoute } from "./mining-read.js";
import type { MiningDemoIncidentProcessor } from "../mining-incidents/demo-runtime.js";
import {
  createMiningAnswer,
  miningAssistantConfigured,
  type MiningAnswer,
} from "../mining/assistant.js";
import { createMiningContinuousProvider } from "../mining/read/continuous-provider.js";
import { createMiningCrossRunTrendProvider } from "../mining/read/cross-run-trend-provider.js";
import {
  prepareMiningCrossRunTrendQuery,
  type MiningCrossRunMetric,
} from "../mining/read/cross-run-trend-query.js";
import {
  createBoundedMiningQuery,
  MiningQueryError,
  MINING_FLOW_CUTOFF_MARGIN_MS,
} from "../mining/read/bounded-query.js";
import { createContinuousIncidentProvider } from "../mining-incidents/continuous-provider.js";
import type { ContinuousIncidentOwner } from "../mining-incidents/continuous-snapshot-service.js";
import { assertD01RunContract } from "../mining-incidents/catalog.js";
import { mapContinuousAdvisories } from "../mining/read/continuous-advisory-dto.js";
import { createMiningConnectionFlowProvider } from "../mining/read/connection-flow-provider.js";
import { configuredConnectionRunPinHandler } from "../mining/connection-run-pin.js";
import {
  readConnectionEvidenceSnapshot,
  type MiningConnectionEvidenceWorker,
} from "../mining/read/connection-evidence-worker.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const marker = (id: string) => `public-demo/${id}.json`;
const durationSeconds = 600;
const minimumStartIntervalMs = 600_000;

interface Options {
  synthetic: boolean;
  env?: NodeJS.ProcessEnv;
  host?: MiningPublisherHost;
  store?: MiningStore;
  verifyClaims?: (req: Request, signal: AbortSignal) => Promise<JWTPayload | undefined>;
  curated?: MiningCuratedProvider;
  incidents?: Pick<MiningDemoIncidentProcessor, "start">;
  answer?: MiningAnswer;
  continuous?: ReturnType<typeof createMiningContinuousProvider>;
  continuousAdvisories?: ReturnType<typeof createContinuousIncidentProvider>;
  crossRunTrends?: ReturnType<typeof createMiningCrossRunTrendProvider>;
  connectionFlow?: ReturnType<typeof createMiningConnectionFlowProvider>;
  connectionEvidence?: Pick<MiningConnectionEvidenceWorker, "start">;
}

function error(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

export function createMiningDemoHost(env: NodeJS.ProcessEnv = process.env): MiningPublisherHost {
  const snapshot = { ...env };
  return new MiningPublisherHost(() =>
    configuredMiningPublisherRuntime(snapshot, {
      minimumStartIntervalMs,
      connectionRunProfilePin: configuredConnectionRunPinHandler(snapshot),
    }),
  );
}

/** Separate service-only boundary for the public D01 demo; delegated APIs remain unchanged. */
export function createMiningDemoRouter(options: Options): Router {
  const router = Router();
  const env = { ...(options.env ?? process.env) };
  const verify =
    options.verifyClaims ??
    ((req: Request, signal: AbortSignal) => verifyMcpCallerClaimsWithErrors(req, signal, env));
  const host = options.host ?? createMiningDemoHost(env);
  let startupPreview: MiningStartupPreview | undefined;
  let simulatorPreview: MiningStartupPreview[] = [];
  let fabricSignal: Awaited<ReturnType<NonNullable<ReturnType<typeof createMiningDemoSignal>>>>[] =
    [];
  const sendDemoSignal = createMiningDemoSignal(env);
  const nativeLive = createMiningNativeLive(env);
  let nativeReceipt: MiningNativeReceipt | undefined;
  const curated = options.curated ?? createMiningDemoProvider(env);
  const answer = options.answer ?? createMiningAnswer(env);
  const continuous = options.continuous ?? createMiningContinuousProvider(env);
  const crossRunTrends = options.crossRunTrends ?? createMiningCrossRunTrendProvider(env);
  const continuousMode =
    env.MINING_CONTINUOUS_ENABLED === "true" || env.MINING_CONTINUOUS_READ_ENABLED === "true";
  const visibleRun = async (
    store: MiningStore,
    status: Awaited<ReturnType<MiningRunCoordinator["currentStatus"]>>,
    signal: AbortSignal,
  ) => {
    if (!status) return undefined;
    if (continuousMode) {
      return status.run &&
        isContinuousMiningRun(status.run) &&
        status.run.lifetime.generation === env.MINING_CONTINUOUS_GENERATION
        ? status
        : undefined;
    }
    return status.run && isContinuousMiningRun(status.run)
      ? undefined
      : (await isDemoRun(store, status.runId, signal))
        ? status
        : undefined;
  };
  let answering = false;
  let questionTimes: number[] = [];

  router.use(async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (options.synthetic || env.MINING_PUBLIC_DEMO_ENABLED !== "true") {
      error(res, 503, "mining_demo_disabled", "The public mining demo is not enabled.");
      return;
    }
    const principal = env.MINING_PUBLIC_DEMO_CALLER_PRINCIPAL_ID;
    if (
      !guid.test(principal ?? "") ||
      !guid.test(env.ASSISTANT_AUTH_TENANT_ID ?? "") ||
      !guid.test(env.ASSISTANT_AUTH_CLIENT_ID ?? "")
    ) {
      error(res, 503, "mining_demo_configuration", "The mining demo is not configured.");
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      if (!res.headersSent && !res.destroyed) {
        error(res, 503, "mining_demo_timeout", "The mining demo request timed out.");
      }
    }, 9_900);
    res.once("finish", () => clearTimeout(timer));
    res.once("close", () => {
      clearTimeout(timer);
      controller.abort();
    });
    try {
      const claims = await verify(req, controller.signal);
      if (res.headersSent || res.destroyed) return;
      if (
        !claims ||
        claims.oid !== principal ||
        claims.tid !== env.ASSISTANT_AUTH_TENANT_ID ||
        claims.scp !== undefined ||
        typeof claims.exp !== "number" ||
        claims.exp * 1_000 <= Date.now()
      ) {
        error(res, claims ? 403 : 401, "mining_demo_forbidden", "The caller is not authorized.");
        return;
      }
      res.locals.miningDemoSignal = controller.signal;
      next();
    } catch (cause) {
      console.error("[mining-demo] Authentication unavailable", cause);
      if (!res.headersSent && !res.destroyed) {
        error(res, 503, "mining_demo_auth_unavailable", "Authentication is unavailable.");
      }
    }
  });

  const dependencies = () => {
    const store = options.store ?? configuredMiningStore(env);
    if (!store) throw new MiningCoordinationError("configuration", "Mining state is unavailable.");
    return { store, coordinator: new MiningRunCoordinator(store) };
  };
  const isDemoRun = async (store: MiningStore, id: string, signal: AbortSignal) => {
    const entry = await store.read(marker(id), signal);
    const value = entry?.value;
    return (
      typeof value === "object" &&
      value !== null &&
      "version" in value &&
      value.version === 1 &&
      "runId" in value &&
      value.runId === id
    );
  };
  const fail = (res: Response, cause: unknown, unavailableCode = "mining_demo_unavailable") => {
    console.error("[mining-demo] Request failed", cause);
    if (res.headersSent || res.destroyed) return;
    if (cause instanceof MiningCoordinationError && cause.code === "conflict") {
      error(res, 409, "mining_demo_busy", "A run is active or the demo cooldown has not elapsed.");
    } else {
      error(res, 503, unavailableCode, "The mining demo is unavailable; check status.");
    }
  };
  const continuousIncidentProvider =
    options.continuousAdvisories ??
    (continuousMode && env.MINING_CONTINUOUS_READ_ENABLED === "true"
      ? (() => {
          const query = createBoundedMiningQuery({
            ...env,
            EVENTHOUSE_QUERY_URI: env.MINING_EVENTHOUSE_QUERY_URI,
            EVENTHOUSE_DATABASE_NAME: env.MINING_EVENTHOUSE_DATABASE_NAME,
          });
          return createContinuousIncidentProvider(
            {
              now: Date.now,
              readiness: (runId, signal) =>
                query({ kind: "source-readiness", runId, maxRows: 1 }, signal),
              query: (input, signal) =>
                query({ ...input, kind: "continuous-incident-partition" }, signal),
            },
            async (owner, signal) => Boolean(await currentContinuousStatus(signal, owner)),
          );
        })()
      : undefined);

  const currentContinuousStatus = async (
    signal: AbortSignal,
    expected?: ContinuousIncidentOwner,
  ) => {
    const { coordinator } = dependencies();
    const status = await coordinator.currentStatus(signal);
    if (
      status?.admission !== "accepted" ||
      status.phase !== "running" ||
      status.stopRequested ||
      !status.run ||
      !isContinuousMiningRun(status.run) ||
      status.run.runId !== status.runId ||
      status.run.phase !== "running" ||
      status.run.lifetime.generation !== env.MINING_CONTINUOUS_GENERATION
    ) {
      return undefined;
    }
    const run = status.run;
    const now = Date.now();
    const started = Date.parse(run.startedAt);
    const authorityUntil = Date.parse(run.authorityUntil);
    try {
      assertD01RunContract(run.contract);
    } catch {
      return undefined;
    }
    if (
      !Number.isFinite(now) ||
      !Number.isFinite(started) ||
      new Date(started).toISOString() !== run.startedAt ||
      started > now ||
      !Number.isFinite(authorityUntil) ||
      authorityUntil <= now ||
      (expected &&
        (expected.runId !== run.runId ||
          expected.startedAt !== run.startedAt ||
          expected.lifetime.generation !== run.lifetime.generation ||
          expected.contract.catalogVersion !== run.contract.catalogVersion ||
          expected.contract.profileVersion !== run.contract.profileVersion ||
          expected.contract.evaluatorReplayVersion !== run.contract.evaluatorReplayVersion))
    ) {
      return undefined;
    }
    if (await coordinator.continuousGenerationHeld(run.lifetime.generation, signal)) {
      return undefined;
    }
    signal.throwIfAborted();
    return status;
  };

  const currentConnectionOwner = async (signal: AbortSignal) => {
    if (
      continuousMode ||
      env.MINING_PUBLIC_DEMO_READ_ENABLED !== "true" ||
      env.MINING_CONNECTION_FLOW_READ_ENABLED !== "true"
    )
      return undefined;
    const { store, coordinator } = dependencies();
    const status = await visibleRun(store, await coordinator.currentStatus(signal), signal);
    const run = status?.run;
    if (
      status?.admission !== "accepted" ||
      status.stopRequested ||
      !["running", "publisher_complete"].includes(status.phase) ||
      !run ||
      isContinuousMiningRun(run) ||
      run.profileVersion !== D01_CONNECTION_PROFILE_VERSION
    )
      return undefined;
    const pin = createMiningConnectionRunProfilePin(run);
    return { run, pin, phase: status.phase };
  };

  for (const route of ["connection-latest", "connection-trend"] as const) {
    router.get(`/${route}`, async (req, res) => {
      if (
        env.MINING_PUBLIC_DEMO_READ_ENABLED !== "true" ||
        env.MINING_CONNECTION_FLOW_READ_ENABLED !== "true"
      ) {
        error(res, 503, "mining_flow_unavailable", "Connection flows are not enabled.");
        return;
      }
      const keys =
        route === "connection-latest"
          ? ["plantId", "runId"]
          : ["plantId", "runId", "streamIds", "start", "end", "windowSeconds"];
      const value = req.query;
      const streams = typeof value.streamIds === "string" ? value.streamIds.split(",") : [];
      const canonical = (item: unknown) =>
        typeof item === "string" &&
        Number.isFinite(Date.parse(item)) &&
        new Date(Date.parse(item)).toISOString() === item;
      const start = typeof value.start === "string" ? Date.parse(value.start) : NaN;
      const end = typeof value.end === "string" ? Date.parse(value.end) : NaN;
      const knownStreams = new Set(D01_PLANT_CATALOG.streams.map((stream) => stream.id));
      if (
        Object.keys(value).length !== keys.length ||
        keys.some((key) => typeof value[key] !== "string") ||
        value.plantId !== "D01" ||
        typeof value.runId !== "string" ||
        !uuid.test(value.runId) ||
        (route === "connection-trend" &&
          (streams.length < 1 ||
            streams.length > 3 ||
            new Set(streams).size !== streams.length ||
            streams.some((stream) => !knownStreams.has(stream)) ||
            !canonical(value.start) ||
            !canonical(value.end) ||
            end <= start ||
            end - start > 900_000 ||
            end > Date.now() ||
            !["30", "60"].includes(String(value.windowSeconds))))
      ) {
        error(res, 400, "invalid_mining_query", "Invalid connection flow request.");
        return;
      }
      try {
        assertMiningDemoQueryConfiguration(env);
        const signal: AbortSignal = res.locals.miningDemoSignal;
        const owner = await currentConnectionOwner(signal);
        if (!owner || owner.run.runId !== value.runId) {
          error(
            res,
            403,
            "mining_run_forbidden",
            "Only the current flow-enabled demo is available.",
          );
          return;
        }
        if (route === "connection-trend" && start < Date.parse(owner.run.startedAt)) {
          error(res, 400, "invalid_mining_query", "Trend starts before the current run.");
          return;
        }
        const provider =
          options.connectionFlow ??
          createMiningConnectionFlowProvider(
            createBoundedMiningQuery({
              ...env,
              EVENTHOUSE_QUERY_URI: env.MINING_EVENTHOUSE_QUERY_URI,
              EVENTHOUSE_DATABASE_NAME: env.MINING_EVENTHOUSE_DATABASE_NAME,
            }),
          );
        const scope = { runId: owner.run.runId, runStartedAt: owner.run.startedAt };
        const latestCutoff = Date.now() - MINING_FLOW_CUTOFF_MARGIN_MS;
        if (route === "connection-latest" && latestCutoff < Date.parse(owner.run.startedAt)) {
          error(res, 503, "mining_flow_pending", "Waiting for the first connection flow samples.");
          return;
        }
        const data =
          route === "connection-latest"
            ? await provider.latest(
                { ...scope, asOf: new Date(latestCutoff).toISOString(), streamIds: [] },
                signal,
              )
            : await provider.trend(
                {
                  ...scope,
                  start: value.start as string,
                  end: value.end as string,
                  streamIds: streams,
                  windowSeconds: value.windowSeconds === "30" ? 30 : 60,
                },
                signal,
              );
        const latest = await currentConnectionOwner(signal);
        if (
          !latest ||
          latest.run.runId !== owner.run.runId ||
          latest.run.startedAt !== owner.run.startedAt ||
          JSON.stringify(latest.pin) !== JSON.stringify(owner.pin)
        )
          throw new MiningCoordinationError(
            "prerequisite",
            "Flow authority changed during the read.",
          );
        if (!res.headersSent && !res.destroyed) res.json(data);
      } catch (cause) {
        fail(res, cause, "mining_flow_unavailable");
      }
    });
  }

  router.get("/runs/status", async (req, res) => {
    if (Object.keys(req.query).length) {
      error(res, 400, "invalid_mining_demo", "Status accepts no query parameters.");
      return;
    }
    try {
      const { store, coordinator } = dependencies();
      const signal: AbortSignal = res.locals.miningDemoSignal;
      const status = await coordinator.currentStatus(signal);
      if (res.headersSent || res.destroyed) return;
      const visible = await visibleRun(store, status, signal);
      if (res.headersSent || res.destroyed) return;
      res.json({
        plantId: "D01",
        mode: continuousMode ? "continuous" : "bounded",
        ...(!continuousMode ? { previewCadenceSeconds: 5 } : {}),
        ...(!continuousMode && sendDemoSignal ? { fabricSignal: true } : {}),
        ...(!continuousMode && nativeLive ? { nativeLive: true } : {}),
        run: visible
          ? {
              runId: visible.runId,
              admission: visible.admission,
              publisherStatus: visible.phase,
              stopRequested: visible.stopRequested,
              ingestionStatus: "unknown",
              startedAt: visible.run?.startedAt,
              ...(!continuousMode && visible.run && !isContinuousMiningRun(visible.run)
                ? { stopAt: visible.run.stopAt }
                : {}),
              ...(!continuousMode &&
              visible.phase === "running" &&
              !visible.stopRequested &&
              startupPreview?.runId === visible.runId
                ? { startupPreview }
                : {}),
              ...(!continuousMode &&
              visible.phase === "running" &&
              !visible.stopRequested &&
              simulatorPreview[0]?.runId === visible.runId
                ? { simulatorPreview }
                : {}),
              ...(!continuousMode &&
              visible.phase === "running" &&
              !visible.stopRequested &&
              fabricSignal[0]?.runId === visible.runId
                ? { fabricSignal }
                : {}),
              ...(!continuousMode &&
              visible.phase === "running" &&
              !visible.stopRequested &&
              nativeReceipt?.runId === visible.runId
                ? { nativeReceipt }
                : {}),
              ...(continuousMode
                ? {
                    generation: env.MINING_CONTINUOUS_GENERATION,
                    authorityUntil: visible.run?.authorityUntil,
                  }
                : {}),
            }
          : null,
      });
    } catch (cause) {
      fail(res, cause);
    }
  });
  router.get("/cross-run-trends", async (req, res) => {
    if (
      !continuousMode ||
      env.MINING_PUBLIC_DEMO_READ_ENABLED !== "true" ||
      env.MINING_CONTINUOUS_READ_ENABLED !== "true"
    ) {
      error(res, 503, "mining_continuous_unavailable", "Continuous trends are unavailable.");
      return;
    }
    const allowed = new Set(["plantId", "start", "end", "metric", "binMinutes"]);
    if (
      Object.entries(req.query).some(
        ([key, value]) => !allowed.has(key) || typeof value !== "string" || value.length > 128,
      ) ||
      req.query.plantId !== "D01" ||
      typeof req.query.start !== "string" ||
      typeof req.query.end !== "string" ||
      typeof req.query.metric !== "string" ||
      ![
        "feed",
        "density",
        "vibration",
        "water-energy",
        "sorter-feed",
        "motor-current",
        "bearing-temperature",
        "feed-pressure",
      ].includes(req.query.metric) ||
      !["1", "5"].includes(String(req.query.binMinutes))
    ) {
      error(res, 400, "invalid_mining_query", "Invalid cross-run trend scope.");
      return;
    }
    const input = {
      start: req.query.start,
      end: req.query.end,
      asOf: new Date().toISOString(),
      metric: req.query.metric as MiningCrossRunMetric,
      binMinutes: req.query.binMinutes === "1" ? (1 as const) : (5 as const),
    };
    try {
      prepareMiningCrossRunTrendQuery(input);
    } catch (cause) {
      if (!(cause instanceof MiningQueryError) || cause.code !== "invalid") throw cause;
      error(res, 400, "invalid_mining_query", "Invalid cross-run trend window.");
      return;
    }
    try {
      assertMiningDemoQueryConfiguration(env);
      const { store, coordinator } = dependencies();
      const signal: AbortSignal = res.locals.miningDemoSignal;
      const initial = await visibleRun(store, await coordinator.currentStatus(signal), signal);
      const current =
        initial?.admission === "accepted" &&
        initial.phase === "running" &&
        !initial.stopRequested &&
        initial.run &&
        isContinuousMiningRun(initial.run) &&
        Date.parse(initial.run.authorityUntil) > Date.now()
          ? initial.run
          : undefined;
      if (!current) {
        error(
          res,
          503,
          "mining_continuous_unavailable",
          "The continuous publisher is unavailable.",
        );
        return;
      }
      const data = await crossRunTrends(input, signal);
      const latest = await coordinator.currentStatus(signal);
      if (
        latest?.admission !== "accepted" ||
        latest.phase !== "running" ||
        latest.stopRequested ||
        latest.runId !== current.runId ||
        !latest.run ||
        !isContinuousMiningRun(latest.run) ||
        latest.run.lifetime.generation !== current.lifetime.generation ||
        !(Date.parse(latest.run.authorityUntil) > Date.now())
      ) {
        throw new MiningCoordinationError(
          "prerequisite",
          "Continuous authority changed during the read.",
        );
      }
      if (res.headersSent || res.destroyed) return;
      res.json({
        ...data,
        owner: {
          runId: current.runId,
          generation: current.lifetime.generation,
          authorityUntil: latest.run.authorityUntil,
        },
      });
    } catch (cause) {
      fail(res, cause, "mining_trend_unavailable");
    }
  });
  for (const route of ["context", "overview", "trends", "incidents", "compare-lines"] as const) {
    router.get(`/${route}`, async (req, res) => {
      if (env.MINING_PUBLIC_DEMO_READ_ENABLED !== "true") {
        error(res, 503, "mining_demo_read_disabled", "Public mining reads are not enabled.");
        return;
      }
      const invalid = validateMiningReadQuery(
        route satisfies MiningReadRoute,
        req.query,
        Date.now(),
        new Set(D01_PLANT_CATALOG.modules.map((module) => module.id)),
      );
      if (invalid) {
        error(res, 400, "invalid_mining_query", invalid);
        return;
      }
      try {
        assertMiningDemoQueryConfiguration(env);
        const { store, coordinator } = dependencies();
        const signal: AbortSignal = res.locals.miningDemoSignal;
        const status = await coordinator.currentStatus(signal);
        const demo = await visibleRun(store, status, signal);
        if (res.headersSent || res.destroyed) return;
        if (continuousMode) {
          const current =
            demo?.admission === "accepted" && demo.run && isContinuousMiningRun(demo.run)
              ? demo.run
              : undefined;
          const publicRun = current
            ? {
                plantId: "D01",
                runId: current.runId,
                catalogVersion: D01_CATALOG_VERSION,
                publisherStatus: demo!.phase,
                ingestionStatus: "unknown",
                generation: current.lifetime.generation,
                authorityUntil: current.authorityUntil,
                stopRequested: demo!.stopRequested,
              }
            : null;
          if (req.query.runId && req.query.runId !== current?.runId) {
            error(
              res,
              403,
              "mining_run_forbidden",
              "Only the current continuous run is available.",
            );
            return;
          }
          const source = {
            workspace: "triatwin-dev-fabric",
            database: env.MINING_EVENTHOUSE_DATABASE_NAME,
          };
          if (route === "context") {
            res.json({
              plantId: "D01",
              mode: "continuous",
              approvedRun: publicRun,
              source,
              catalogVersion: D01_CATALOG_VERSION,
              readAvailable: env.MINING_CONTINUOUS_READ_ENABLED === "true",
              assistant: {
                available:
                  env.MINING_CONTINUOUS_READ_ENABLED === "true" && miningAssistantConfigured(env),
                kind: "bounded-fabric-evidence",
              },
              capabilities: {
                incidents:
                  env.MINING_CONTINUOUS_READ_ENABLED === "true" &&
                  Boolean(continuousIncidentProvider),
                trends: env.MINING_CONTINUOUS_READ_ENABLED === "true",
                replay: false,
                assistant:
                  env.MINING_CONTINUOUS_READ_ENABLED === "true" &&
                  Boolean(continuousIncidentProvider) &&
                  miningAssistantConfigured(env),
              },
              unavailableReason:
                "Managed continuous source; empty rolling advisories do not prove health or complete source coverage.",
            });
            return;
          }
          if (
            (route !== "overview" && route !== "incidents") ||
            (route === "overview" && req.query.asOf) ||
            (route === "incidents" && req.query.asOf)
          ) {
            error(
              res,
              503,
              "mining_continuous_capability_unavailable",
              "Continuous mode supports current overview and rolling event-time advisories only.",
            );
            return;
          }
          const ownerStatus = await currentContinuousStatus(signal);
          const ownerRun =
            ownerStatus?.run && isContinuousMiningRun(ownerStatus.run)
              ? ownerStatus.run
              : undefined;
          if (!ownerRun || !ownerStatus) {
            error(
              res,
              503,
              "mining_continuous_unavailable",
              "The continuous publisher is not running; values are unavailable.",
            );
            return;
          }
          if (!current || ownerRun.runId !== current.runId) {
            error(res, 503, "mining_continuous_unavailable", "The continuous publisher changed.");
            return;
          }
          if (route === "incidents") {
            if (!continuousIncidentProvider) {
              error(
                res,
                503,
                "mining_continuous_advisories_unavailable",
                "Rolling advisory evidence is unavailable.",
              );
              return;
            }
            const snapshot = await continuousIncidentProvider(ownerRun, signal);
            if (!snapshot) {
              error(
                res,
                503,
                "mining_continuous_advisories_unavailable",
                "Rolling advisory evidence is unavailable.",
              );
              return;
            }
            if (!(await currentContinuousStatus(signal, ownerRun))) {
              throw new MiningCoordinationError(
                "prerequisite",
                "Continuous authority changed during the advisory read.",
              );
            }
            if (!res.headersSent && !res.destroyed) {
              res.json({
                ...mapContinuousAdvisories(snapshot),
                generation: ownerRun.lifetime.generation,
              });
            }
            return;
          }
          const asOf = new Date().toISOString();
          const data = await continuous(ownerRun, asOf, signal);
          const latest = await currentContinuousStatus(signal, ownerRun);
          if (!latest?.run || !isContinuousMiningRun(latest.run)) {
            throw new MiningCoordinationError(
              "prerequisite",
              "Continuous authority changed during the read.",
            );
          }
          if (res.headersSent || res.destroyed) return;
          res.json({
            ...data,
            source,
            run: {
              ...publicRun,
              generation: latest.run.lifetime.generation,
              authorityUntil: latest.run.authorityUntil,
            },
          });
          return;
        }
        const run =
          demo?.admission === "accepted" &&
          (demo.run?.contract || demo.run?.connectionProfileContract)
            ? {
                plantId: "D01",
                runId: demo.runId,
                catalogVersion: D01_CATALOG_VERSION,
                publisherStatus:
                  demo.stopRequested && demo.phase === "running" ? "stop_requested" : demo.phase,
                ingestionStatus: "unknown",
              }
            : null;
        if (req.query.runId && req.query.runId !== run?.runId) {
          error(res, 403, "mining_run_forbidden", "Only the current public demo run is available.");
          return;
        }
        if (route === "context") {
          const flowOwner = await currentConnectionOwner(signal);
          res.json({
            plantId: "D01",
            approvedRun: run,
            catalogVersion: D01_CATALOG_VERSION,
            readAvailable: true,
            capabilities: { connectionFlow: flowOwner?.run.runId === run?.runId && !!flowOwner },
            assistant: {
              available: miningAssistantConfigured(env),
              kind: "bounded-fabric-evidence",
            },
            ...(!run
              ? { unavailableReason: "Start a public demo run to view mining telemetry." }
              : {}),
          });
          return;
        }
        if (!run || !demo?.run) {
          error(res, 404, "mining_demo_run_not_found", "No admitted public demo run is available.");
          return;
        }
        let input: MiningCuratedRequest;
        if (route === "incidents" && demo.stopRequested) {
          error(
            res,
            503,
            "mining_incidents_unavailable",
            "Stopped runs do not have a complete incident reconciliation.",
          );
          return;
        }
        if (route === "overview" || route === "incidents") {
          input = {
            kind: route,
            run: demo.run,
            asOf: new Date((req.query.asOf as string | undefined) ?? Date.now()).toISOString(),
          };
        } else {
          const metric = req.query.metric as MiningCrossRunMetric;
          const window = {
            run: demo.run,
            start: new Date(String(req.query.start)).toISOString(),
            end: new Date(String(req.query.end)).toISOString(),
            metric,
            binMinutes: req.query.binMinutes === "1" ? 1 : 5,
            maxRows: Number(req.query.maxRows),
            ...(req.query.asOf ? { asOf: new Date(String(req.query.asOf)).toISOString() } : {}),
          } as const;
          input =
            route === "trends"
              ? { ...window, kind: "trend", moduleId: String(req.query.moduleId) }
              : { ...window, kind: "compare" };
        }
        const data = await curated(input, signal);
        let connectionIngestion:
          | Awaited<ReturnType<typeof readConnectionEvidenceSnapshot>>
          | { status: "unknown" }
          | undefined;
        if (
          route === "overview" &&
          !req.query.asOf &&
          demo.phase === "publisher_complete" &&
          !demo.stopRequested &&
          "profileVersion" in demo.run &&
          demo.run.profileVersion === D01_CONNECTION_PROFILE_VERSION &&
          env.MINING_CONNECTION_FLOW_READ_ENABLED === "true"
        ) {
          try {
            const provider =
              options.connectionFlow ??
              createMiningConnectionFlowProvider(
                createBoundedMiningQuery({
                  ...env,
                  EVENTHOUSE_QUERY_URI: env.MINING_EVENTHOUSE_QUERY_URI,
                  EVENTHOUSE_DATABASE_NAME: env.MINING_EVENTHOUSE_DATABASE_NAME,
                }),
              );
            connectionIngestion = await readConnectionEvidenceSnapshot(
              demo,
              store,
              provider,
              async (currentSignal) =>
                visibleRun(store, await coordinator.currentStatus(currentSignal), currentSignal),
              signal,
            );
          } catch (cause) {
            if (signal.aborted) throw cause;
            console.error("[mining-connection-evidence] Snapshot read unavailable", cause);
            connectionIngestion = { status: "unknown" };
          }
        }
        if (route === "incidents") {
          const latest = await coordinator.currentStatus(signal);
          if (
            latest?.admission !== "accepted" ||
            latest.runId !== run.runId ||
            latest.stopRequested ||
            latest.phase !== "publisher_complete"
          ) {
            throw new MiningCoordinationError(
              "prerequisite",
              "The completed demo run changed during the incident read.",
            );
          }
        }
        if (res.headersSent || res.destroyed) return;
        res.json(
          route === "overview"
            ? {
                ...data,
                ...(connectionIngestion ? { connectionIngestion } : {}),
                run: {
                  ...run,
                  ingestionStatus:
                    data && "ingestion" in data ? (data.ingestion?.status ?? "unknown") : "unknown",
                },
              }
            : data,
        );
      } catch (cause) {
        fail(res, cause, route === "incidents" ? "mining_incidents_unavailable" : undefined);
      }
    });
  }
  router.post("/assistant", async (req, res) => {
    if (env.MINING_PUBLIC_DEMO_READ_ENABLED !== "true" || !miningAssistantConfigured(env)) {
      error(res, 503, "mining_assistant_unavailable", "The mining evidence assistant is disabled.");
      return;
    }
    const body: unknown = req.body;
    if (
      Object.keys(req.query).length ||
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 2 ||
      !("plantId" in body) ||
      body.plantId !== "D01" ||
      !("question" in body) ||
      typeof body.question !== "string" ||
      !body.question.trim() ||
      body.question.length > 1000
    ) {
      error(
        res,
        400,
        "invalid_mining_question",
        "Provide D01 and a question of 1-1000 characters.",
      );
      return;
    }
    const now = Date.now();
    questionTimes = questionTimes.filter((time) => now - time < 60_000);
    if (answering || questionTimes.length >= 6) {
      res.setHeader("Retry-After", "60");
      error(
        res,
        429,
        "mining_assistant_busy",
        "The shared demo assistant is busy; try again later.",
      );
      return;
    }
    questionTimes.push(now);
    answering = true;
    try {
      assertMiningDemoQueryConfiguration(env);
      const requestStarted = performance.now();
      const requestSignal = AbortSignal.any([
        res.locals.miningDemoSignal as AbortSignal,
        AbortSignal.timeout(9_000),
      ]);
      let runId: string;
      let evidence: unknown;
      let groundedOn: string[];
      let continuousOwner: ContinuousIncidentOwner | undefined;
      let flowOwner: Awaited<ReturnType<typeof currentConnectionOwner>>;
      const assertCurrentFlowOwner = async () => {
        if (!flowOwner) return;
        const latest = await currentConnectionOwner(requestSignal);
        if (
          !latest ||
          latest.run.runId !== flowOwner.run.runId ||
          latest.run.startedAt !== flowOwner.run.startedAt ||
          JSON.stringify(latest.pin) !== JSON.stringify(flowOwner.pin)
        )
          throw new Error("The connection flow owner changed while answering; ask again.");
      };
      if (continuousMode) {
        if (env.MINING_CONTINUOUS_READ_ENABLED !== "true" || !continuousIncidentProvider) {
          error(
            res,
            503,
            "mining_assistant_unavailable",
            "Current bounded continuous assistant evidence is unavailable.",
          );
          return;
        }
        const ownerStatus = await currentContinuousStatus(requestSignal);
        const owner =
          ownerStatus?.run && isContinuousMiningRun(ownerStatus.run) ? ownerStatus.run : undefined;
        if (!owner || !ownerStatus) {
          error(
            res,
            503,
            "mining_assistant_unavailable",
            "A current accepted continuous owner is unavailable.",
          );
          return;
        }
        continuousOwner = owner;
        const asOf = new Date().toISOString();
        const [overviewData, snapshot] = await Promise.all([
          continuous(owner, asOf, requestSignal),
          continuousIncidentProvider(owner, requestSignal),
        ]);
        if (!snapshot || !(await currentContinuousStatus(requestSignal, owner))) {
          throw new Error("Continuous ownership changed during evidence collection.");
        }
        const advisories = {
          ...mapContinuousAdvisories(snapshot),
          generation: owner.lifetime.generation,
        };
        const overview = {
          ...overviewData,
          source: {
            workspace: "triatwin-dev-fabric",
            database: env.MINING_EVENTHOUSE_DATABASE_NAME,
          },
          run: {
            plantId: "D01",
            runId: owner.runId,
            catalogVersion: D01_CATALOG_VERSION,
            publisherStatus: "running",
            ingestionStatus: "unknown",
            generation: owner.lifetime.generation,
            authorityUntil: owner.authorityUntil,
            stopRequested: false,
          },
        };
        const capturedAt = Date.now();
        const age = (value: string) => {
          const parsed = Date.parse(value);
          const ageSeconds = (capturedAt - parsed) / 1000;
          if (!Number.isFinite(parsed) || !Number.isFinite(ageSeconds) || ageSeconds < 0) {
            throw new Error("Continuous assistant evidence contains an invalid or future sample.");
          }
          return ageSeconds;
        };
        evidence = {
          mode: "continuous",
          owner: {
            runId: owner.runId,
            generation: owner.lifetime.generation,
            startedAt: owner.startedAt,
          },
          overview,
          advisories: {
            ...advisories,
            sourceAgeSeconds: age(advisories.sourceObservedAt),
            completeness:
              "Only bounded retained records were checked; this is not proof of source completeness.",
            advisories: advisories.advisories.map((item) => ({
              ...item,
              evidence: item.evidence.map((row) => ({
                ...row,
                ageSeconds: age(row.sampleTime),
              })),
              stateEvidence: item.stateEvidence.map((row) => ({
                ...row,
                ageSeconds: age(row.sampleTime),
              })),
            })),
          },
        };
        runId = owner.runId;
        groundedOn = [
          "bounded current-run Fabric readings with sample ages",
          "retrospective rolling event-time advisories with explicit evidence ages",
        ];
      } else {
        const { store, coordinator } = dependencies();
        const status = await coordinator.currentStatus(requestSignal);
        if (
          status?.admission !== "accepted" ||
          (!status.run?.contract && !status.run?.connectionProfileContract) ||
          !(await isDemoRun(store, status.runId, requestSignal))
        ) {
          error(res, 404, "mining_demo_run_not_found", "Start a public demo run before asking.");
          return;
        }
        const sharedFlow = status.run.connectionProfileContract !== undefined;
        const asOf = new Date(now - (sharedFlow ? MINING_FLOW_CUTOFF_MARGIN_MS : 0)).toISOString();
        if (sharedFlow) {
          flowOwner = await currentConnectionOwner(requestSignal);
          if (
            !flowOwner ||
            flowOwner.run.runId !== status.runId ||
            Date.parse(asOf) < Date.parse(flowOwner.run.startedAt)
          ) {
            error(
              res,
              503,
              "mining_assistant_unavailable",
              "Connection flow evidence is not ready.",
            );
            return;
          }
        }
        const overview = await curated({ kind: "overview", run: status.run, asOf }, requestSignal);
        if (!overview || !("latest" in overview)) {
          throw new Error("Mining assistant evidence is unavailable.");
        }
        if (flowOwner) {
          const provider =
            options.connectionFlow ??
            createMiningConnectionFlowProvider(
              createBoundedMiningQuery({
                ...env,
                EVENTHOUSE_QUERY_URI: env.MINING_EVENTHOUSE_QUERY_URI,
                EVENTHOUSE_DATABASE_NAME: env.MINING_EVENTHOUSE_DATABASE_NAME,
              }),
            );
          const connectionFlow = await provider.latest(
            {
              runId: flowOwner.run.runId,
              runStartedAt: flowOwner.run.startedAt,
              asOf,
              streamIds: [],
            },
            requestSignal,
          );
          evidence = { ...overview, connectionFlow, connectionFlowOrigin: "synthetic" };
        } else {
          evidence = overview;
        }
        runId = status.runId;
        groundedOn = flowOwner
          ? [
              "validated latest readings",
              "five-minute summary",
              "synthetic connection-flow readings",
            ]
          : ["validated latest readings", "five-minute summary", "event-ID reconciliation"];
        const latest = await coordinator.currentStatus(requestSignal);
        if (latest?.runId !== status.runId || latest.stopRequested !== status.stopRequested) {
          throw new Error("The public run changed while reading evidence; ask again.");
        }
      }
      const evidenceText = JSON.stringify(evidence);
      if (Buffer.byteLength(evidenceText) > 65_536) {
        throw new Error("Mining assistant evidence exceeds its bound.");
      }
      requestSignal.throwIfAborted();
      await assertCurrentFlowOwner();
      const answerBudget = Math.min(
        8_000,
        Math.floor(9_000 - (performance.now() - requestStarted) - (flowOwner ? 1_500 : 500)),
      );
      if (answerBudget <= 0) {
        throw new Error("The evidence read left no bounded time for an assistant answer.");
      }
      const text = await answer(body.question.trim(), evidenceText, requestSignal, answerBudget);
      await assertCurrentFlowOwner();
      if (continuousMode) {
        const status = await currentContinuousStatus(requestSignal, continuousOwner);
        if (
          !continuousOwner ||
          !status?.run ||
          !isContinuousMiningRun(status.run) ||
          status.run.runId !== runId
        ) {
          throw new Error("The continuous owner changed while answering; ask again.");
        }
      }
      requestSignal.throwIfAborted();
      if (performance.now() - requestStarted > 9_000) {
        throw new Error("The bounded Mining assistant deadline expired.");
      }
      requestSignal.throwIfAborted();
      if (!res.headersSent && !res.destroyed) {
        res.json({
          plantId: "D01",
          runId,
          catalogVersion: D01_CATALOG_VERSION,
          answer: text,
          kind: "bounded-fabric-evidence",
          nativeDataAgentInvoked: false,
          groundedOn,
          evidence,
          refreshedAt: new Date().toISOString(),
        });
      }
    } catch (cause) {
      fail(res, cause, "mining_assistant_unavailable");
    } finally {
      answering = false;
    }
  });
  router.post("/runs/start", async (req, res) => {
    const requestStartedAt = performance.now();
    if (continuousMode) {
      error(
        res,
        403,
        "mining_continuous_managed",
        "Continuous publishing is operator-managed; public starts are disabled.",
      );
      return;
    }
    if (
      Object.keys(req.query).length ||
      !req.body ||
      typeof req.body !== "object" ||
      Array.isArray(req.body) ||
      Object.keys(req.body).length !== 1 ||
      req.body.plantId !== "D01"
    ) {
      error(res, 400, "invalid_mining_demo", "Provide only the D01 plantId.");
      return;
    }
    const sharedFlowDemo = env.MINING_PUBLIC_DEMO_CONNECTION_FLOW_ENABLED === "true";
    if (sharedFlowDemo && env.MINING_CONNECTION_FLOW_ENABLED !== "true") {
      error(res, 503, "mining_flow_unavailable", "The shared-flow publisher is not enabled.");
      return;
    }
    try {
      const { store } = dependencies();
      const signal: AbortSignal = res.locals.miningDemoSignal;
      const runId = randomUUID();
      if (!(await store.create(marker(runId), { version: 1, runId }))) {
        throw new MiningCoordinationError("conflict", "Demo identifier already exists.");
      }
      signal.throwIfAborted();
      const execution = host.start(
        {
          plantId: "D01",
          requestId: runId,
          durationSeconds,
          ...(sharedFlowDemo ? { profileVersion: D01_CONNECTION_PROFILE_VERSION } : {}),
        },
        signal,
        undefined,
        (preview) => {
          startupPreview = preview;
        },
        nativeLive
          ? (id, sample, events, authority) => {
              const started = performance.now();
              void nativeLive(id, sample, events, authority).then(
                (receipt) => {
                  if (!authority.aborted) {
                    nativeReceipt = receipt;
                    console.info(
                      JSON.stringify({
                        telemetry: "mining-native-live-v1",
                        runId: id,
                        sampleTime: sample,
                        elapsedMs: Math.round(performance.now() - started),
                      }),
                    );
                  }
                },
                () => {
                  if (!authority.aborted)
                    console.warn("[mining-native-live] Fabric receipt unavailable", id, sample);
                },
              );
            }
          : undefined,
        (preview, elapsedSeconds, authority) => {
          if (simulatorPreview[0]?.runId !== preview.runId) simulatorPreview = [];
          simulatorPreview.push(preview);
          if (simulatorPreview.length > durationSeconds / 5) simulatorPreview.shift();
          if (sendDemoSignal) {
            return sendDemoSignal(preview, elapsedSeconds, authority).then(
              (receipt) => {
                if (authority.aborted) return;
                if (fabricSignal[0]?.runId !== receipt.runId) fabricSignal = [];
                fabricSignal.push(receipt);
                if (fabricSignal.length > durationSeconds / 5) fabricSignal.shift();
              },
              () => {
                if (!authority.aborted)
                  console.warn(
                    "[mining-demo-signal] Fabric receipt unavailable",
                    preview.runId,
                    preview.sampleTime,
                  );
              },
            );
          }
        },
      );
      const admission = await execution.admission;
      traceTwinAdmission({ scenario: "mining", runId }, requestStartedAt);
      const incidents = options.incidents;
      if (options.connectionEvidence && sharedFlowDemo) {
        void execution.completion
          .then(
            (status) => {
              if (status.phase === "publisher_complete" && !status.stopRequested)
                return options.connectionEvidence!.start(runId);
            },
            (cause: unknown) =>
              console.error("[mining-connection-evidence] Publisher failed", cause),
          )
          .catch((cause: unknown) =>
            console.error(
              "[mining-connection-evidence] Completion-triggered reconciliation failed",
              cause,
            ),
          );
      }
      if (incidents && !sharedFlowDemo) {
        void execution.completion
          .then(
            (status) => {
              if (status.phase === "publisher_complete" && !status.stopRequested) {
                return incidents.start(runId);
              }
            },
            (cause: unknown) => {
              console.error(
                "[mining-demo-incidents] Publisher did not complete; reconciliation was not activated",
                cause,
              );
            },
          )
          .catch((cause: unknown) => {
            console.error(
              "[mining-demo-incidents] Completion-triggered reconciliation failed",
              cause,
            );
          });
      }
      if (res.headersSent || res.destroyed) return;
      if (
        admission.kind !== "started" ||
        admission.status.runId !== runId ||
        admission.status.admission !== "accepted"
      ) {
        throw new MiningCoordinationError("uncertain", "Demo admission is not confirmed.");
      }
      res.status(202).json({
        plantId: "D01",
        runId,
        publisherStatus: admission.status.phase,
        ingestionStatus: "unknown",
      });
    } catch (cause) {
      fail(res, cause);
    }
  });

  router.post("/runs/cancel", async (req, res) => {
    if (continuousMode) {
      error(
        res,
        403,
        "mining_continuous_managed",
        "Continuous publishing is operator-managed; public cancellation is disabled.",
      );
      return;
    }
    const body: unknown = req.body;
    if (
      Object.keys(req.query).length ||
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 2 ||
      !("plantId" in body) ||
      body.plantId !== "D01" ||
      !("runId" in body) ||
      typeof body.runId !== "string" ||
      !uuid.test(body.runId)
    ) {
      error(res, 400, "invalid_mining_demo", "Provide only D01 and the demo run ID.");
      return;
    }
    try {
      const { store, coordinator } = dependencies();
      const signal: AbortSignal = res.locals.miningDemoSignal;
      const current = await coordinator.currentStatus(signal);
      if (
        !current ||
        current.runId !== body.runId ||
        !(await isDemoRun(store, body.runId, signal))
      ) {
        error(res, 404, "mining_demo_run_not_found", "The current demo run was not found.");
        return;
      }
      if (current.run && isContinuousMiningRun(current.run)) {
        error(
          res,
          403,
          "mining_continuous_managed",
          "Continuous runs require the authenticated generation-scoped operator control.",
        );
        return;
      }
      const result = await coordinator.requestStop(body.runId, undefined, undefined, signal);
      if (res.headersSent || res.destroyed) return;
      if (!result.status.stopRequested) {
        throw new MiningCoordinationError("uncertain", "Demo stop is not confirmed.");
      }
      res.status(202).json({
        plantId: "D01",
        runId: body.runId,
        publisherStatus: result.status.phase,
        stopRequested: true,
        ingestionStatus: "unknown",
      });
    } catch (cause) {
      fail(res, cause);
    }
  });
  return router;
}
