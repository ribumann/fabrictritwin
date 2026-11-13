import express from "express";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { createAlertsRouter } from "./api/alerts.js";
import { createAnalysesRouter } from "./api/analyses.js";
import { createAssistantRouter } from "./api/assistant.js";
import { createContextAction } from "./api/context.js";
import { createDataGapsRouter } from "./api/data-gaps.js";
import { createPowerBiEmbedConfigAction } from "./api/powerbi.js";
import { createRaceRouter } from "./api/race.js";
import { createDemoRouter } from "./api/demo.js";
import { createSimulateRouter } from "./api/simulate.js";
import { resolveBackendConnection } from "./api/backend-connection.js";
import { proxyStreamingBackendGet, proxyStreamingBackendPost } from "./api/proxy.js";
import { attachCockpitStreamRelay } from "./api/stream-relay.js";
import { createMiningRouter } from "./mining/router.js";

const app = express();
const port = process.env.PORT ?? 3300;
const server = createServer(app);
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui", "public");
const streamingBackendBaseUrl = process.env.STREAMING_BACKEND_BASE_URL ?? "http://localhost:3000";
const profile = process.env.DEMO_PROFILE ?? "live";
if (profile !== "live" && profile !== "synthetic") {
  throw new Error("DEMO_PROFILE must be exactly live or synthetic.");
}
const synthetic = profile === "synthetic";
const { anonymous } = resolveBackendConnection(profile, streamingBackendBaseUrl);
const proxyOptions = {
  streamingBackendBaseUrl,
  ...(anonymous ? { buildAuthHeaders: async () => ({}) } : {}),
};

app.use(express.json());
app.get(["/mining", "/mining/"], (_req, res) => {
  res.sendFile(path.join(publicDir, "mining", "index.html"));
});
const generatedPublicDir = path.resolve(publicDir, "../../../dist/ui/public");
app.get(["/mining/catalog.json", "/mining/catalog-receipt.json"], (req, res) => {
  res.sendFile(path.join(generatedPublicDir, req.path));
});
app.use("/vendor/three", express.static(path.join(generatedPublicDir, "vendor/three")));
app.use(express.static(publicDir));
app.use("/api/mining", createMiningRouter(proxyOptions, synthetic));

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", service: "cockpit" });
});

if (synthetic) {
  app.get("/api/context", async (req, res) => {
    await proxyStreamingBackendGet(
      req,
      res,
      proxyOptions,
      () => new URL("/api/demo/context", streamingBackendBaseUrl),
      "demo_context_failed",
    );
  });
  app.use("/api/demo", createDemoRouter(proxyOptions));
  app.post("/api/assistant", async (req, res) => {
    await proxyStreamingBackendPost(
      req,
      res,
      proxyOptions,
      () => new URL("/api/assistant", streamingBackendBaseUrl),
      req.body,
      "demo_assistant_failed",
    );
  });
  app.get("/api/powerbi/embed-config", (_req, res) => {
    res.status(503).json({
      error: {
        code: "live_only",
        message:
          "Power BI requires a live deployment and protected data access. Synthetic charts are available without sign-in.",
      },
    });
  });
  app.use("/api/assistant", (_req, res) => {
    res.status(403).json({
      error: {
        code: "live_only",
        message: "MCP and Foundry are not enabled in the synthetic demo.",
      },
    });
  });
  app.use("/api/data-gaps", (_req, res) => {
    res.status(403).json({
      error: {
        code: "live_only",
        message: "Cloud ingestion administration is not enabled in the synthetic demo.",
      },
    });
  });
} else {
  app.get("/api/context", createContextAction());
  app.get("/api/powerbi/embed-config", createPowerBiEmbedConfigAction());
  app.use("/api/assistant", createAssistantRouter({ streamingBackendBaseUrl }));
  app.use("/api/data-gaps", createDataGapsRouter({ streamingBackendBaseUrl }));
}
app.use("/api/analyses", createAnalysesRouter(proxyOptions));
app.use("/api/alerts", createAlertsRouter(proxyOptions));
app.use("/api/race", createRaceRouter(proxyOptions));
app.use("/api/simulate", createSimulateRouter(proxyOptions));

attachCockpitStreamRelay(server, { streamingBackendBaseUrl, anonymous });

// Compare via pathToFileURL (not a raw `file://` template string) so this also
// matches on Windows, where process.argv[1] is a drive-letter path with
// backslashes rather than a URL-encoded POSIX path.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(port, () => {
    console.log(`[cockpit] listening on port ${port}`);
  });
}

export { app, server };
