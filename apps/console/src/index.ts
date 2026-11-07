/**
 * Demo Control Console entry point - minimal UI (seed-history / trigger-session /
 * trigger-race buttons) calling scripts/simulate/*.ps1 via the Streaming Backend.
 * T062 wires up the "Seed History" button; T076 wires up "Trigger Session"/"Trigger Race".
 */
import express from "express";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { createSeedHistoryAction } from "./actions/seed-history.js";
import { createTriggerSessionAction, createTriggerRaceAction } from "./actions/trigger-session.js";
import { createDefaultRaceIdAction } from "./actions/default-race-id.js";
import { createAuthDebugAction } from "./actions/auth-debug.js";
import { createServiceAuthDebugAction } from "./actions/service-auth-debug.js";

const app = express();
const port = process.env.PORT ?? 3001;
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

app.use(express.json());
app.use(express.static(publicDir));

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", service: "console" });
});

app.post(
  "/actions/seed-history",
  createSeedHistoryAction({
    // Same-tenant service-to-service URL; provisioned by container-apps.bicep (T025).
    streamingBackendBaseUrl: process.env.STREAMING_BACKEND_BASE_URL ?? "http://localhost:3000",
  }),
);

app.post(
  "/actions/trigger-session",
  createTriggerSessionAction({
    streamingBackendBaseUrl: process.env.STREAMING_BACKEND_BASE_URL ?? "http://localhost:3000",
  }),
);

app.post(
  "/actions/trigger-race",
  createTriggerRaceAction({
    streamingBackendBaseUrl: process.env.STREAMING_BACKEND_BASE_URL ?? "http://localhost:3000",
  }),
);

app.get("/actions/default-race-id", createDefaultRaceIdAction());

app.get("/actions/auth-debug", createAuthDebugAction());

app.get("/actions/service-auth-debug", createServiceAuthDebugAction());

// Compare via pathToFileURL (not a raw `file://` template string) so this also
// matches on Windows, where process.argv[1] is a drive-letter path with
// backslashes rather than a URL-encoded POSIX path.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(port, () => {
    console.log(`[console] listening on port ${port}`);
  });
}

export { app };
