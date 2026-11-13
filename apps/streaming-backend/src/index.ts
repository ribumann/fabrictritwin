import express from "express";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createAlertsRouter } from "./api/alerts.js";
import { createAnalysesRouter } from "./api/analyses.js";
import { createAssistantRouter } from "./api/assistant.js";
import { createDataGapsRouter } from "./api/data-gaps.js";
import { createRaceRouter } from "./api/race.js";
import { createSimulateRouter } from "./api/simulate.js";
import { attachStreamServer } from "./api/stream.js";
import { createDefaultAlertListener } from "./services/alert-listener.js";
import { resolveRuntimeProfile } from "./services/runtime-profile.js";
import { SyntheticRuntime } from "./services/synthetic-runtime.js";
import { createSyntheticRouter } from "./api/synthetic.js";
import { createMiningReadRouter } from "./api/mining-read.js";
import { configuredMiningCuratedProvider } from "./mining/read/runtime.js";
import { createMiningCancelRouter } from "./api/mining-cancel.js";
import { createMiningStartRouter } from "./api/mining-start.js";
import { MiningPublisherHost } from "./mining/publisher-host.js";
import { createBackendShutdown } from "./services/backend-shutdown.js";

const app = express();
const port = process.env.PORT ?? 3000;
const server = createServer(app);
const synthetic = resolveRuntimeProfile() === "synthetic";
const runtime = synthetic ? new SyntheticRuntime() : undefined;
const miningPublisherHost = synthetic ? undefined : new MiningPublisherHost();
const alertListener = synthetic
  ? createDefaultAlertListener({
      athleteIds: [runtime!.dataset.athlete.athleteId],
      alertsService: runtime!.insights,
    })
  : createDefaultAlertListener();

app.use(express.json());
app.use("/api/mining", createMiningStartRouter({ synthetic, host: miningPublisherHost }));
app.use("/api/mining", createMiningCancelRouter({ synthetic }));
app.use(
  "/api/mining",
  createMiningReadRouter({
    synthetic,
    curated: synthetic ? undefined : configuredMiningCuratedProvider(),
  }),
);
if (runtime) {
  app.use("/api", createSyntheticRouter(runtime));
} else {
  app.use("/api/analyses", createAnalysesRouter());
  app.use("/api/alerts", createAlertsRouter());
  app.use("/api/assistant", createAssistantRouter());
  app.use("/api/data-gaps", createDataGapsRouter());
  app.use("/api/race", createRaceRouter());
  app.use("/api/simulate", createSimulateRouter());
}

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", service: "streaming-backend" });
});

const streamServer = attachStreamServer(server, { synthetic });
alertListener?.start();
const closeServer = server.close.bind(server);
const shutdown = createBackendShutdown({
  closePublisher: () => miningPublisherHost?.close(),
  stopBackgroundServices: () => {
    runtime?.close();
    alertListener?.stop();
  },
  terminateStreams: () => {
    for (const client of streamServer.clients) client.terminate();
  },
  closeHttp: () =>
    new Promise<void>((resolve, reject) => {
      closeServer((cause) => (cause ? reject(cause) : resolve()));
    }),
});

server.close = (callback) => {
  void shutdown().then(
    () => callback?.(),
    (cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (callback) callback(error);
      else console.error("[streaming-backend] Shutdown failed", cause);
    },
  );
  return server;
};

function handleShutdownSignal(signal: NodeJS.Signals): void {
  console.log(`[streaming-backend] received ${signal}; shutting down`);
  void shutdown().then(
    () => {
      console.log("[streaming-backend] shutdown complete");
    },
    (cause: unknown) => {
      console.error("[streaming-backend] Shutdown failed", cause);
      process.exitCode = 1;
    },
  );
}

// Compare via pathToFileURL (not a raw `file://` template string) so this also
// matches on Windows, where process.argv[1] is a drive-letter path with
// backslashes rather than a URL-encoded POSIX path.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.once("SIGTERM", () => handleShutdownSignal("SIGTERM"));
  process.once("SIGINT", () => handleShutdownSignal("SIGINT"));
  server.listen(port, () => {
    console.log(`[streaming-backend] listening on port ${port}`);
  });
}

export { app, server, alertListener, runtime };
