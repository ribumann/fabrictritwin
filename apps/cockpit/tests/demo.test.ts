import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { createSimulateRouter } from "../src/api/simulate.js";

let upstreamServer: Server | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (upstreamServer) {
    await new Promise<void>((resolve, reject) =>
      upstreamServer?.close((error) => (error ? reject(error) : resolve())),
    );
    upstreamServer = undefined;
  }
});

async function serve(app: express.Express): Promise<string> {
  upstreamServer = createServer(app);
  await new Promise<void>((resolve) => upstreamServer?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(upstreamServer.address() as AddressInfo).port}`;
}

describe("synthetic Cockpit boundary", () => {
  it("uses only the backend-owned context and rejects cloud administration", async () => {
    const upstream = express();
    upstream.get("/api/demo/context", (req, res) => {
      expect(req.headers.authorization).toBeUndefined();
      expect(req.headers["x-ms-client-principal"]).toBeUndefined();
      expect(req.query).toEqual({});
      res.json({
        selectedAthleteId: "fixed-demo-athlete",
        selectedRaceId: "fixed-demo-race",
        provenance: { source: "synthetic" },
      });
    });
    vi.stubEnv("DEMO_PROFILE", "synthetic");
    vi.stubEnv("STREAMING_BACKEND_BASE_URL", await serve(upstream));
    vi.resetModules();
    const { app } = await import("../src/index.js");
    const context = await request(app)
      .get("/api/context?athleteId=untrusted&raceId=untrusted")
      .set("x-ms-client-principal", "spoof")
      .set("authorization", "Bearer untrusted");
    expect(context.status).toBe(200);
    expect(context.body.selectedAthleteId).toBe("fixed-demo-athlete");
    expect((await request(app).post("/api/assistant/mcp-query").send({})).status).toBe(403);
    expect((await request(app).get("/api/data-gaps/anything")).status).toBe(403);
    expect((await request(app).post("/api/simulate/seed-history").send({})).status).toBe(404);
    expect((await request(app).get("/api/powerbi/embed-config")).body.error.code).toBe("live_only");
  }, 15_000);

  it("relays rate feedback and forwards only explicitly supported actions", async () => {
    const upstream = express();
    upstream.use(express.json());
    upstream.post("/api/simulate/trigger-session", (req, res) => {
      expect(req.body).toEqual({ athleteId: "fixed", discipline: "bike" });
      expect(req.headers.authorization).toBeUndefined();
      res
        .set("Retry-After", "47")
        .status(429)
        .json({
          error: { code: "rate_limited", message: "Retry in 47 seconds." },
        });
    });
    const app = express();
    app.use(express.json());
    app.use(
      "/api/simulate",
      createSimulateRouter({
        streamingBackendBaseUrl: await serve(upstream),
        buildAuthHeaders: async () => ({}),
      }),
    );
    const response = await request(app)
      .post("/api/simulate/trigger-session")
      .send({ athleteId: "fixed", discipline: "bike" });
    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("47");
    expect(response.body.error.code).toBe("rate_limited");
    expect((await request(app).post("/api/simulate/seed-history").send({})).status).toBe(404);
  });

  it("retains live defaults and rejects unknown profile spelling", async () => {
    vi.stubEnv("DEMO_PROFILE", "live");
    vi.resetModules();
    const { app } = await import("../src/index.js");
    expect((await request(app).get("/api/demo/context")).status).toBe(404);
    expect((await request(app).get("/api/context")).body.directMcpPanelAvailable).toBe(true);
    vi.stubEnv("DEMO_PROFILE", "Synthetic");
    vi.resetModules();
    await expect(import("../src/index.js")).rejects.toThrow("DEMO_PROFILE");
  });
});
