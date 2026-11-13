import express from "express";
import type { JWTPayload } from "jose";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMiningStartRouter } from "../src/api/mining-start.js";
import { MiningCoordinationError } from "../src/mining/store.js";
import type { MiningPublisherExecution } from "../src/mining/publisher-host.js";
import type { MiningRunStatus } from "../src/mining/run-coordinator.js";

const runId = "11111111-1111-4111-8111-111111111111";
const operator = "33333333-3333-4333-8333-333333333333";
const env = {
  MINING_START_ENABLED: "true",
  MINING_START_OPERATOR_PRINCIPAL_IDS: operator,
  MINING_START_DELEGATED_SCOPE: "Mining.Run.Start",
  MINING_APPROVED_RUN_ID: runId,
  MINING_MANAGED_IDENTITY_CLIENT_ID: "66666666-6666-4666-8666-666666666666",
  ASSISTANT_AUTH_TENANT_ID: "44444444-4444-4444-8444-444444444444",
  ASSISTANT_AUTH_CLIENT_ID: "55555555-5555-4555-8555-555555555555",
};
const body = { plantId: "D01", runId };
const status: MiningRunStatus = {
  runId,
  admission: "accepted",
  phase: "running",
  stopRequested: false,
};
const claims = () => ({
  oid: operator,
  tid: env.ASSISTANT_AUTH_TENANT_ID,
  scp: env.MINING_START_DELEGATED_SCOPE,
  exp: Math.floor(Date.now() / 1000) + 3600,
});

function setup(
  configuration: NodeJS.ProcessEnv = env,
  synthetic = false,
  execution: MiningPublisherExecution = {
    admission: Promise.resolve({ kind: "started", status }),
    completion: Promise.resolve(status),
  },
) {
  const verifyClaims = vi.fn<() => Promise<JWTPayload | undefined>>(async () => claims());
  const start = vi.fn(() => execution);
  const app = express();
  app.use(express.json());
  app.use(
    "/api/mining",
    createMiningStartRouter({ synthetic, env: configuration, verifyClaims, start }),
  );
  return { app, verifyClaims, start };
}

function rejectedExecution(error: unknown): MiningPublisherExecution {
  const admission = Promise.resolve().then(() => {
    throw error;
  });
  const completion = Promise.resolve().then(() => {
    throw error;
  });
  // Tests assert API mapping, not Node's unhandled-rejection mechanics.
  void admission.catch(() => {});
  void completion.catch(() => {});
  return { admission, completion };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("delegated mining start", () => {
  it.each([
    [{}, false],
    [env, true],
    [{ ...env, MINING_START_ENABLED: "TRUE" }, false],
    [{ ...env, MINING_START_OPERATOR_PRINCIPAL_IDS: undefined }, false],
    [{ ...env, MINING_START_DELEGATED_SCOPE: "*" }, false],
    [{ ...env, MINING_MANAGED_IDENTITY_CLIENT_ID: undefined }, false],
  ])(
    "stays disabled or fails closed without protected start configuration (%j)",
    async (configuration, synthetic) => {
      const { app, verifyClaims, start } = setup(configuration, synthetic);
      const response = await request(app).post("/api/mining/runs/start").send(body);
      expect(response.status).toBe(503);
      expect(verifyClaims).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    },
  );

  it.each([
    undefined,
    { ...claims(), scp: undefined, roles: ["Mining.Run.Start"] },
    { ...claims(), idtyp: "app" },
    { ...claims(), scp: "Mining.Run.Start.Extra" },
    { ...claims(), oid: "77777777-7777-4777-8777-777777777777" },
    { ...claims(), tid: "77777777-7777-4777-8777-777777777777" },
    { ...claims(), exp: undefined },
  ])("never promotes absent, app-only or unauthorized claims into a start (%j)", async (value) => {
    const { app, verifyClaims, start } = setup();
    verifyClaims.mockResolvedValue(value as JWTPayload | undefined);
    expect((await request(app).post("/api/mining/runs/start").send(body)).status).toBe(
      value ? 403 : 401,
    );
    expect(start).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { ...body, plantId: "TRIATHLON" },
    { ...body, runId: runId.toUpperCase().replace("1111", "ABCD") },
    { ...body, durationSeconds: 1200 },
    { ...body, scenario: "normal" },
    { ...body, seed: 1 },
    { ...body, runId: "22222222-2222-4222-8222-222222222222" },
  ])("rejects malformed or unapproved start requests before admission (%j)", async (input) => {
    const { app, start } = setup();
    expect([400, 403]).toContain(
      (await request(app).post("/api/mining/runs/start").send(input)).status,
    );
    expect(start).not.toHaveBeenCalled();
  });

  it("accepts a fresh admission and reports started status without waiting for completion", async () => {
    let release!: () => void;
    const completion = new Promise<MiningRunStatus>((resolve) => {
      release = () => resolve(status);
    });
    const { app, start } = setup(env, false, {
      admission: Promise.resolve({ kind: "started", status }),
      completion,
    });
    const response = await request(app).post("/api/mining/runs/start").send(body);
    expect(response.status).toBe(202);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      plantId: "D01",
      runId,
      admission: "started",
      publisherStatus: "running",
      ingestionStatus: "unknown",
    });
    expect(start).toHaveBeenCalledExactlyOnceWith(
      { plantId: "D01", runId },
      expect.any(AbortSignal),
    );
    release();
  });

  it("returns observed admission status for idempotent retry and rejected admissions as unavailable", async () => {
    const { app } = setup(env, false, {
      admission: Promise.resolve({ kind: "observed", status }),
      completion: Promise.resolve(status),
    });
    expect((await request(app).post("/api/mining/runs/start").send(body)).body).toMatchObject({
      admission: "observed",
      publisherStatus: "running",
    });
    const rejected: MiningRunStatus = { ...status, admission: "rejected", phase: "rejected" };
    const unavailable = setup(env, false, {
      admission: Promise.resolve({ kind: "observed", status: rejected }),
      completion: Promise.resolve(rejected),
    });
    expect((await request(unavailable.app).post("/api/mining/runs/start").send(body)).status).toBe(
      409,
    );
  });

  it("surfaces verification failures and maps local host conflicts/configuration issues", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const verifying = setup();
    verifying.verifyClaims.mockRejectedValueOnce(new Error("JWKS unavailable"));
    expect(
      (await request(verifying.app).post("/api/mining/runs/start").send(body)).body.error.code,
    ).toBe("mining_authentication_unavailable");
    const conflict = setup();
    conflict.start.mockImplementationOnce(() => {
      throw new MiningCoordinationError("conflict", "busy");
    });
    expect((await request(conflict.app).post("/api/mining/runs/start").send(body)).status).toBe(
      409,
    );
    const unavailable = setup();
    unavailable.start.mockImplementationOnce(() => {
      throw new MiningCoordinationError("configuration", "disabled");
    });
    expect((await request(unavailable.app).post("/api/mining/runs/start").send(body)).status).toBe(
      503,
    );
  });

  it("maps admission failures and keeps settled async completion outside admission responses", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const invalid = setup(
      env,
      false,
      rejectedExecution(new MiningCoordinationError("invalid", "bad start")),
    );
    expect((await request(invalid.app).post("/api/mining/runs/start").send(body)).status).toBe(400);
    const conflict = setup(
      env,
      false,
      rejectedExecution(new MiningCoordinationError("conflict", "occupied")),
    );
    expect((await request(conflict.app).post("/api/mining/runs/start").send(body)).status).toBe(
      409,
    );
    const uncertain = setup(
      env,
      false,
      rejectedExecution(new MiningCoordinationError("uncertain", "lost write")),
    );
    expect((await request(uncertain.app).post("/api/mining/runs/start").send(body)).status).toBe(
      503,
    );
    const detached = setup(
      env,
      false,
      (() => {
        const completion = Promise.resolve().then(() => {
          throw new Error("publisher failed");
        });
        void completion.catch(() => {});
        return {
          admission: Promise.resolve({ kind: "started", status }),
          completion,
        };
      })(),
    );
    const response = await request(detached.app).post("/api/mining/runs/start").send(body);
    expect(response.status).toBe(202);
  });
});
