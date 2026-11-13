import { createHash } from "node:crypto";
import { get } from "node:http";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  D01_CATALOG_VERSION,
  D01_PLANT_CATALOG,
  D01_PUBLISH_PROFILE_VERSION,
} from "@triathlon-twin/simulator/mining";
import { createMiningReadRouter } from "../src/api/mining-read.js";
import {
  createD01RunContract,
  createD01VersionedIncidentRun,
} from "../src/mining-incidents/catalog.js";
import type { MiningRunRecord } from "../src/mining/run-coordinator.js";
import { createBoundedMiningQuery } from "../src/mining/read/bounded-query.js";
import { createMiningCuratedProvider } from "../src/mining/read/curated-provider.js";
import type { MiningProofReceipt } from "../src/mining/read/receipt-schema.js";

const id = "11111111-1111-4111-8111-111111111111";
const viewer = "22222222-2222-4222-8222-222222222222";
const hash = "a".repeat(64);
const asOf = "2026-01-01T11:05:00.000Z";
const endpoint = "https://test.kusto.fabric.microsoft.com";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function proof(): MiningProofReceipt {
  const canary = {
    expectedDistinctEventIds: 1,
    observedDistinctEventIds: 1,
    observedCopies: 1,
    exactLexemeCopies: 1,
    rawIngestionNonNullCopies: 1,
    wrongDestinationCopies: 0,
  };
  const classifier = {
    rawCopies: 1,
    classifierRows: 1,
    acceptedRows: 1,
    receivedAtMatchRows: 1,
    blockedRows: 0,
    quarantinedRows: 0,
    deduplicatedRows: 1,
    deduplicatedCopies: 1,
    dedupConflictRows: 0,
    dedupReceivedAtMatchRows: 1,
  };
  return {
    schemaVersion: 1,
    receiptId: id,
    issuedAtUtc: "2026-01-01T00:00:03Z",
    authorizedRunId: id,
    issuer: { tenantId: id, principalObjectId: id, collectorCommitSha: "b".repeat(40) },
    target: {
      cloud: "AzurePublic",
      environment: "test",
      tenantId: id,
      subscriptionId: id,
      workspaceId: id,
      eventstreamId: id,
      eventhouseWorkspaceId: id,
      kqlDatabaseId: id,
      endpoint,
      databaseName: "database",
    },
    identity: {
      plantId: "D01",
      catalogVersion: D01_CATALOG_VERSION,
      profileVersion: D01_PUBLISH_PROFILE_VERSION,
      sourceContractVersion: "d01-validated-source-v1",
      sourceCommitSha: "b".repeat(40),
      sourceFilesSha256: { MiningSchema: hash, MiningValidation: hash, MiningQueries: hash },
      querySetSha256: hash,
    },
    deploymentObservation: {
      observedAtUtc: "2026-01-01T00:00:00Z",
      eventstreamNativeDefinitionSha256: hash,
      eventhouseNativeDefinitionSetSha256: hash,
    },
    canaryObservation: {
      observedAtUtc: "2026-01-01T00:00:01Z",
      fixtureSha256: hash,
      runId: id,
      telemetry: { ...canary },
      state: { ...canary },
    },
    classifierObservation: {
      observedAtUtc: "2026-01-01T00:00:01Z",
      sourceReadinessStatus: "READY",
      telemetry: { ...classifier },
      state: { ...classifier },
    },
    semanticObservation: {
      observedAtUtc: "2026-01-01T00:00:02Z",
      fixtureSha256: hash,
      querySetSha256: hash,
      contracts: (
        [
          "mining_PlantLatest",
          "mining_PlantSummary",
          "mining_AssetTrend",
          "mining_ActiveIncidents",
          "mining_CompareLines",
        ] as const
      ).map((functionName) => ({
        functionName,
        assertionCount: 1,
        observedAssertionCount: 1,
        mismatchCount: 0,
        resultRowCount: 1,
        outputSha256: hash,
      })),
    },
  };
}

function setup(principal = viewer) {
  const receipt = proof();
  let bytes = Buffer.from(canonical(receipt));
  const run: MiningRunRecord = {
    plantId: "D01",
    runId: id,
    durationSeconds: 1200,
    scenario: "normal",
    seed: 1,
    startedAt: "2026-01-01T11:00:00.000Z",
    stopAt: "2026-01-01T11:20:00.000Z",
    authorityUntil: asOf,
    phase: "running",
    contract: createD01RunContract(),
  };
  const binding = createD01VersionedIncidentRun({ ...run, contract: run.contract! });
  const page = {
    schema: 2,
    binding: digest(binding),
    previous: null,
    commands: [{ kind: "evaluate", asOf: run.startedAt }],
  };
  const path = `incidents/D01/${digest(id)}/`;
  const documents = new Map<string, unknown>([
    [
      `${path}head.json`,
      {
        schema: 2,
        binding: digest(binding),
        tail: digest(page),
        pages: 1,
        bytes: Buffer.byteLength(JSON.stringify(page)),
      },
    ],
    [`${path}${digest(page)}.json`, page],
  ]);
  const read = vi.fn(async (key: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const value = documents.get(key);
    return value === undefined
      ? undefined
      : { value: structuredClone(value), etag: "1", leased: false };
  });
  const readBytes = vi.fn(async (_key: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    return { bytes, etag: "proof", leased: false };
  });
  const verifyNative = vi.fn(async (_receipt: MiningProofReceipt, signal: AbortSignal) => {
    signal.throwIfAborted();
  });
  const query = vi.fn<ReturnType<typeof createBoundedMiningQuery>>(async (input, signal) => {
    signal?.throwIfAborted();
    if (input.kind === "latest") {
      const common = { plant_id: "D01", run_id: id, as_of_utc: input.asOf };
      return [
        ...D01_PLANT_CATALOG.telemetry_tags.map((tag) => ({
          ...common,
          row_kind: "tag",
          status: "UNKNOWN_NO_OBSERVATION",
          tagId: tag.id,
          seriesId: tag.id,
          module_id: tag.module_id,
          equipment_id: tag.equipment_id,
          metric: tag.metric,
          unit: tag.unit,
          value: null,
          quality: "",
          event_time: null,
          received_at: null,
          age_seconds: null,
        })),
        ...["A", "B", "C", "shared"].map((scope_id) => ({
          ...common,
          row_kind: "state",
          status: "UNKNOWN_NO_STATE",
          scope_id,
          event_time: null,
          received_at: null,
          age_seconds: null,
          state: "",
          scheduled_running: null,
        })),
      ];
    }
    if (input.kind === "summary") {
      const empty = Object.fromEntries(
        [
          "good_sample_count",
          "non_good_sample_count",
          "uncertain_sample_count",
          "bad_sample_count",
          "late_sample_count",
          "feed_coverage",
          "water_coverage",
          "power_coverage",
          "common_coverage",
          "line_a_feed_tph",
          "line_b_feed_tph",
          "line_c_feed_tph",
          "plant_feed_tph",
          "processed_tonnes",
          "gross_process_water_m3_per_t",
          "whole_plant_energy_kwh_per_t",
          "running_lines",
          "first_event_time",
          "last_event_time",
          "first_received_at",
          "last_received_at",
        ].map((key) => [key, null]),
      );
      return [
        {
          ...empty,
          status: "NO_DATA",
          plant_id: "D01",
          run_id: id,
          window_start_utc: input.start,
          window_end_utc: input.end,
          conflicting_event_count: 0,
        },
      ];
    }
    return [];
  });
  const env = {
    MINING_READ_ENABLED: "true",
    MINING_VIEWER_PRINCIPAL_IDS: viewer,
    MINING_APPROVED_RUN_ID: id,
    MINING_APPROVED_CATALOG_VERSION: D01_CATALOG_VERSION,
    MINING_APPROVED_PROFILE_VERSION: D01_PUBLISH_PROFILE_VERSION,
    ASSISTANT_AUTH_TENANT_ID: id,
    ASSISTANT_AUTH_CLIENT_ID: viewer,
    EVENTHOUSE_QUERY_URI: endpoint,
    MINING_EVENTHOUSE_QUERY_URI: endpoint,
    EVENTHOUSE_DATABASE_NAME: "database",
    MINING_EVENTHOUSE_DATABASE_NAME: "database",
    MINING_CURATED_SOURCE_VERSION: "d01-validated-source-v1",
    MINING_CURATED_QUERY_VERSION: "d01-g5-query-v1",
    MINING_MANAGED_IDENTITY_CLIENT_ID: id,
    IDENTITY_ENDPOINT: "http://127.0.0.1:8081/token",
    IDENTITY_HEADER: "test-only",
  };
  const expectations = {
    authorizedRunId: id,
    canaryRunId: id,
    target: structuredClone(receipt.target),
    identity: structuredClone(receipt.identity),
    canaryFixtureSha256: hash,
    semanticFixtureSha256: hash,
    semanticContracts: structuredClone(receipt.semanticObservation.contracts),
  };
  const dependencies = {
    store: { read, readBytes },
    expectations,
    verifyNative,
    query,
    receiptPin: createHash("sha256").update(bytes).digest("hex"),
    env,
    now: () => Date.parse(asOf),
  };
  const curated = createMiningCuratedProvider(dependencies);
  const status = vi.fn<NonNullable<Parameters<typeof createMiningReadRouter>[0]["status"]>>(
    async () => ({
      runId: id,
      admission: "accepted" as const,
      phase: "running" as const,
      stopRequested: false,
      run,
    }),
  );
  const app = express();
  app.use(
    "/api/mining",
    createMiningReadRouter({
      synthetic: false,
      env,
      verifyPrincipal: async () => principal,
      status,
      curated,
      now: () => Date.parse(asOf),
    }),
  );
  return {
    app,
    curated,
    run,
    dependencies,
    documents,
    read,
    readBytes,
    verifyNative,
    query,
    status,
    tamper: () => {
      bytes = Buffer.from("{}");
    },
  };
}

describe("explicit curated read composition", () => {
  it("maps real persisted incident replay plus latest/summary contracts at the HTTP boundary", async () => {
    const { app, query, verifyNative, documents } = setup();
    const before = structuredClone(documents);
    const context = await request(app).get("/api/mining/context");
    expect(context.status).toBe(200);
    expect(context.body.readAvailable).toBe(true);
    expect(context.body.approvedRun.ingestionStatus).toBe("unknown");
    const overview = await request(app).get("/api/mining/overview").query({ asOf });
    expect(overview.status).toBe(200);
    expect(overview.body).toMatchObject({
      plantId: "D01",
      runId: id,
      asOf,
      quality: "missing",
      run: { ingestionStatus: "unknown" },
      summary: {
        throughput: {
          value: null,
          quality: "missing",
          windowStart: "2026-01-01T11:00:00.000Z",
          windowEnd: asOf,
        },
      },
    });
    expect(overview.body.latest.readings).toHaveLength(56);
    expect(
      overview.body.latest.modules.every((item: { status: string }) => item.status === "unknown"),
    ).toBe(true);
    const incidents = await request(app).get("/api/mining/incidents").query({ asOf });
    expect(incidents.status).toBe(200);
    expect(incidents.body).toMatchObject({
      runId: id,
      asOf: "2026-01-01T11:00:00.000Z",
      incidents: [],
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(verifyNative).toHaveBeenCalledTimes(3);
    expect(documents).toEqual(before);
  });

  it("rejects foreign viewers, runs and invalid queries before proof, native or data reads", async () => {
    const denied = setup(id);
    expect((await request(denied.app).get("/api/mining/overview")).status).toBe(403);
    expect(denied.status).not.toHaveBeenCalled();
    expect(denied.readBytes).not.toHaveBeenCalled();
    const valid = setup();
    expect(
      (await request(valid.app).get("/api/mining/overview").query({ runId: viewer })).status,
    ).toBe(403);
    expect(
      (await request(valid.app).get("/api/mining/overview").query({ asOf: "invalid" })).status,
    ).toBe(400);
    expect(valid.readBytes).not.toHaveBeenCalled();
    expect(valid.verifyNative).not.toHaveBeenCalled();
    expect(valid.query).not.toHaveBeenCalled();
  });

  it("requires the byte pin, independent expectations, native verification and current journal separately", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const tampered = setup();
      tampered.tamper();
      expect((await request(tampered.app).get("/api/mining/overview")).status).toBe(503);
      expect(tampered.verifyNative).not.toHaveBeenCalled();
      expect(tampered.query).not.toHaveBeenCalled();
      const mismatch = setup();
      const wrong = createMiningCuratedProvider({
        ...mismatch.dependencies,
        expectations: {
          ...mismatch.dependencies.expectations,
          semanticFixtureSha256: "f".repeat(64),
        },
      });

      await expect(
        wrong({ kind: "context", run: mismatch.run }, new AbortController().signal),
      ).rejects.toThrow("approved");
      expect(mismatch.verifyNative).not.toHaveBeenCalled();
      const unavailable = setup();
      unavailable.verifyNative.mockRejectedValueOnce(new Error("Native deployment drift."));
      expect((await request(unavailable.app).get("/api/mining/context")).status).toBe(503);
      expect(unavailable.read).not.toHaveBeenCalled();
      expect(unavailable.query).not.toHaveBeenCalled();
      const noJournal = setup();
      noJournal.documents.clear();
      expect((await request(noJournal.app).get("/api/mining/overview")).status).toBe(503);
      expect(noJournal.query).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("does not query pending admissions or accepted records without durable run bounds", async () => {
    const test = setup();
    for (const admission of ["pending", "accepted"] as const) {
      test.status.mockResolvedValueOnce({
        runId: id,
        admission,
        phase: "admission_unknown",
        stopRequested: false,
      });
      const response = await request(test.app).get("/api/mining/overview");
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe("mining_admission_unavailable");
    }
    expect(test.readBytes).not.toHaveBeenCalled();
    expect(test.verifyNative).not.toHaveBeenCalled();
    expect(test.query).not.toHaveBeenCalled();
  });

  it("rejects unsupported transport configuration before downloading proof", async () => {
    const test = setup();
    const read = createMiningCuratedProvider({
      ...test.dependencies,
      env: { ...test.dependencies.env, IDENTITY_ENDPOINT: "https://remote.invalid" },
    });
    await expect(
      read({ kind: "context", run: test.run }, new AbortController().signal),
    ).rejects.toThrow("loopback");
    expect(test.readBytes).not.toHaveBeenCalled();
  });

  it("does not turn malformed source rows or historical incident requests into a success", async () => {
    const { app, query } = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      query.mockResolvedValueOnce([]);
      expect((await request(app).get("/api/mining/overview")).status).toBe(503);
      expect(
        (await request(app).get("/api/mining/incidents").query({ asOf: "2026-01-01T10:59:00Z" }))
          .status,
      ).toBe(503);
    } finally {
      log.mockRestore();
    }
  });

  it("forwards normalized bounded series requests only after every gate", async () => {
    const { app, query } = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const window = {
      start: "2026-01-01T11:00:00Z",
      end: asOf,
      metric: "feed",
      binMinutes: "1",
      maxRows: "1000",
    };
    try {
      for (const [route, kind] of [
        ["trends", "trend"],
        ["compare-lines", "compare"],
      ]) {
        const response = await request(app)
          .get(`/api/mining/${route}`)
          .query({
            ...window,
            ...(kind === "trend" ? { moduleId: D01_PLANT_CATALOG.modules[0].id } : {}),
          });
        expect(response.status).toBe(503);
        expect(query).toHaveBeenLastCalledWith(
          expect.objectContaining({
            kind,
            runId: id,
            start: "2026-01-01T11:00:00.000Z",
            end: asOf,
            metric: "feed",
            binMinutes: 1,
            maxRows: 1000,
          }),
          expect.any(AbortSignal),
        );
      }
    } finally {
      log.mockRestore();
    }
  });

  it("cancels native verification on disconnect without starting journal or query reads", async () => {
    const test = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let started!: () => void;
    let aborted!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cancelled = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    test.verifyNative.mockImplementationOnce(
      async (_receipt, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted();
              reject(new Error("cancelled"));
            },
            { once: true },
          );
          started();
        }),
    );
    const server = test.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test address.");
    const client = get(`http://127.0.0.1:${address.port}/api/mining/overview`);
    client.on("error", () => {});
    try {
      await reading;
      client.destroy();
      await cancelled;
      expect(test.read).not.toHaveBeenCalled();
      expect(test.query).not.toHaveBeenCalled();
    } finally {
      client.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      log.mockRestore();
    }
  });
});
