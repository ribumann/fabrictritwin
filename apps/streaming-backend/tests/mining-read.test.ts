import express from "express";
import { createServer, get } from "node:http";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  D01_CATALOG_VERSION,
  D01_PLANT_CATALOG,
  D01_PUBLISH_PROFILE_VERSION,
} from "@triathlon-twin/simulator/mining";
import { createMiningReadRouter } from "../src/api/mining-read.js";
import { resetMcpCallerJwksCacheForTests } from "../src/auth/mcp-caller.js";
import { MiningRunCoordinator } from "../src/mining/run-coordinator.js";
import {
  MiningCoordinationError,
  type MiningStore,
  type StoredDocument,
} from "../src/mining/store.js";

const runId = "11111111-1111-4111-8111-111111111111";
const otherRun = "22222222-2222-4222-8222-222222222222";
const viewer = "33333333-3333-4333-8333-333333333333";
const now = Date.parse("2026-01-01T12:00:00.000Z");
const env = {
  MINING_READ_ENABLED: "true",
  MINING_VIEWER_PRINCIPAL_IDS: viewer,
  MINING_APPROVED_RUN_ID: runId,
  MINING_APPROVED_CATALOG_VERSION: D01_CATALOG_VERSION,
  MINING_APPROVED_PROFILE_VERSION: D01_PUBLISH_PROFILE_VERSION,
  ASSISTANT_AUTH_TENANT_ID: "tenant",
  ASSISTANT_AUTH_CLIENT_ID: "client",
};
const spec = { plantId: "D01", runId, durationSeconds: 1200, scenario: "normal", seed: 1 };

function setup(principal: string | null = viewer, clockNow: () => number = () => now) {
  const documents = new Map<string, StoredDocument>([
    [
      `requests/${runId}.json`,
      { value: { spec, admission: "accepted" }, etag: "1", leased: false },
    ],
    [
      `history/${runId}.json`,
      {
        value: {
          ...spec,
          phase: "publisher_complete",
          startedAt: "2026-01-01T11:00:00.000Z",
          stopAt: "2026-01-01T11:20:00.000Z",
          authorityUntil: "2026-01-01T11:00:45.000Z",
        },
        etag: "2",
        leased: false,
      },
    ],
  ]);
  const read = vi.fn(async (path: string) => documents.get(path));
  const mutate = vi.fn(() => {
    throw new Error("read endpoint attempted a write");
  });
  const store: MiningStore = {
    read,
    create: mutate,
    write: mutate,
    acquire: mutate,
    renew: mutate,
    release: mutate,
  };
  const coordinator = new MiningRunCoordinator(store, { now: clockNow, monotonic: () => 0 });
  const status = vi.fn((id: string, signal?: AbortSignal) => coordinator.status(id, signal));
  const app = express();
  app.use(
    "/api/mining",
    createMiningReadRouter({
      synthetic: false,
      env,
      verifyPrincipal: async () => principal ?? undefined,
      status,
      now: () => now,
    }),
  );
  return { app, documents, read, mutate, status };
}

describe("approved mining read boundary", () => {
  it("verifies the bearer signature and audience at the actual HTTP boundary", async () => {
    const tenant = "44444444-4444-4444-8444-444444444444";
    const client = "55555555-5555-4555-8555-555555555555";
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    vi.stubEnv("ASSISTANT_AUTH_TENANT_ID", tenant);
    vi.stubEnv("ASSISTANT_AUTH_CLIENT_ID", client);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              keys: [{ ...publicJwk, kid: "mining-test", alg: "RS256", use: "sig" }],
            }),
            { headers: { "content-type": "application/json" } },
          ),
      ),
    );
    resetMcpCallerJwksCacheForTests();
    const status = vi.fn(async () => ({
      runId,
      admission: "accepted" as const,
      phase: "publisher_complete" as const,
      stopRequested: false,
    }));
    const app = express();
    app.use(
      "/api/mining",
      createMiningReadRouter({
        synthetic: false,
        env: { ...env, ASSISTANT_AUTH_TENANT_ID: tenant, ASSISTANT_AUTH_CLIENT_ID: client },
        status,
      }),
    );
    const sign = (audience: string) =>
      new SignJWT({ oid: viewer })
        .setProtectedHeader({ alg: "RS256", kid: "mining-test" })
        .setIssuer(`https://login.microsoftonline.com/${tenant}/v2.0`)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey);
    try {
      const bad = await request(app)
        .get("/api/mining/runs/status")
        .set("authorization", `Bearer ${await sign("wrong")}`);
      expect(bad.status).toBe(401);
      expect(status).not.toHaveBeenCalled();
      const good = await request(app)
        .get("/api/mining/runs/status")
        .set("authorization", `Bearer ${await sign(client)}`);
      expect(good.status).toBe(200);
      expect(good.body.ingestionStatus).toBe("unknown");
      expect(status).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      resetMcpCallerJwksCacheForTests();
    }
  });

  it("rejects unverified and unapproved viewers before reading durable state", async () => {
    for (const [principal, expected] of [
      [null, 401],
      [otherRun, 403],
    ] as const) {
      const { app, read } = setup(principal);
      const response = await request(app)
        .get("/api/mining/runs/status")
        .set("x-ms-client-principal-id", viewer);
      expect(response.status).toBe(expected);
      expect(read).not.toHaveBeenCalled();
    }
    const app = express();
    const status = vi.fn();
    app.use("/api/mining", createMiningReadRouter({ synthetic: false, env, status }));
    expect(
      (await request(app).get("/api/mining/runs/status").set("x-ms-client-principal-id", viewer))
        .status,
    ).toBe(401);
    expect(status).not.toHaveBeenCalled();
  });

  it("reports identity-provider failures without reading durable state", async () => {
    const tenant = "44444444-4444-4444-8444-444444444444";
    const client = "55555555-5555-4555-8555-555555555555";
    const { privateKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({ oid: viewer })
      .setProtectedHeader({ alg: "RS256", kid: "mining-test" })
      .setIssuer(`https://login.microsoftonline.com/${tenant}/v2.0`)
      .setAudience(client)
      .setExpirationTime("1h")
      .sign(privateKey);
    vi.stubEnv("ASSISTANT_AUTH_TENANT_ID", tenant);
    vi.stubEnv("ASSISTANT_AUTH_CLIENT_ID", client);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("identity provider unavailable")));
    resetMcpCallerJwksCacheForTests();
    const status = vi.fn();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = express();
    app.use(
      "/api/mining",
      createMiningReadRouter({
        synthetic: false,
        env: { ...env, ASSISTANT_AUTH_TENANT_ID: tenant, ASSISTANT_AUTH_CLIENT_ID: client },
        status,
      }),
    );
    try {
      const response = await request(app)
        .get("/api/mining/runs/status")
        .set("authorization", `Bearer ${token}`);
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe("mining_authentication_unavailable");
      expect(status).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      resetMcpCallerJwksCacheForTests();
    }
  });

  it("rejects unapproved and malformed run IDs before any state reads", async () => {
    const { app, read } = setup();
    expect(
      (await request(app).get("/api/mining/runs/status").query({ runId: otherRun })).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get("/api/mining/runs/status")
          .query({ runId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" })
      ).status,
    ).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });

  it("exposes persisted sender completion without claiming ingestion proof or mutating state", async () => {
    const { app, mutate } = setup();
    const response = await request(app).get("/api/mining/runs/status");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      plantId: "D01",
      runId,
      catalogVersion: D01_CATALOG_VERSION,
      publisherStatus: "publisher_complete",
      ingestionStatus: "unknown",
    });
    const context = await request(app).get("/api/mining/context");
    expect(context.body).toEqual({
      plantId: "D01",
      approvedRun: response.body,
      catalogVersion: D01_CATALOG_VERSION,
      readAvailable: false,
      unavailableReason:
        "Validated curated mining queries and persisted incidents are not connected.",
      assistant: { available: false },
    });
    expect(mutate).not.toHaveBeenCalled();
    expect(context.headers["cache-control"]).toBe("no-store");
  });

  it("reports an opted-in final drain as running only until its durable deadline", async () => {
    let current = now;
    const { app, documents, mutate } = setup(viewer, () => current);
    documents.delete(`history/${runId}.json`);
    documents.set("plants/D01.json", {
      value: {
        version: 1,
        run: {
          ...spec,
          phase: "running",
          startedAt: "2026-01-01T11:39:59.000Z",
          stopAt: "2026-01-01T11:59:59.000Z",
          finalFlushUntil: "2026-01-01T12:00:04.000Z",
          authorityUntil: "2026-01-01T12:00:30.000Z",
        },
      },
      etag: "2",
      leased: true,
    });
    const duringDrain = await request(app).get("/api/mining/runs/status");
    expect(duringDrain.body).toMatchObject({
      publisherStatus: "running",
      ingestionStatus: "unknown",
    });
    current += 4_000;
    const expired = await request(app).get("/api/mining/runs/status");
    expect(expired.body).toMatchObject({
      publisherStatus: "interrupted",
      ingestionStatus: "unknown",
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("fails closed for missing, mismatched and malformed durable admissions", async () => {
    const { app, documents } = setup();
    documents.delete(`requests/${runId}.json`);
    expect((await request(app).get("/api/mining/runs/status")).status).toBe(404);
    documents.set(`requests/${runId}.json`, {
      value: { spec: { ...spec, runId: otherRun }, admission: "accepted" },
      etag: "3",
      leased: false,
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await request(app).get("/api/mining/runs/status");
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe("mining_status_invalid");
    } finally {
      log.mockRestore();
    }
  });

  it("preserves pending admission and distinguishes a durable storage failure", async () => {
    const { app, documents, status } = setup();
    documents.set(`requests/${runId}.json`, {
      value: { spec, admission: "pending" },
      etag: "3",
      leased: false,
    });

    expect((await request(app).get("/api/mining/runs/status")).body).toMatchObject({
      publisherStatus: "admission_pending",
      ingestionStatus: "unknown",
    });
    status.mockRejectedValueOnce(new MiningCoordinationError("storage", "storage unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await request(app).get("/api/mining/runs/status");
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe("mining_status_storage");
    } finally {
      log.mockRestore();
    }
  });

  it("reports rejected durable admissions distinctly from missing runs", async () => {
    const { app, documents, mutate } = setup();
    documents.set(`requests/${runId}.json`, {
      value: { spec, admission: "rejected" },
      etag: "1",
      leased: false,
    });
    for (const route of ["context", "runs/status"]) {
      const response = await request(app).get(`/api/mining/${route}`);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("mining_admission_rejected");
    }
    expect(mutate).not.toHaveBeenCalled();
  });

  it("validates windows, module IDs, fields and row bounds without reading or querying", async () => {
    const { app, read } = setup();
    const valid = {
      start: "2026-01-01T11:00:00.000Z",
      end: "2026-01-01T12:00:00.000Z",
      moduleId: D01_PLANT_CATALOG.modules[0].id,
      metric: "feed",
      binMinutes: "1",
      maxRows: "1000",
    };
    for (const query of [
      { ...valid, maxRows: "1001" },
      { ...valid, end: "2026-01-01T12:00:01.000Z" },
      { ...valid, start: "2025-12-30T12:00:00.000Z" },
      { ...valid, start: "2026-02-30T00:00:00.000Z" },
      { ...valid, moduleId: "D01.unknown" },
      { ...valid, plantId: "" },
      { ...valid, table: "anything" },
      { ...valid, metric: "other" },
      { ...valid, binMinutes: "2" },
    ])
      expect((await request(app).get("/api/mining/trends").query(query)).status).toBe(400);
    const unavailable = await request(app).get("/api/mining/trends").query(valid);
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.error.code).toBe("mining_curated_source_unavailable");
    const unsupported = await request(app).get("/api/mining/compare-lines").query({
      start: valid.start,
      end: valid.end,
      metric: "water-energy",
      binMinutes: "1",
      maxRows: "1000",
    });
    expect(unsupported.status).toBe(400);
    expect(unsupported.body.error.message).toContain("not supported");
    expect(read).not.toHaveBeenCalled();
  });

  it("never substitutes synthetic data or forwards action requests", async () => {
    const app = express();
    app.use("/api/mining", createMiningReadRouter({ synthetic: true, env }));
    expect((await request(app).get("/api/mining/context")).status).toBe(503);
    const action = await request(app).post("/api/mining/runs/start");
    expect(action.status).toBe(503);
    expect(action.body.error.code).toBe("mining_delegated_boundary_required");
  });

  it("fails closed when the independently approved versions are missing or mismatched", async () => {
    const app = express();
    const status = vi.fn();
    app.use(
      "/api/mining",
      createMiningReadRouter({
        synthetic: false,
        env: { ...env, MINING_APPROVED_PROFILE_VERSION: "another-profile" },
        verifyPrincipal: async () => viewer,
        status,
      }),
    );
    const response = await request(app).get("/api/mining/runs/status");
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("mining_read_configuration");
    expect(status).not.toHaveBeenCalled();
  });

  it("returns an explicit deadline error instead of late status success", async () => {
    const app = express();
    let aborted = false;
    const status = vi.fn(
      (_runId: string, signal?: AbortSignal) =>
        new Promise<undefined>((_, reject) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("cancelled"));
          });
        }),
    );
    app.use(
      "/api/mining",
      createMiningReadRouter({
        synthetic: false,
        env,
        verifyPrincipal: async () => viewer,
        status,
      }),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const start = Date.now();
      const response = await request(app).get("/api/mining/runs/status");
      expect(Date.now() - start).toBeLessThan(10_500);
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe("mining_read_timeout");
      expect(aborted).toBe(true);
    } finally {
      log.mockRestore();
    }
  }, 15_000);

  it("cancels the status operation when the client disconnects", async () => {
    let started: (() => void) | undefined;
    let cancelled: (() => void) | undefined;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const stopped = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const status = vi.fn(
      (_runId: string, signal?: AbortSignal) =>
        new Promise<undefined>((_, reject) => {
          signal?.addEventListener("abort", () => {
            cancelled?.();
            reject(new Error("cancelled"));
          });
          started?.();
        }),
    );
    const app = express();
    app.use(
      "/api/mining",
      createMiningReadRouter({
        synthetic: false,
        env,
        verifyPrincipal: async () => viewer,
        status,
      }),
    );
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address.");
    const client = get(`http://127.0.0.1:${address.port}/api/mining/runs/status`);
    client.on("error", () => {});
    try {
      await reading;
      client.destroy();
      await stopped;
      expect(status).toHaveBeenCalledOnce();
    } finally {
      client.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("cancels an in-flight identity provider fetch on disconnect before status reads", async () => {
    const tenant = "44444444-4444-4444-8444-444444444444";
    const clientId = "55555555-5555-4555-8555-555555555555";
    const { privateKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({ oid: viewer })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(`https://login.microsoftonline.com/${tenant}/v2.0`)
      .setAudience(clientId)
      .setExpirationTime("1h")
      .sign(privateKey);
    vi.stubEnv("ASSISTANT_AUTH_TENANT_ID", tenant);
    vi.stubEnv("ASSISTANT_AUTH_CLIENT_ID", clientId);
    resetMcpCallerJwksCacheForTests();
    let started: (() => void) | undefined;
    let cancelled: (() => void) | undefined;
    const fetching = new Promise<void>((resolve) => {
      started = resolve;
    });
    const stopped = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const provider = createServer((_req, res) => {
      res.on("close", () => cancelled?.());
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"keys":[');
      started?.();
    });
    provider.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => provider.once("listening", resolve));
    const providerAddress = provider.address();
    if (!providerAddress || typeof providerAddress === "string") {
      throw new Error("Missing test identity provider address.");
    }
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, options: RequestInit) =>
        realFetch(`http://127.0.0.1:${providerAddress.port}/keys`, options),
      ),
    );
    const status = vi.fn();
    const app = express();
    app.use(
      "/api/mining",
      createMiningReadRouter({
        synthetic: false,
        env: { ...env, ASSISTANT_AUTH_TENANT_ID: tenant, ASSISTANT_AUTH_CLIENT_ID: clientId },
        status,
      }),
    );
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address.");
    const client = get(`http://127.0.0.1:${address.port}/api/mining/runs/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    client.on("error", () => {});
    try {
      await fetching;
      client.destroy();
      await stopped;
      expect(status).not.toHaveBeenCalled();
    } finally {
      client.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await new Promise<void>((resolve, reject) =>
        provider.close((error) => (error ? reject(error) : resolve())),
      );
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      resetMcpCallerJwksCacheForTests();
    }
  });
});
