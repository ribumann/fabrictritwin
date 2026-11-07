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
import { attachCockpitStreamRelay } from "./api/stream-relay.js";

const app = express();
const port = process.env.PORT ?? 3300;
const server = createServer(app);
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui", "public");
const streamingBackendBaseUrl = process.env.STREAMING_BACKEND_BASE_URL ?? "http://localhost:3000";

app.use(express.json());
app.use(express.static(publicDir));

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", service: "cockpit" });
});

app.get("/api/context", createContextAction());
app.get("/api/powerbi/embed-config", createPowerBiEmbedConfigAction());
app.use("/api/assistant", createAssistantRouter({ streamingBackendBaseUrl }));
app.use("/api/analyses", createAnalysesRouter({ streamingBackendBaseUrl }));
app.use("/api/alerts", createAlertsRouter({ streamingBackendBaseUrl }));
app.use("/api/data-gaps", createDataGapsRouter({ streamingBackendBaseUrl }));
app.use("/api/race", createRaceRouter({ streamingBackendBaseUrl }));

attachCockpitStreamRelay(server, { streamingBackendBaseUrl });

// Compare via pathToFileURL (not a raw `file://` template string) so this also
// matches on Windows, where process.argv[1] is a drive-letter path with
// backslashes rather than a URL-encoded POSIX path.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(port, () => {
    console.log(`[cockpit] listening on port ${port}`);
  });
}

export { app, server };
