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

const app = express();
const port = process.env.PORT ?? 3000;
const server = createServer(app);
const alertListener = createDefaultAlertListener();

app.use(express.json());
app.use("/api/analyses", createAnalysesRouter());
app.use("/api/alerts", createAlertsRouter());
app.use("/api/assistant", createAssistantRouter());
app.use("/api/data-gaps", createDataGapsRouter());
app.use("/api/race", createRaceRouter());
app.use("/api/simulate", createSimulateRouter());

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", service: "streaming-backend" });
});

attachStreamServer(server);
alertListener?.start();

// Compare via pathToFileURL (not a raw `file://` template string) so this also
// matches on Windows, where process.argv[1] is a drive-letter path with
// backslashes rather than a URL-encoded POSIX path.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(port, () => {
    console.log(`[streaming-backend] listening on port ${port}`);
  });
}

export { app, server, alertListener };
