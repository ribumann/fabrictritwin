import express from "express";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import request from "supertest";
import { WebSocket } from "ws";
import { createLiveSessionGenerator, createRaceDayGenerator } from "@triathlon-twin/simulator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSyntheticRouter } from "../src/api/synthetic.js";
import { attachStreamServer } from "../src/api/stream.js";
import { RealtimeStreamBroker } from "../src/services/realtime-stream.js";
import { SyntheticRuntime } from "../src/services/synthetic-runtime.js";
import { SYNTHETIC_ATHLETE_ID } from "../src/services/synthetic-insights.js";

function setup(options: ConstructorParameters<typeof SyntheticRuntime>[0] = {}) {
  const broker = new RealtimeStreamBroker();
  const runtime = new SyntheticRuntime({ ...options, broker });
  const app = express();
  app.use(express.json());
  app.use("/api", createSyntheticRouter(runtime));
  const server = createServer(app);
  const sockets = attachStreamServer(server, { broker, synthetic: true });
  server.on("close", () => runtime.close());
  return { runtime, app, server, sockets };
}

async function waitForTerminal(runtime: SyntheticRuntime) {
  for (let i = 0; i < 100; i++) {
    if (!runtime.status().activeRun) return;
    await delay(5);
  }
  throw new Error("Run did not reach a terminal state");
}

describe("synthetic API integration", () => {
  afterEach(() => vi.restoreAllMocks());

  it("binds anonymous reads to one deterministic context and ignores spoofed identity", async () => {
    const { app, runtime } = setup();
    const context = await request(app)
      .get("/api/demo/context")
      .set("x-ms-client-principal-id", "spoof");
    expect(context.status).toBe(200);
    expect(context.body).toMatchObject({
      selectedAthleteId: SYNTHETIC_ATHLETE_ID,
      selectedRaceId: runtime.race.raceId,
      directMcpPanelAvailable: false,
      provenance: { source: "synthetic" },
      runtime: { scope: "single-process", persistence: "memory" },
    });
    expect(context.body.history.length).toBeLessThanOrEqual(28);
    expect(context.body.history[0]).toMatchObject({
      date: expect.any(String),
      trainingLoad: expect.any(Number),
    });
    expect(context.body.runtime).toMatchObject({
      runId: null,
      status: "idle",
      kind: null,
      progressPct: 0,
      retryAfterSeconds: 0,
      summary: null,
      error: null,
    });
    expect((await request(app).get("/api/demo/context?athleteId=other")).status).toBe(403);
    expect(
      (
        await request(app)
          .get("/api/analyses/other")
          .set("x-ms-client-principal-id", SYNTHETIC_ATHLETE_ID)
      ).status,
    ).toBe(403);
    expect(
      (await request(app).get(`/api/analyses/${SYNTHETIC_ATHLETE_ID}`)).body.provenance.source,
    ).toBe("synthetic");
    expect(
      (await request(app).get(`/api/alerts/${SYNTHETIC_ATHLETE_ID}`)).body.provenance.source,
    ).toBe("synthetic");
    expect((await request(app).get("/api/race/other/live")).status).toBe(403);
    expect(
      (
        await request(app)
          .post("/api/simulate/seed-history")
          .send({ athleteId: SYNTHETIC_ATHLETE_ID })
      ).status,
    ).toBe(404);
    const assistant = await request(app)
      .post("/api/assistant/ask")
      .send({ athleteId: SYNTHETIC_ATHLETE_ID, question: "How am I?" });
    expect(assistant.body.answer).toContain("no LLM");
    expect(assistant.body.provenance.source).toBe("synthetic");
    expect((await request(app).post("/api/assistant/mcp").send({})).status).toBe(404);
    runtime.close();
  });

  it("enforces global concurrency and sliding rate limit, cancellation and restart", async () => {
    let now = Date.parse("2026-09-07T00:00:00Z");
    const { app, runtime } = setup({ now: () => now, intervalMs: 1000 });
    const payload = { athleteId: SYNTHETIC_ATHLETE_ID, discipline: "run" };
    expect(
      (
        await request(app)
          .post("/api/simulate/trigger-session")
          .send({ ...payload, athleteId: "other" })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post("/api/simulate/trigger-race")
          .send({ athleteId: SYNTHETIC_ATHLETE_ID, raceId: "other" })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post("/api/simulate/trigger-session")
          .send({ ...payload, discipline: "other" })
      ).status,
    ).toBe(400);
    const [a, b] = await Promise.all([
      request(app).post("/api/simulate/trigger-session").send(payload),
      request(app).post("/api/simulate/trigger-session").send(payload),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    const runId = (a.status === 202 ? a : b).body.runId;
    expect((await request(app).post("/api/simulate/cancel").send({ runId: "wrong" })).status).toBe(
      404,
    );
    expect((await request(app).post("/api/simulate/cancel").send({ runId })).body.run.status).toBe(
      "cancelled",
    );
    const second = await request(app)
      .post("/api/simulate/trigger-race")
      .send({ athleteId: SYNTHETIC_ATHLETE_ID, raceId: runtime.race.raceId });
    expect(second.status).toBe(202);
    await request(app).post("/api/simulate/cancel").send({ runId: second.body.runId });
    const limited = await request(app).post("/api/simulate/trigger-session").send(payload);
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    now += 60_000;
    expect((await request(app).post("/api/simulate/trigger-session").send(payload)).status).toBe(
      202,
    );
    runtime.close();
    expect(runtime.status().recentRuns[0]?.status).toBe("cancelled");
  });

  it("emits deterministic race and session telemetry and exposes a completed summary", async () => {
    const { app, runtime } = setup({ intervalMs: 1 });
    const race = await request(app)
      .post("/api/simulate/trigger-race")
      .send({ athleteId: SYNTHETIC_ATHLETE_ID, raceId: runtime.race.raceId });
    expect(race.status).toBe(202);
    await waitForTerminal(runtime);
    expect(runtime.status().recentRuns[0]?.status).toBe("completed");
    expect(runtime.status().summary).toMatchObject({ raceId: runtime.race.raceId });
    const summary = await request(app).get(`/api/race/${runtime.race.raceId}/summary`);
    expect(summary.body).toMatchObject({
      status: "completed",
      raceId: runtime.race.raceId,
      provenance: { source: "synthetic" },
    });
    expect(summary.body.actualFinishTimeSeconds).toBeGreaterThan(0);
    await request(app)
      .post("/api/simulate/trigger-session")
      .send({ athleteId: SYNTHETIC_ATHLETE_ID, discipline: "run" });
    await waitForTerminal(runtime);
    const session = await request(app).get("/api/demo/session");
    expect(session.body.session).toMatchObject({ status: "completed", source: "synthetic" });
    expect(session.body.metrics).toHaveLength(16);
    expect(runtime.status().summary).toMatchObject({
      session: { status: "completed", source: "synthetic" },
      sampleCount: 16,
      latestMetric: expect.any(Object),
    });
    const again = setup({ intervalMs: 1 });
    await request(again.app)
      .post("/api/simulate/trigger-session")
      .send({ athleteId: SYNTHETIC_ATHLETE_ID, discipline: "run" });
    await waitForTerminal(again.runtime);
    expect(again.runtime.session().metrics).toEqual(session.body.metrics);
    runtime.close();
    again.runtime.close();
  });

  it("reports generator failures and releases the active slot", async () => {
    const failing = vi.fn(() => {
      throw new Error("injected generator failure");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, runtime } = setup({ sessionGenerator: failing });
    await request(app)
      .post("/api/simulate/trigger-session")
      .send({ athleteId: SYNTHETIC_ATHLETE_ID, discipline: "run" });
    await waitForTerminal(runtime);
    expect(runtime.status().recentRuns[0]).toMatchObject({
      status: "failed",
      error: expect.any(String),
    });
    expect(runtime.status()).toMatchObject({
      status: "failed",
      error: expect.any(String),
      summary: null,
    });
    expect(
      (
        await request(app)
          .post("/api/simulate/trigger-race")
          .send({ athleteId: SYNTHETIC_ATHLETE_ID, raceId: runtime.race.raceId })
      ).status,
    ).toBe(202);
    runtime.close();
  });

  it("replaces old race and session summaries and bounds retained run data", async () => {
    let now = Date.parse("2026-09-07T00:00:00Z");
    let failRace = false;
    const raceGenerator: typeof createRaceDayGenerator = (options) => {
      if (failRace) throw new Error("injected race failure");
      return createRaceDayGenerator(options);
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, runtime } = setup({ now: () => now, intervalMs: 1, raceGenerator });
    const racePayload = { athleteId: SYNTHETIC_ATHLETE_ID, raceId: runtime.race.raceId };
    const sessionPayload = { athleteId: SYNTHETIC_ATHLETE_ID, discipline: "run" };
    const startRace = () => request(app).post("/api/simulate/trigger-race").send(racePayload);
    const startSession = () =>
      request(app).post("/api/simulate/trigger-session").send(sessionPayload);

    expect((await startRace()).status).toBe(202);
    await waitForTerminal(runtime);
    expect((await request(app).get(`/api/race/${runtime.race.raceId}/summary`)).status).toBe(200);
    const cancelled = await startRace();
    expect(cancelled.status).toBe(202);
    await request(app).post("/api/simulate/cancel").send({ runId: cancelled.body.runId });
    expect((await request(app).get(`/api/race/${runtime.race.raceId}/summary`)).status).toBe(404);
    expect(runtime.status().summary).toBeNull();

    now += 60_000;
    expect((await startRace()).status).toBe(202);
    await waitForTerminal(runtime);
    expect((await request(app).get(`/api/race/${runtime.race.raceId}/summary`)).status).toBe(200);
    failRace = true;
    expect((await startRace()).status).toBe(202);
    await waitForTerminal(runtime);
    expect(runtime.status().status).toBe("failed");
    expect((await request(app).get(`/api/race/${runtime.race.raceId}/summary`)).status).toBe(404);

    now += 60_000;
    expect((await startSession()).status).toBe(202);
    await waitForTerminal(runtime);
    expect(runtime.status().summary).toMatchObject({ sampleCount: 16 });
    const restarted = await startSession();
    expect(restarted.status).toBe(202);
    expect(runtime.status().summary).toBeNull();
    await request(app).post("/api/simulate/cancel").send({ runId: restarted.body.runId });
    expect(runtime.status().summary).toBeNull();

    for (let i = 0; i < 12; i++) {
      now += 60_000;
      const run = await startSession();
      expect(run.status).toBe(202);
      await request(app).post("/api/simulate/cancel").send({ runId: run.body.runId });
    }
    expect(runtime.status().recentRuns).toHaveLength(10);
    expect(runtime.session().metrics.length).toBeLessThanOrEqual(16);
    runtime.close();
  });

  it("accepts only fixed anonymous WebSocket subscriptions and delivers telemetry", async () => {
    const { app, runtime, server, sockets } = setup({ intervalMs: 5 });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    const base = `ws://127.0.0.1:${address.port}`;
    const wrong = new WebSocket(`${base}/api/stream/other`, {
      headers: { "x-ms-client-principal-id": SYNTHETIC_ATHLETE_ID },
    });
    const rejection = await new Promise<number>((resolve) =>
      wrong.on("unexpected-response", (_request, response) => resolve(response.statusCode!)),
    );
    expect(rejection).toBe(403);
    const ws = new WebSocket(`${base}/api/stream/${SYNTHETIC_ATHLETE_ID}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const message = new Promise<string>((resolve) =>
      ws.once("message", (data) => resolve(data.toString())),
    );
    await request(app)
      .post("/api/simulate/trigger-session")
      .send({ athleteId: SYNTHETIC_ATHLETE_ID, discipline: "run" });
    expect(JSON.parse(await message).type).toBe("metric");
    runtime.close();
    ws.terminate();
    sockets.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it.each(["cancelled", "failed"] as const)(
    "publishes missed session status and %s terminal status after telemetry",
    async (outcome) => {
      const generator: typeof createLiveSessionGenerator = function* (options) {
        const iterator = createLiveSessionGenerator(options);
        const first = iterator.next();
        if (!first.done) yield first.value;
        if (outcome === "failed") throw new Error("injected post-sample failure");
        yield* iterator;
      };
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { app, runtime, server, sockets } = setup({
        intervalMs: 100,
        sessionGenerator: generator,
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No port");
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/stream/${SYNTHETIC_ATHLETE_ID}`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      const frames: Array<Record<string, unknown>> = [];
      let resolveTerminal!: () => void;
      const terminal = new Promise<void>((resolve) => {
        resolveTerminal = resolve;
      });
      let resolveMetric!: () => void;
      const metric = new Promise<void>((resolve) => {
        resolveMetric = resolve;
      });
      ws.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        frames.push(frame);
        if (frame.type === "metric") resolveMetric();
        if (frame.type === "simulationStatus") resolveTerminal();
      });
      try {
        const started = await request(app)
          .post("/api/simulate/trigger-session")
          .send({ athleteId: SYNTHETIC_ATHLETE_ID, discipline: "run" });
        expect(started.status).toBe(202);
        await metric;
        if (outcome === "cancelled") {
          expect(
            (await request(app).post("/api/simulate/cancel").send({ runId: started.body.runId }))
              .status,
          ).toBe(200);
        }
        await terminal;
        expect(frames.map((frame) => frame.type)).toEqual([
          "metric",
          "sessionStatus",
          "simulationStatus",
        ]);
        expect(frames[1]).toMatchObject({
          type: "sessionStatus",
          sessionId: frames[0]!.sessionId,
          status: "missed",
        });
        expect(frames[2]).toMatchObject({
          type: "simulationStatus",
          runId: started.body.runId,
          status: outcome,
        });
        expect(runtime.session().session?.status).toBe("missed");
        expect(runtime.status().status).toBe(outcome);
      } finally {
        runtime.close();
        ws.terminate();
        sockets.close();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});
