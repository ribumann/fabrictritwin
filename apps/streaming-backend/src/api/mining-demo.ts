import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { JWTPayload } from "jose";
import { verifyMcpCallerClaimsWithErrors } from "../auth/mcp-caller.js";
import { configuredMiningStore } from "../mining/blob-store.js";
import { MiningPublisherHost } from "../mining/publisher-host.js";
import { configuredMiningPublisherRuntime } from "../mining/publisher-runtime.js";
import { MiningRunCoordinator } from "../mining/run-coordinator.js";
import { MiningCoordinationError, type MiningStore } from "../mining/store.js";

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
  const fail = (res: Response, cause: unknown) => {
    console.error("[mining-demo] Request failed", cause);
    if (res.headersSent || res.destroyed) return;
    if (cause instanceof MiningCoordinationError && cause.code === "conflict") {
      error(res, 409, "mining_demo_busy", "A run is active or the demo cooldown has not elapsed.");
    } else {
      error(res, 503, "mining_demo_unavailable", "The mining demo is unavailable; check status.");
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
      const visible = status && (await isDemoRun(store, status.runId, signal)) ? status : null;
      if (res.headersSent || res.destroyed) return;
      res.json({
        plantId: "D01",
        run: visible
          ? {
              runId: visible.runId,
              admission: visible.admission,
              publisherStatus: visible.phase,
              stopRequested: visible.stopRequested,
              ingestionStatus: "unknown",
            }
          : null,
      });
    } catch (cause) {
      fail(res, cause);
    }
  });

  router.post("/runs/start", async (req, res) => {
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
