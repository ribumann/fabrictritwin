import { Router, type Request } from "express";
import {
  D01_CATALOG_VERSION,
  D01_PLANT_CATALOG,
  D01_PLANT_ID,
  D01_PUBLISH_PROFILE_VERSION,
} from "@triathlon-twin/simulator/mining";
import { verifyMcpCallerPrincipalId } from "../auth/mcp-caller.js";
import { configuredMiningStore } from "../mining/blob-store.js";
import { MiningRunCoordinator, type MiningRunStatus } from "../mining/run-coordinator.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const principalId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const moduleIds = new Set(D01_PLANT_CATALOG.modules.map((module) => module.id));
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
  status?: (runId: string) => Promise<MiningRunStatus | undefined>;
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

function validateQuery(route: Route, query: Request["query"], now: number): string | undefined {
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
    (get("plantId") !== undefined && get("plantId") !== D01_PLANT_ID) ||
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

function runDto(status: MiningRunStatus) {
  if (status.admission === "rejected") return undefined;
  const publisherStatus =
    status.admission === "pending"
      ? "admission_pending"
      : status.phase === "stopping" || (status.phase === "running" && status.stopRequested)
        ? "stop_requested"
        : status.phase;
  if (publisherStatus === "rejected") return undefined;
  return {
    plantId: D01_PLANT_ID,
    runId: status.runId,
    catalogVersion: D01_CATALOG_VERSION,
    publisherStatus,
    ingestionStatus: "unknown" as const,
  };
}

async function boundedStatus(
  operation: Promise<MiningRunStatus | undefined>,
): Promise<MiningRunStatus | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Mining status read timed out.")), 10_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Read-only, opt-in and lazy: no sender, lease, or evaluator is started here. */
export function createMiningReadRouter(options: ReadOptions): Router {
  const router = Router();
  const env = options.env ?? process.env;
  const verify = options.verifyPrincipal ?? verifyMcpCallerPrincipalId;
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        error(res, 503, "mining_read_timeout", "The mining read exceeded its 10-second deadline.");
      }
    }, 9_900);
    res.once("close", () => clearTimeout(timer));
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
        env.MINING_APPROVED_CATALOG_VERSION !== D01_CATALOG_VERSION ||
        env.MINING_APPROVED_PROFILE_VERSION !== D01_PUBLISH_PROFILE_VERSION
      ) {
        error(
          res,
          503,
          "mining_read_configuration",
          "Mining authentication and approved-run configuration is incomplete or invalid.",
        );
        return;
      }
      const principal = await verify(req);
      if (res.headersSent) return;
      if (!principal) {
        error(res, 401, "mining_authentication_required", "A verified bearer token is required.");
        return;
      }
      if (!viewers.includes(principal)) {
        error(res, 403, "mining_viewer_forbidden", "The caller is not an approved mining viewer.");
        return;
      }
      const invalid = validateQuery(route, req.query, (options.now ?? Date.now)());
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
          ((id: string) => {
            const store = configuredMiningStore(env);
            if (!store) throw new Error("Mining durable status store is not configured.");
            return new MiningRunCoordinator(store).status(id);
          });
        const status = await boundedStatus(statusReader(runId));
        if (res.headersSent) return;
        if (!status || status.runId !== runId || !runDto(status)) {
          error(
            res,
            404,
            "mining_run_not_found",
            "The approved run has no matching durable admission.",
          );
          return;
        }
        const run = runDto(status)!;
        if (route === "runs/status") {
          res.json(run);
        } else {
          res.json({
            plantId: D01_PLANT_ID,
            approvedRun: run,
            catalogVersion: D01_CATALOG_VERSION,
            readAvailable: false,
            unavailableReason:
              "Validated curated mining queries and persisted incidents are not connected.",
            assistant: { available: false },
          });
        }
      } catch (cause) {
        console.error("[mining-read] Durable status read failed", cause);
        if (res.headersSent) return;
        error(
          res,
          503,
          "mining_status_unavailable",
          "The approved run's durable status is unavailable.",
        );
      }
    });
  }
  return router;
}
