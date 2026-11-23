import { Router } from "express";
import {
  awaitWithAbort,
  proxyStreamingBackendGet,
  proxyStreamingBackendPost,
  type StreamingBackendProxyOptions,
} from "../api/proxy.js";
import { buildServiceAuthHeaders } from "../api/service-auth.js";

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
const metrics = new Set([
  "feed",
  "density",
  "vibration",
  "water-energy",
  "sorter-feed",
  "motor-current",
  "bearing-temperature",
  "feed-pressure",
]);
const routes = [
  "context",
  "overview",
  "trends",
  "incidents",
  "compare-lines",
  "cross-run-trends",
  "runs/status",
];
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

async function crossRunTrendsAvailable(
  options: StreamingBackendProxyOptions,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  const url = new URL("/api/mining/demo/context?plantId=D01", options.streamingBackendBaseUrl);
  const response = await awaitWithAbort(
    (options.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers,
      signal,
    }),
    signal,
  );
  if (!response.ok || !response.body) throw new Error("Mining context is unavailable.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await awaitWithAbort(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16_384) {
        await awaitWithAbort(reader.cancel(), signal);
        throw new Error("Mining context exceeds the permitted byte limit.");
      }
      chunks.push(value);
    }
  } finally {
    if (signal.aborted) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const context: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return (
    typeof context === "object" &&
    context !== null &&
    "mode" in context &&
    context.mode === "continuous" &&
    "capabilities" in context &&
    typeof context.capabilities === "object" &&
    context.capabilities !== null &&
    "trends" in context.capabilities &&
    context.capabilities.trends === true
  );
}

export function createMiningRouter(
  options: StreamingBackendProxyOptions,
  synthetic = false,
  demoEnabled = process.env.MINING_PUBLIC_DEMO_ENABLED === "true",
  demoReadEnabled = process.env.MINING_PUBLIC_DEMO_READ_ENABLED === "true",
): Router {
  const router = Router();
  let startTimes: number[] = [];
  let cancelTimes: number[] = [];
  let questionTimes: number[] = [];
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.get("/demo/runs/status", async (req, res) => {
    if (synthetic || !demoEnabled) {
      res
        .status(503)
        .json({ error: { code: "mining_demo_disabled", message: "Mining demo is disabled." } });
      return;
    }
    if (Object.keys(req.query).length) {
      res.status(400).json({
        error: { code: "invalid_mining_demo", message: "No query parameters are supported." },
      });
      return;
    }
    await proxyStreamingBackendGet(
      req,
      res,
      // The public status includes up to 120 simulator points and 120 Fabric receipts.
      { ...options, maxResponseBytes: 65_536 },
      () => new URL("/api/mining/demo/runs/status", options.streamingBackendBaseUrl),
      "mining_backend_unavailable",
    );
  });
  router.post(["/demo/runs/start", "/demo/runs/cancel"], async (req, res) => {
    if (synthetic || !demoEnabled) {
      res
        .status(503)
        .json({ error: { code: "mining_demo_disabled", message: "Mining demo is disabled." } });
      return;
    }
    const origin = req.get("origin");
    let sameOrigin: boolean;
    try {
      const url = new URL(origin ?? "");
      sameOrigin =
        url.host === req.get("host") && (url.protocol === "https:" || url.hostname === "localhost");
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin || !req.is("application/json")) {
      res
        .status(403)
        .json({ error: { code: "mining_demo_origin", message: "Use the same-origin demo page." } });
      return;
    }
    const body: unknown = req.body;
    const cancel = req.path.endsWith("/cancel");
    if (
      Object.keys(req.query).length ||
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== (cancel ? 2 : 1) ||
      !("plantId" in body) ||
      body.plantId !== "D01" ||
      (cancel &&
        (!("runId" in body) ||
          typeof body.runId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            body.runId,
          )))
    ) {
      res
        .status(400)
        .json({ error: { code: "invalid_mining_demo", message: "Invalid demo action." } });
      return;
    }
    const now = Date.now();
    startTimes = startTimes.filter((time) => now - time < 60_000);
    cancelTimes = cancelTimes.filter((time) => now - time < 60_000);
    const actionTimes = cancel ? cancelTimes : startTimes;
    if (actionTimes.length >= (cancel ? 20 : 5)) {
      res.setHeader("Retry-After", "60");
      res
        .status(429)
        .json({ error: { code: "mining_demo_rate_limited", message: "Try again later." } });
      return;
    }
    actionTimes.push(now);
    await proxyStreamingBackendPost(
      req,
      res,
      { ...options, maxResponseBytes: 16_384 },
      () => new URL(`/api/mining${req.path}`, options.streamingBackendBaseUrl),
      body,
      "mining_backend_unavailable",
    );
  });
  router.post("/demo/assistant", async (req, res) => {
    if (synthetic || !demoEnabled || !demoReadEnabled) {
      res.status(503).json({
        error: { code: "mining_assistant_unavailable", message: "Mining assistant is disabled." },
      });
      return;
    }
    let sameOrigin: boolean;
    try {
      const origin = new URL(req.get("origin") ?? "");
      sameOrigin =
        origin.host === req.get("host") &&
        (origin.protocol === "https:" || origin.hostname === "localhost");
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin || !req.is("application/json")) {
      res.status(403).json({
        error: { code: "mining_demo_origin", message: "Use the same-origin demo page." },
      });
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
      res.status(400).json({
        error: { code: "invalid_mining_question", message: "Provide D01 and a bounded question." },
      });
      return;
    }
    const now = Date.now();
    questionTimes = questionTimes.filter((time) => now - time < 60_000);
    if (questionTimes.length >= 6) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({
        error: { code: "mining_assistant_busy", message: "The shared demo is busy; try later." },
      });
      return;
    }
    questionTimes.push(now);
    await proxyStreamingBackendPost(
      req,
      res,
      { ...options, maxResponseBytes: 131_072 },
      () => new URL("/api/mining/demo/assistant", options.streamingBackendBaseUrl),
      { plantId: "D01", question: body.question.trim() },
      "mining_assistant_unavailable",
    );
  });
  for (const route of ["connection-latest", "connection-trend"] as const) {
    router.get(`/${route}`, async (req, res) => {
      if (synthetic || !demoEnabled || !demoReadEnabled) {
        res.status(503).json({
          error: {
            code: "mining_demo_read_disabled",
            message: "Public mining reads are disabled.",
          },
        });
        return;
      }
      const withRun = typeof req.query.runId === "string";
      const keys =
        route === "connection-latest"
          ? ["plantId", ...(withRun ? ["runId"] : [])]
          : [
              "plantId",
              ...(withRun ? ["runId"] : []),
              "streamIds",
              "start",
              "end",
              "windowSeconds",
            ];
      const values = req.query;
      const streams = typeof values.streamIds === "string" ? values.streamIds.split(",") : [];
      const duration =
        typeof values.end === "string" && typeof values.start === "string"
          ? Date.parse(values.end) - Date.parse(values.start)
          : NaN;
      if (
        Object.keys(values).length !== keys.length ||
        keys.some((key) => typeof values[key] !== "string") ||
        values.plantId !== "D01" ||
        (withRun &&
          (typeof values.runId !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
              values.runId,
            ))) ||
        (route === "connection-trend" &&
          (streams.length < 1 ||
            streams.length > 3 ||
            new Set(streams).size !== streams.length ||
            streams.some((id) => !identifier.test(id)) ||
            typeof values.start !== "string" ||
            typeof values.end !== "string" ||
            !utc.test(values.start) ||
            !utc.test(values.end) ||
            !Number.isFinite(duration) ||
            duration <= 0 ||
            duration > 900_000 ||
            !["30", "60"].includes(String(values.windowSeconds))))
      ) {
        res.status(400).json({
          error: { code: "invalid_mining_query", message: "Invalid connection flow request." },
        });
        return;
      }
      await proxyStreamingBackendGet(
        req,
        res,
        { ...options, maxResponseBytes: 1_048_576 },
        () => {
          const url = new URL(`/api/mining/demo/${route}`, options.streamingBackendBaseUrl);
          for (const key of keys) url.searchParams.set(key, values[key] as string);
          return url;
        },
        "mining_backend_unavailable",
      );
    });
  }
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
        (route === "cross-run-trends" &&
          (!demoEnabled ||
            !demoReadEnabled ||
            [...query.keys()].some(
              (key) => !["plantId", "start", "end", "metric", "binMinutes"].includes(key),
            ) ||
            ["start", "end", "metric", "binMinutes"].some((key) => !query.has(key)))) ||
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
      if (route === "cross-run-trends") {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(new Error("Mining trend deadline exceeded.")),
          9_000,
        );
        const disconnect = () => {
          if (!res.writableEnded) controller.abort(new Error("Mining trend client disconnected."));
        };
        req.once("aborted", disconnect);
        res.once("close", disconnect);
        try {
          const headers = await awaitWithAbort(
            options.buildAuthHeaders
              ? options.buildAuthHeaders(controller.signal)
              : buildServiceAuthHeaders({ abortSignal: controller.signal }),
            controller.signal,
          );
          if (!(await crossRunTrendsAvailable(options, headers, controller.signal))) {
            res.status(503).json({
              error: {
                code: "mining_trend_unavailable",
                message: "Continuous trends are unavailable.",
              },
            });
            return;
          }
          controller.signal.throwIfAborted();
          await proxyStreamingBackendGet(
            req,
            res,
            {
              ...options,
              maxResponseBytes: 1_048_576,
              signal: controller.signal,
              buildAuthHeaders: async () => headers,
            },
            () => {
              const url = new URL(
                "/api/mining/demo/cross-run-trends",
                options.streamingBackendBaseUrl,
              );
              url.search = query.toString();
              return url;
            },
            "mining_backend_unavailable",
          );
        } catch (error) {
          if (res.destroyed || res.headersSent) return;
          console.error("[mining] Unable to check continuous trend capability", error);
          res.status(controller.signal.aborted ? 504 : 503).json({
            error: {
              code: "mining_trend_unavailable",
              message: "Continuous trend capability is unavailable.",
            },
          });
        } finally {
          clearTimeout(timeout);
          req.removeListener("aborted", disconnect);
          res.removeListener("close", disconnect);
        }
        return;
      }
      await proxyStreamingBackendGet(
        req,
        res,
        { ...options, maxResponseBytes: 1_048_576 },
        () => {
          const prefix =
            demoEnabled && demoReadEnabled && route !== "runs/status"
              ? "/api/mining/demo"
              : "/api/mining";
          const url = new URL(`${prefix}/${route}`, options.streamingBackendBaseUrl);
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
