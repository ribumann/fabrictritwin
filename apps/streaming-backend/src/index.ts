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

const app = express();
const port = process.env.PORT ?? 3000;
const server = createServer(app);
const synthetic = resolveRuntimeProfile() === "synthetic";
const runtime = synthetic ? new SyntheticRuntime() : undefined;
const alertListener = synthetic
  ? createDefaultAlertListener({
      athleteIds: [runtime!.dataset.athlete.athleteId],
      alertsService: runtime!.insights,
    })
  : createDefaultAlertListener();

app.use(express.json());
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
server.on("close", () => {
  runtime?.close();
  alertListener?.stop();
});
if (runtime) {
  // Upgraded WebSockets otherwise keep server.close() waiting indefinitely. Stop
  // the in-memory run immediately and close subscriptions as shutdown begins.
  const closeServer = server.close.bind(server);
  server.close = (callback) => {
    runtime.close();
    alertListener?.stop();
    for (const client of streamServer.clients) client.terminate();
    return closeServer(callback);
  };
}

// Compare via pathToFileURL (not a raw `file://` template string) so this also
// matches on Windows, where process.argv[1] is a drive-letter path with
// backslashes rather than a URL-encoded POSIX path.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(port, () => {
    console.log(`[streaming-backend] listening on port ${port}`);
  });
}

export { app, server, alertListener, runtime };
