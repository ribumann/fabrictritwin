import { Router, type Request, type Response } from "express";
import { verifyMcpCallerPrincipalIdWithErrors } from "../auth/mcp-caller.js";
import { configuredMiningStore } from "../mining/blob-store.js";
import { MiningRunCoordinator, type MiningRunStatus } from "../mining/run-coordinator.js";
import { MiningCoordinationError } from "../mining/store.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const principalId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const plantId = "D01";
const metrics = new Set(["feed", "density", "vibration", "water-energy"]);
const routes = [
  "context",
  "overview",
  "trends",
  "incidents",
  "compare-lines",
  "runs/status",
] as const;
type Route = (typeof routes)[number];

interface ReadOptions {
  synthetic: boolean;
  env?: NodeJS.ProcessEnv;
  verifyPrincipal?: (req: Request) => Promise<string | undefined>;
  status?: (runId: string, signal?: AbortSignal) => Promise<MiningRunStatus | undefined>;
  now?: () => number;
}

function error(
  res: import("express").Response,
  status: number,
  code: string,
  message: string,
): void {
  res.status(status).json({ error: { code, message } });
}

function validDate(value: string, now: number): boolean {
  if (!utc.test(value)) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > now) return false;
  const normalized = value.replace(
    /(?:\.(\d{1,3}))?Z$/,
    (_, fraction: string | undefined) => `.${(fraction ?? "").padEnd(3, "0")}Z`,
  );
  return new Date(parsed).toISOString() === normalized;
}

function validateQuery(
  route: Route,
  query: Request["query"],
  now: number,
  moduleIds: ReadonlySet<string>,
): string | undefined {
  const fields: Record<Route, string[]> = {
    context: ["plantId", "runId"],
    overview: ["plantId", "runId", "asOf"],
    trends: ["plantId", "runId", "start", "end", "moduleId", "metric", "binMinutes", "maxRows"],
    incidents: ["plantId", "runId", "asOf"],
    "compare-lines": ["plantId", "runId", "start", "end", "metric", "binMinutes", "maxRows"],
    "runs/status": ["plantId", "runId"],
  };
  for (const [key, value] of Object.entries(query)) {
    if (!fields[route].includes(key) || typeof value !== "string" || value.length > 128) {
      return "Unsupported query field or value.";
    }
  }
  const get = (key: string) => query[key] as string | undefined;
  if (
    (get("plantId") !== undefined && get("plantId") !== plantId) ||
    (get("runId") !== undefined && !uuid.test(get("runId")!))
  ) {
    return "Only D01 and canonical lowercase UUID run IDs are supported.";
  }
  if (
    ["asOf", "start", "end"].some((key) => get(key) !== undefined && !validDate(get(key)!, now))
  ) {
    return "Times must be valid UTC timestamps not in the future.";
  }
  if (route === "trends" || route === "compare-lines") {
    const start = get("start");
    const end = get("end");
    if (route === "compare-lines" && get("metric") === "water-energy") {
      return "Water and energy are not supported as per-line comparison metrics.";
    }
    if (
      !start ||
      !end ||
      Date.parse(end) <= Date.parse(start) ||
      Date.parse(end) - Date.parse(start) > 86_400_000 ||
      !metrics.has(get("metric") ?? "") ||
      !["1", "5"].includes(get("binMinutes") ?? "") ||
      !/^(?:[1-9]\d{0,2}|1000)$/.test(get("maxRows") ?? "") ||
      (route === "trends" && !moduleIds.has(get("moduleId") ?? ""))
    )
      return "Use a canonical module, metric, 1 or 5 minute bins, at most 1000 rows and a window up to 24 hours.";
  }
  return undefined;
}

function runDto(status: MiningRunStatus, catalogVersion: string) {
  if (status.admission === "rejected") return undefined;
  const publisherStatus =
    status.admission === "pending"
      ? "admission_pending"
      : status.phase === "stopping" || (status.phase === "running" && status.stopRequested)
        ? "stop_requested"
        : status.phase;
  if (publisherStatus === "rejected") return undefined;
  return {
    plantId,
    runId: status.runId,
    catalogVersion,
    publisherStatus,
    ingestionStatus: "unknown" as const,
  };
}

/** Read-only, opt-in and lazy: no sender, lease, or evaluator is started here. */
export function createMiningReadRouter(options: ReadOptions): Router {
  const router = Router();
  const env = options.env ?? process.env;
  const verify = options.verifyPrincipal ?? verifyMcpCallerPrincipalIdWithErrors;
  const controllers = new WeakMap<Response, AbortController>();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    const controller = new AbortController();
    controllers.set(res, controller);
    const timer = setTimeout(() => {
      controller.abort();
      if (!res.headersSent && !res.destroyed) {
        error(res, 503, "mining_read_timeout", "The mining read exceeded its 10-second deadline.");
      }
    }, 9_900);
    res.once("finish", () => clearTimeout(timer));
    res.once("close", () => {
      clearTimeout(timer);
      controller.abort();
    });
    next();
  });
  router.post(
    ["/runs/start", "/runs/cancel", "/assistant", "/incidents/:incidentId/ack"],
    (_req, res) => {
      error(
        res,
        503,
        "mining_delegated_boundary_required",
        "Mining actions require a separately authorized delegated boundary.",
      );
    },
  );
  for (const route of routes) {
    router.get(`/${route}`, async (req, res) => {
      if (options.synthetic || env.MINING_READ_ENABLED !== "true") {
        error(res, 503, "mining_read_unavailable", "Mining reads require an enabled live backend.");
        return;
      }
      const viewers = (env.MINING_VIEWER_PRINCIPAL_IDS ?? "").split(",").map((id) => id.trim());
      const approved = env.MINING_APPROVED_RUN_ID;
      if (
        !env.ASSISTANT_AUTH_TENANT_ID ||
        !env.ASSISTANT_AUTH_CLIENT_ID ||
        !viewers.length ||
        viewers.some((id) => !principalId.test(id)) ||
        !approved ||
        !uuid.test(approved) ||
        !env.MINING_APPROVED_CATALOG_VERSION ||
        !env.MINING_APPROVED_PROFILE_VERSION
      ) {
        error(
          res,
          503,
          "mining_read_configuration",
          "Mining authentication and approved-run configuration is incomplete or invalid.",
        );
        return;
      }
      let principal: string | undefined;
      try {
        principal = await verify(req);
      } catch (cause) {
        console.error("[mining-read] Bearer verification failed", cause);
        if (!res.headersSent && !res.destroyed) {
          error(
            res,
            503,
            "mining_authentication_unavailable",
            "Bearer verification is unavailable.",
          );
        }
        return;
      }
      if (res.headersSent || res.destroyed) return;
      if (!principal) {
        error(res, 401, "mining_authentication_required", "A verified bearer token is required.");
        return;
      }
      if (!viewers.includes(principal)) {
        error(res, 403, "mining_viewer_forbidden", "The caller is not an approved mining viewer.");
        return;
      }
      let catalog: typeof import("@triathlon-twin/simulator/mining");
      try {
        catalog = await import("@triathlon-twin/simulator/mining");
      } catch (cause) {
        console.error("[mining-read] Failed to load the mining catalog", cause);
        if (!res.headersSent && !res.destroyed) {
          error(res, 503, "mining_catalog_unavailable", "The mining catalog is unavailable.");
        }
        return;
      }
      if (res.headersSent || res.destroyed) return;
      if (
        env.MINING_APPROVED_CATALOG_VERSION !== catalog.D01_CATALOG_VERSION ||
        env.MINING_APPROVED_PROFILE_VERSION !== catalog.D01_PUBLISH_PROFILE_VERSION
      ) {
        error(
          res,
          503,
          "mining_read_configuration",
          "The approved mining versions do not match the catalog.",
        );
        return;
      }
      const invalid = validateQuery(
        route,
        req.query,
        (options.now ?? Date.now)(),
        new Set(catalog.D01_PLANT_CATALOG.modules.map((module) => module.id)),
      );
      if (invalid) {
        error(res, 400, "invalid_mining_query", invalid);
        return;
      }
      const runId = (req.query.runId as string | undefined) ?? approved;
      if (runId !== approved) {
        error(res, 403, "mining_run_forbidden", "The requested run is not approved.");
        return;
      }
      if (route !== "context" && route !== "runs/status") {
        error(
          res,
          503,
          "mining_curated_source_unavailable",
          "The validated curated mining query contract is not deployed or connected.",
        );
        return;
      }
      try {
        const statusReader =
          options.status ??
          ((id: string, signal?: AbortSignal) => {
            const store = configuredMiningStore(env);
            if (!store) throw new Error("Mining durable status store is not configured.");
            return new MiningRunCoordinator(store).status(id, signal);
          });
        const status = await statusReader(runId, controllers.get(res)?.signal);
        if (res.headersSent || res.destroyed) return;
        if (!status || status.runId !== runId) {
          error(
            res,
            404,
            "mining_run_not_found",
            "The approved run has no matching durable admission.",
          );
          return;
        }
        const run = runDto(status, catalog.D01_CATALOG_VERSION);
        if (!run) {
          error(res, 409, "mining_admission_rejected", "The approved run admission was rejected.");
          return;
        }
        if (route === "runs/status") {
          res.json(run);
        } else {
          res.json({
            plantId,
            approvedRun: run,
            catalogVersion: catalog.D01_CATALOG_VERSION,
            readAvailable: false,
            unavailableReason:
              "Validated curated mining queries and persisted incidents are not connected.",
            assistant: { available: false },
          });
        }
      } catch (cause) {
        if (res.headersSent || res.destroyed) return;
        console.error("[mining-read] Durable status read failed", cause);
        const code = cause instanceof MiningCoordinationError ? cause.code : "unavailable";
        error(
          res,
          503,
          `mining_status_${code}`,
          "The approved run's durable status is unavailable.",
        );
      }
    });
  }
  return router;
}
