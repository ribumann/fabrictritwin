import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createMiningDemoRouter } from "../src/api/mining-demo.js";
import { MiningPublisherHost } from "../src/mining/publisher-host.js";
import { MiningRunCoordinator } from "../src/mining/run-coordinator.js";
import type { MiningStore, StoredDocument } from "../src/mining/store.js";
import type { MiningAnswer } from "../src/mining/assistant.js";
import type { MiningCuratedProvider } from "../src/mining/read/curated-provider.js";

const principal = "11111111-1111-4111-8111-111111111111";
const tenant = "22222222-2222-4222-8222-222222222222";
const env = {
  MINING_PUBLIC_DEMO_ENABLED: "true",
  MINING_PUBLIC_DEMO_READ_ENABLED: "true",
  MINING_PUBLIC_DEMO_CALLER_PRINCIPAL_ID: principal,
  ASSISTANT_AUTH_TENANT_ID: tenant,
  ASSISTANT_AUTH_CLIENT_ID: "33333333-3333-4333-8333-333333333333",
  MINING_MANAGED_IDENTITY_CLIENT_ID: "55555555-5555-4555-8555-555555555555",
  IDENTITY_ENDPOINT: "http://127.0.0.1:8081/token",
  IDENTITY_HEADER: "test",
  MINING_EVENTHOUSE_QUERY_URI: "https://demo.kusto.fabric.microsoft.com",
  MINING_EVENTHOUSE_DATABASE_NAME: "mining",
  MINING_CURATED_SOURCE_VERSION: "d01-validated-source-v1",
  MINING_CURATED_QUERY_VERSION: "d01-g5-query-v1",
};

function setup(
  configuration: NodeJS.ProcessEnv = env,
  incidents?: { start(runId: string): Promise<void> },
  assistant?: { answer: MiningAnswer; curated: MiningCuratedProvider },
) {
  const documents = new Map<string, StoredDocument>();
  const leases = new Set<string>();
  const store: MiningStore = {
    read: async (path) => {
      const document = documents.get(path);
      return document ? { ...document, leased: leases.has(path) } : undefined;
    },
    create: async (path, value) => {
      if (documents.has(path)) return false;
      documents.set(path, { value, etag: "1", leased: false });
      return true;
    },
    write: async (path, value) => {
      documents.set(path, { value, etag: "2", leased: leases.has(path) });
      return "2";
    },
    acquire: async (path) => {
      if (leases.has(path)) return false;
      leases.add(path);
      return true;
    },
    renew: async () => {},
    release: async (path) => {
      leases.delete(path);
    },
  };
  const host = new MiningPublisherHost();
  const start = vi.spyOn(host, "start").mockImplementation((input) => {
    const status = {
      runId: input.requestId,
      admission: "accepted" as const,
      phase: "running" as const,
      stopRequested: false,
    };
    return {
      admission: Promise.resolve({ kind: "started", status }),
      completion: Promise.resolve(status),
    };
  });
  const verifyClaims = vi.fn(async () => ({
    oid: principal,
    tid: tenant,
    exp: Math.floor(Date.now() / 1000) + 3600,
    scp: undefined as string | undefined,
  }));
  const app = express();
  app.use(express.json());
  app.use(
    "/demo",
    createMiningDemoRouter({
      synthetic: false,
      env: configuration,
      store,
      host,
      verifyClaims,
      incidents,
      ...assistant,
    }),
  );
  return { app, start, verifyClaims, documents, store };
}

describe("public mining demo service boundary", () => {
  it("does not grant public callers generation-wide stop authority over a continuous record", async () => {
    const { app, store, documents } = setup();
    const runId = "44444444-4444-4444-8444-444444444444";
    const admission = await new MiningRunCoordinator(store).startContinuous({
      plantId: "D01",
      requestId: runId,
      generation: "release-1",
    });
    if (admission.kind !== "started") throw new Error("Missing owner.");
    await store.create(`public-demo/${runId}.json`, { version: 1, runId });
    const response = await request(app).post("/demo/runs/cancel").send({ plantId: "D01", runId });
    expect(response.status).toBe(403);
    expect(documents.has("continuous/holds/release-1.json")).toBe(false);
    expect(documents.has(`stops/${runId}.json`)).toBe(false);
    await admission.owner.finish("failed");
  });
  it("scopes assistant evidence to the admitted marked run and rejects caller-selected scope", async () => {
    const answer = vi.fn<MiningAnswer>().mockResolvedValue("The latest sample quality is stale.");
    const metric = {
      value: null,
      unit: "t/h",
      coverage: null,
      quality: "missing" as const,
      windowStart: "2026-01-01T11:00:00.000Z",
      windowEnd: "2026-01-01T11:05:00.000Z",
    };
    const curated = vi.fn<MiningCuratedProvider>().mockImplementation(async (input) => ({
      plantId: "D01",
      runId: input.run.runId,
      catalogVersion: "test",
      asOf: "2026-01-01T11:05:00.000Z",
      refreshedAt: "2026-01-01T11:06:00.000Z",
      quality: "stale",
      latest: { modules: [], readings: [] },
      summary: {
        throughput: metric,
        runningLines: metric,
        grossProcessWaterIntensity: metric,
        energyIntensity: metric,
      },
    }));
    const enabled = {
      ...env,
      MINING_PUBLIC_DEMO_ASSISTANT_ENABLED: "true",
      MINING_INGESTION_RECONCILIATION_ENABLED: "true",
      FOUNDRY_PROJECT_ENDPOINT: "https://example.services.ai.azure.com/api/projects/mining",
      ATHLETE_ASSISTANT_MODEL_DEPLOYMENT_NAME: "demo-model",
    };
    const { app, store } = setup(enabled, undefined, { answer, curated });
    const runId = "44444444-4444-4444-8444-444444444444";
    await new MiningRunCoordinator(store).start({
      plantId: "D01",
      requestId: runId,
      durationSeconds: 300,
    });
    const ask = () => request(app).post("/demo/assistant");
    const question = { plantId: "D01", question: "Is the latest evidence fresh?" };
    expect((await ask().send(question)).status).toBe(404);
    expect(answer).not.toHaveBeenCalled();
    await store.create(`public-demo/${runId}.json`, { version: 1, runId });
    for (const body of [
      { ...question, runId: "other" },
      { ...question, query: "print 1" },
      { ...question, question: "x".repeat(1001) },
      { ...question, question: " " },
    ]) {
      expect((await ask().send(body)).status).toBe(400);
    }
    const response = await ask().send(question);
    expect(response.status).toBe(200);
    expect(curated).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "overview", run: expect.objectContaining({ runId }) }),
      expect.any(AbortSignal),
    );
    expect(answer).toHaveBeenCalledWith(
      question.question,
      expect.stringContaining(runId),
      expect.any(AbortSignal),
    );
    expect(response.body).toMatchObject({
      runId,
      kind: "bounded-fabric-evidence",
      nativeDataAgentInvoked: false,
      evidence: { runId, quality: "stale" },
    });
    curated.mockRejectedValueOnce(new Error("Fabric offline"));
    expect((await ask().send(question)).status).toBe(503);
    expect(answer).toHaveBeenCalledTimes(1);
    const disabled = setup(env, undefined, { answer, curated });
    expect((await request(disabled.app).post("/demo/assistant").send(question)).status).toBe(503);
  });
  it.each(["publisher_complete", "running"] as const)(
    "activates reconciliation only after %s completion, never from a GET",
    async (phase) => {
      const incidents = { start: vi.fn(async () => {}) };
      const { app, start } = setup(env, incidents);
      start.mockImplementationOnce((input) => {
        const status = {
          runId: input.requestId,
          admission: "accepted" as const,
          phase: "running" as const,
          stopRequested: false,
        };
        return {
          admission: Promise.resolve({ kind: "started", status }),
          completion: Promise.resolve({ ...status, phase }),
        };
      });
      const response = await request(app).post("/demo/runs/start").send({ plantId: "D01" });
      expect(response.status).toBe(202);
      const calls = phase === "publisher_complete" ? 1 : 0;
      expect(incidents.start).toHaveBeenCalledTimes(calls);
      if (calls) expect(incidents.start).toHaveBeenCalledWith(response.body.runId);
      await request(app).get("/demo/incidents");
      expect(incidents.start).toHaveBeenCalledTimes(calls);
    },
  );
  it("is disabled by default and rejects callers other than the configured service", async () => {
    const disabled = setup({});
    expect(
      (await request(disabled.app).post("/demo/runs/start").send({ plantId: "D01" })).status,
    ).toBe(503);
    expect(disabled.verifyClaims).not.toHaveBeenCalled();
    const unauthorized = setup();
    unauthorized.verifyClaims.mockResolvedValueOnce({
      oid: "other",
      tid: tenant,
      exp: Math.floor(Date.now() / 1000) + 3600,
      scp: undefined,
    });
    expect(
      (await request(unauthorized.app).post("/demo/runs/start").send({ plantId: "D01" })).status,
    ).toBe(403);
    unauthorized.verifyClaims.mockResolvedValueOnce({
      oid: principal,
      tid: tenant,
      exp: Math.floor(Date.now() / 1000) + 3600,
      scp: "delegated.scope",
    });
    expect(
      (await request(unauthorized.app).post("/demo/runs/start").send({ plantId: "D01" })).status,
    ).toBe(403);
    expect(unauthorized.start).not.toHaveBeenCalled();
  });

  it("creates its own ID and starts only a five-minute D01 run", async () => {
    const { app, start, documents } = setup();
    for (const body of [{ plantId: "D01", durationSeconds: 1800 }, { plantId: "other" }, {}]) {
      expect((await request(app).post("/demo/runs/start").send(body)).status).toBe(400);
    }
    expect(start).not.toHaveBeenCalled();
    const result = await request(app).post("/demo/runs/start").send({ plantId: "D01" });
    expect(result.status).toBe(202);
    expect(result.body.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(start).toHaveBeenCalledWith(
      { plantId: "D01", requestId: result.body.runId, durationSeconds: 300 },
      expect.any(AbortSignal),
    );
    expect(documents.has(`public-demo/${result.body.runId}.json`)).toBe(true);
    expect(result.body.ingestionStatus).toBe("unknown");
  });

  it("does not cancel a run without a matching public-demo marker", async () => {
    const { app } = setup();
    const result = await request(app)
      .post("/demo/runs/cancel")
      .send({ plantId: "D01", runId: "44444444-4444-4444-8444-444444444444" });
    expect(result.status).toBe(404);
  });

  it("reports missing read configuration without disabling run status", async () => {
    const { app } = setup({ ...env, MINING_EVENTHOUSE_QUERY_URI: undefined });
    expect((await request(app).get("/demo/runs/status")).status).toBe(200);
    expect((await request(app).get("/demo/context")).status).toBe(503);
  });

  it("reports and stops an admitted demo run through durable coordination", async () => {
    const { app, start, store } = setup();
    const coordinator = new MiningRunCoordinator(store);
    start.mockImplementation((input) => {
      const admission = coordinator.start(input).then(async (result) => {
        if (result.kind !== "started") throw new Error("Expected a new run.");
        const status = await coordinator.status(input.requestId);
        if (!status) throw new Error("Admission not found.");
        return { kind: "started" as const, status };
      });
      return {
        admission,
        completion: admission.then((result) => result.status),
      };
    });
    const started = await request(app).post("/demo/runs/start").send({ plantId: "D01" });
    expect(started.status).toBe(202);
    const context = await request(app).get("/demo/context");
    expect(context.body).toMatchObject({
      plantId: "D01",
      readAvailable: true,
      approvedRun: { runId: started.body.runId },
    });
    expect(
      (await request(app).get("/demo/overview?runId=44444444-4444-4444-8444-444444444444")).status,
    ).toBe(403);
    const incidents = await request(app).get("/demo/incidents");
    expect(incidents.status).toBe(503);
    expect(incidents.body.error.code).toBe("mining_incidents_unavailable");
    const status = await request(app).get("/demo/runs/status");
    expect(status.body.run).toMatchObject({
      runId: started.body.runId,
      publisherStatus: "running",
      stopRequested: false,
    });
    const cancelled = await request(app)
      .post("/demo/runs/cancel")
      .send({ plantId: "D01", runId: started.body.runId });
    expect(cancelled.status).toBe(202);
    expect(cancelled.body).toMatchObject({ stopRequested: true, ingestionStatus: "unknown" });
  });
});
