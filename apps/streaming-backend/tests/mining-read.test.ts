import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  D01_CATALOG_VERSION,
  D01_PLANT_CATALOG,
  D01_PUBLISH_PROFILE_VERSION,
} from "@triathlon-twin/simulator/mining";
import { createMiningReadRouter } from "../src/api/mining-read.js";
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

function setup(principal: string | null = viewer) {
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
  const coordinator = new MiningRunCoordinator(store);
  const status = vi.fn((id: string) => coordinator.status(id));
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
    const status = vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          setTimeout(() => resolve(undefined), 10_100);
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
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      log.mockRestore();
    }
  }, 15_000);
});
