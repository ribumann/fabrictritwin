import { Router } from "express";
import { proxyStreamingBackendGet, type StreamingBackendProxyOptions } from "../api/proxy.js";

const fields = new Set([
  "plantId",
  "runId",
  "asOf",
  "start",
  "end",
  "moduleId",
  "metric",
  "binMinutes",
  "maxRows",
]);
const metrics = new Set(["feed", "density", "vibration", "water-energy"]);
const routes = ["context", "overview", "trends", "incidents", "compare-lines", "runs/status"];
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export function createMiningRouter(
  options: StreamingBackendProxyOptions,
  synthetic = false,
): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  for (const route of routes) {
    router.get(`/${route}`, async (req, res) => {
      if (synthetic) {
        res.status(503).json({
          error: {
            code: "mining_live_required",
            message:
              "Mining requires the independently authorized Fabric backend; synthetic athlete data is not a mining source.",
          },
        });
        return;
      }
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(req.query)) {
        if (!fields.has(key) || typeof value !== "string" || value.length > 128) {
          res.status(400).json({
            error: { code: "invalid_mining_query", message: "Unsupported query field or value." },
          });
          return;
        }
        query.set(key, value);
      }
      const invalid =
        (["trends", "compare-lines"].includes(route) &&
          ["start", "end", "binMinutes", "maxRows", "metric"].some((key) => !query.has(key))) ||
        (route === "trends" && !query.has("moduleId")) ||
        (query.has("plantId") && query.get("plantId") !== "D01") ||
        ["runId", "moduleId"].some((key) => query.has(key) && !identifier.test(query.get(key)!)) ||
        (query.has("moduleId") && !query.get("moduleId")!.startsWith("D01.")) ||
        (query.has("metric") && !metrics.has(query.get("metric")!)) ||
        (query.has("binMinutes") && !["1", "5"].includes(query.get("binMinutes")!)) ||
        (query.has("maxRows") && !/^(?:[1-9]\d{0,2}|1000)$/.test(query.get("maxRows")!)) ||
        ["asOf", "start", "end"].some(
          (key) =>
            query.has(key) &&
            (!utc.test(query.get(key)!) || !Number.isFinite(Date.parse(query.get(key)!))),
        ) ||
        query.has("start") !== query.has("end");
      const duration = Date.parse(query.get("end") ?? "") - Date.parse(query.get("start") ?? "");
      if (invalid || (query.has("start") && (duration <= 0 || duration > 86_400_000))) {
        res.status(400).json({
          error: {
            code: "invalid_mining_query",
            message:
              "Use D01 identifiers, UTC times, a maximum 24-hour window and at most 1000 rows.",
          },
        });
        return;
      }
      query.set("plantId", "D01");
      await proxyStreamingBackendGet(
        req,
        res,
        { ...options, maxResponseBytes: 1_048_576 },
        () => {
          const url = new URL(`/api/mining/${route}`, options.streamingBackendBaseUrl);
          url.search = query.toString();
          return url;
        },
        "mining_backend_unavailable",
      );
    });
  }
  // Never promote anonymous actions to the viewer-scoped service identity.
  router.post(["/runs/start", "/runs/cancel", "/assistant"], (_req, res) => {
    res.status(503).json({
      error: {
        code: "mining_delegated_boundary_required",
        message:
          "This action is unavailable until verified human delegated authorization and separate backend mining authorization are connected.",
      },
    });
  });
  return router;
}
