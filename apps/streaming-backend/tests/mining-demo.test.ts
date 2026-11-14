import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createMiningDemoRouter } from "../src/api/mining-demo.js";
import { MiningPublisherHost } from "../src/mining/publisher-host.js";
import { MiningRunCoordinator } from "../src/mining/run-coordinator.js";
import type { MiningStore, StoredDocument } from "../src/mining/store.js";

const principal = "11111111-1111-4111-8111-111111111111";
const tenant = "22222222-2222-4222-8222-222222222222";
const env = {
  MINING_PUBLIC_DEMO_ENABLED: "true",
  MINING_PUBLIC_DEMO_CALLER_PRINCIPAL_ID: principal,
  ASSISTANT_AUTH_TENANT_ID: tenant,
  ASSISTANT_AUTH_CLIENT_ID: "33333333-3333-4333-8333-333333333333",
};

function setup(configuration: NodeJS.ProcessEnv = env) {
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
    createMiningDemoRouter({ synthetic: false, env: configuration, store, host, verifyClaims }),
  );
  return { app, start, verifyClaims, documents, store };
}

describe("public mining demo service boundary", () => {
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
