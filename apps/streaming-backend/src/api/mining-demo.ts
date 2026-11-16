import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { JWTPayload } from "jose";
import { D01_CATALOG_VERSION, D01_PLANT_CATALOG } from "@triathlon-twin/simulator/mining";
import { verifyMcpCallerClaimsWithErrors } from "../auth/mcp-caller.js";
import { configuredMiningStore } from "../mining/blob-store.js";
import { MiningPublisherHost } from "../mining/publisher-host.js";
import { configuredMiningPublisherRuntime } from "../mining/publisher-runtime.js";
import { MiningRunCoordinator, isContinuousMiningRun } from "../mining/run-coordinator.js";
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

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const marker = (id: string) => `public-demo/${id}.json`;
const durationSeconds = 300;
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
}

function error(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

export function createMiningDemoHost(env: NodeJS.ProcessEnv = process.env): MiningPublisherHost {
  const snapshot = { ...env };
  return new MiningPublisherHost(() =>
    configuredMiningPublisherRuntime(snapshot, { minimumStartIntervalMs }),
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
  const curated = options.curated ?? createMiningDemoProvider(env);
  const answer = options.answer ?? createMiningAnswer(env);
  const continuous = options.continuous ?? createMiningContinuousProvider(env);
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
        run: visible
          ? {
              runId: visible.runId,
              admission: visible.admission,
              publisherStatus: visible.phase,
              stopRequested: visible.stopRequested,
              ingestionStatus: "unknown",
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
              assistant: { available: false, kind: "bounded-fabric-evidence" },
              capabilities: { incidents: false, trends: false, replay: false, assistant: false },
              unavailableReason:
                "Managed continuous source; waiting for a healthy owner and rolling-window coverage.",
            });
            return;
          }
          if (route !== "overview" || req.query.asOf) {
            error(
              res,
              503,
              "mining_continuous_capability_unavailable",
              "Continuous mode supports only current throughput/freshness; other views are unavailable.",
            );
            return;
          }
          if (!current || demo!.phase !== "running" || demo!.stopRequested) {
            error(
              res,
              503,
              "mining_continuous_unavailable",
              "The continuous publisher is not running; values are unavailable.",
            );
            return;
          }
          const asOf = new Date().toISOString();
          const data = await continuous(current, asOf, signal);
          const latest = await coordinator.currentStatus(signal);
          if (
            latest?.admission !== "accepted" ||
            latest.runId !== current.runId ||
            latest.phase !== "running" ||
            latest.stopRequested ||
            !latest.run ||
            !isContinuousMiningRun(latest.run) ||
            latest.run.lifetime.generation !== current.lifetime.generation
          ) {
            throw new MiningCoordinationError(
              "prerequisite",
              "Continuous authority changed during the read.",
            );
          }
          if (res.headersSent || res.destroyed) return;
          res.json({
            ...data,
            source,
            run: { ...publicRun, authorityUntil: latest.run.authorityUntil },
          });
          return;
        }
        const run =
          demo?.admission === "accepted" && demo.run?.contract
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
          res.json({
            plantId: "D01",
            approvedRun: run,
            catalogVersion: D01_CATALOG_VERSION,
            readAvailable: true,
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
          const metric = req.query.metric;
          if (
            metric !== "feed" &&
            metric !== "density" &&
            metric !== "vibration" &&
            metric !== "water-energy"
          ) {
            error(res, 400, "invalid_mining_query", "Unsupported mining metric.");
            return;
          }
          const window = {
            run: demo.run,
            start: new Date(String(req.query.start)).toISOString(),
            end: new Date(String(req.query.end)).toISOString(),
            metric,
            binMinutes: req.query.binMinutes === "1" ? 1 : 5,
            maxRows: Number(req.query.maxRows),
          } as const;
          input =
            route === "trends"
              ? { ...window, kind: "trend", moduleId: String(req.query.moduleId) }
              : { ...window, kind: "compare" };
        }
        const data = await curated(input, signal);
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
    if (continuousMode) {
      error(
        res,
        503,
        "mining_assistant_unavailable",
        "Continuous assistant evidence is not implemented.",
      );
      return;
    }
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
      const { store, coordinator } = dependencies();
      const signal: AbortSignal = res.locals.miningDemoSignal;
      const status = await coordinator.currentStatus(signal);
      if (
        status?.admission !== "accepted" ||
        !status.run?.contract ||
        !(await isDemoRun(store, status.runId, signal))
      ) {
        error(res, 404, "mining_demo_run_not_found", "Start a public demo run before asking.");
        return;
      }
      const asOf = new Date(now).toISOString();
      const overview = await curated({ kind: "overview", run: status.run, asOf }, signal);
      const evidence = JSON.stringify(overview);
      if (!overview || !("latest" in overview) || Buffer.byteLength(evidence) > 65_536) {
        throw new Error("Mining assistant evidence is unavailable or exceeds its bound.");
      }
      const text = await answer(body.question.trim(), evidence, signal);
      const latest = await coordinator.currentStatus(signal);
      if (latest?.runId !== status.runId || latest.stopRequested !== status.stopRequested) {
        throw new Error("The public run changed while answering; ask again.");
      }
      signal.throwIfAborted();
      if (!res.headersSent && !res.destroyed) {
        res.json({
          plantId: "D01",
          runId: status.runId,
          catalogVersion: D01_CATALOG_VERSION,
          answer: text,
          kind: "bounded-fabric-evidence",
          nativeDataAgentInvoked: false,
          groundedOn: [
            "validated latest readings",
            "five-minute summary",
            "event-ID reconciliation",
          ],
          evidence: overview,
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
    try {
      const { store } = dependencies();
      const signal: AbortSignal = res.locals.miningDemoSignal;
      const runId = randomUUID();
      if (!(await store.create(marker(runId), { version: 1, runId }))) {
        throw new MiningCoordinationError("conflict", "Demo identifier already exists.");
      }
      signal.throwIfAborted();
      const execution = host.start({ plantId: "D01", requestId: runId, durationSeconds }, signal);
      const admission = await execution.admission;
      const incidents = options.incidents;
      if (incidents) {
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
