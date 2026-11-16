import express from "express";
import { request as httpRequest } from "node:http";
import request from "supertest";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMiningCancelRouter } from "../src/api/mining-cancel.js";
import { resetMcpCallerJwksCacheForTests } from "../src/auth/mcp-caller.js";
import { BlobMiningStore } from "../src/mining/blob-store.js";
import { type MiningRunStatus } from "../src/mining/run-coordinator.js";
import { MiningCoordinationError, type StoredDocument } from "../src/mining/store.js";

const runId = "11111111-1111-4111-8111-111111111111";
const operator = "33333333-3333-4333-8333-333333333333";
const env = {
  MINING_CANCEL_ENABLED: "true",
  MINING_CANCEL_OPERATOR_PRINCIPAL_IDS: operator,
  MINING_CANCEL_DELEGATED_SCOPE: "Mining.Run.Cancel",
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
  stopRequested: true,
};
const claims = (): JWTPayload => ({
  oid: operator,
  tid: env.ASSISTANT_AUTH_TENANT_ID,
  scp: env.MINING_CANCEL_DELEGATED_SCOPE,
  exp: Math.floor(Date.now() / 1000) + 3600,
});
function setup(configuration: NodeJS.ProcessEnv = env, synthetic = false) {
  const verifyClaims = vi.fn(
    async (_req: express.Request, _signal: AbortSignal): Promise<JWTPayload | undefined> =>
      claims(),
  );
  const stop = vi.fn(async (_id: string, _signal: AbortSignal) => ({
    accepted: true as const,
    status,
  }));
  const stopContinuous = vi.fn(async (_generation: string, _signal: AbortSignal) => ({
    accepted: true as const,
    generation: "release-1",
    stopRequested: true as const,
    status: null as MiningRunStatus | null,
  }));
  const app = express();
  app.use(express.json());
  app.use(
    "/api/mining",
    createMiningCancelRouter({ synthetic, env: configuration, verifyClaims, stop, stopContinuous }),
  );
  return { app, verifyClaims, stop, stopContinuous };
}
const cancel = (app: express.Express, input: object = body) =>
  request(app).post("/api/mining/runs/cancel").send(input);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  resetMcpCallerJwksCacheForTests();
});

describe("delegated mining cancellation", () => {
  const continuousEnv = {
    ...env,
    MINING_CONTINUOUS_CONTROL_ENABLED: "true",
    MINING_CONTINUOUS_OPERATOR_PRINCIPAL_IDS: operator,
    MINING_CONTINUOUS_DELEGATED_SCOPE: "Mining.Continuous.Stop",
    MINING_CONTINUOUS_GENERATION: "release-1",
    MINING_APPROVED_RUN_ID: undefined,
  };
  const generationBody = { plantId: "D01", generation: "release-1" };
  const stopGeneration = (app: express.Express, input: object = generationBody) =>
    request(app).post("/api/mining/continuous/stop").send(input);

  it("keeps generation controls default-off and separate from bounded cancel permission", async () => {
    for (const configuration of [
      env,
      { ...continuousEnv, MINING_CONTINUOUS_GENERATION: "../escape" },
      { ...continuousEnv, MINING_CONTINUOUS_OPERATOR_PRINCIPAL_IDS: undefined },
      { ...continuousEnv, MINING_CONTINUOUS_DELEGATED_SCOPE: env.MINING_CANCEL_DELEGATED_SCOPE },
    ]) {
      const { app, verifyClaims, stopContinuous } = setup(configuration);
      expect((await stopGeneration(app)).status).toBe(503);
      expect(verifyClaims).not.toHaveBeenCalled();
      expect(stopContinuous).not.toHaveBeenCalled();
    }
    const { app, verifyClaims, stopContinuous } = setup(continuousEnv);
    expect((await stopGeneration(app)).status).toBe(403);
    verifyClaims.mockResolvedValue({ ...claims(), scp: "Mining.Continuous.Stop", idtyp: "app" });
    expect((await stopGeneration(app)).status).toBe(403);
    expect(stopContinuous).not.toHaveBeenCalled();
  });

  it("authenticates and pins the operator generation, never claims publication or ingestion completed", async () => {
    const { app, verifyClaims, stop, stopContinuous } = setup(continuousEnv);
    verifyClaims.mockResolvedValue({ ...claims(), scp: "Mining.Continuous.Stop" });
    for (const input of [
      { ...generationBody, generation: "release-2" },
      { ...generationBody, runId },
      { ...generationBody, plantId: "other" },
      { plantId: "D01" },
    ])
      expect((await stopGeneration(app, input)).status).toBe(400);
    expect(stopContinuous).not.toHaveBeenCalled();
    const response = await stopGeneration(app);
    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      plantId: "D01",
      generation: "release-1",
      stopRequested: true,
      runId: null,
      publisherStatus: "not_running",
      ingestionStatus: "unknown",
    });
    expect(stopContinuous).toHaveBeenCalledExactlyOnceWith("release-1", expect.any(AbortSignal));
    expect(stop).not.toHaveBeenCalled();
  });

  it("does not turn uncertain or wrong-generation stop readback into success", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, verifyClaims, stopContinuous } = setup(continuousEnv);
    verifyClaims.mockResolvedValue({ ...claims(), scp: "Mining.Continuous.Stop" });
    stopContinuous.mockRejectedValueOnce(
      new MiningCoordinationError("uncertain", "Lost write response."),
    );
    expect((await stopGeneration(app)).status).toBe(503);
    stopContinuous.mockResolvedValueOnce({
      accepted: true,
      generation: "release-2",
      stopRequested: true,
      status: null,
    });
    expect((await stopGeneration(app)).status).toBe(503);
  });

  it("persists generation stop through the configured store without acquiring writer authority", async () => {
    const documents = new Map<string, StoredDocument>();
    vi.spyOn(BlobMiningStore.prototype, "read").mockImplementation(async (path) =>
      documents.get(path),
    );
    const create = vi
      .spyOn(BlobMiningStore.prototype, "create")
      .mockImplementation(async (path, value) => {
        if (documents.has(path)) return false;
        documents.set(path, { value, etag: "1", leased: false });
        return true;
      });
    for (const method of ["write", "acquire", "renew", "release"] as const) {
      vi.spyOn(BlobMiningStore.prototype, method).mockImplementation(async () => {
        throw new Error("Stop must not acquire or mutate writer authority.");
      });
    }
    const app = express();
    app.use(express.json());
    app.use(
      "/api/mining",
      createMiningCancelRouter({
        synthetic: false,
        verifyClaims: async () => ({ ...claims(), scp: "Mining.Continuous.Stop" }),
        env: {
          ...continuousEnv,
          MINING_RUN_COORDINATION_ENABLED: "true",
          MINING_STATE_BLOB_ENDPOINT: "https://miningstate.blob.core.windows.net",
          MINING_STATE_CONTAINER: "mining-state",
        },
      }),
    );
    expect((await stopGeneration(app)).status).toBe(202);
    expect(create).toHaveBeenCalledExactlyOnceWith("continuous/holds/release-1.json", {
      version: 1,
      plantId: "D01",
      generation: "release-1",
      requestedAt: expect.any(String),
    });
    expect((await stopGeneration(app)).status).toBe(202);
    expect(documents.size).toBe(1);
  });

  it.each([
    [{}, false],
    [env, true],
    [{ ...env, MINING_CANCEL_ENABLED: "TRUE" }, false],
    [
      {
        ...env,
        MINING_CANCEL_OPERATOR_PRINCIPAL_IDS: undefined,
        MINING_VIEWER_PRINCIPAL_IDS: operator,
      },
      false,
    ],
    [{ ...env, MINING_CANCEL_DELEGATED_SCOPE: "*" }, false],
    [{ ...env, MINING_MANAGED_IDENTITY_CLIENT_ID: undefined }, false],
  ])(
    "stays disabled or fails closed without protected action configuration (%j)",
    async (configuration, synthetic) => {
      const { app, stop, verifyClaims } = setup(configuration, synthetic);
      expect((await cancel(app)).status).toBe(503);
      expect(verifyClaims).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
    },
  );

  it.each([
    undefined,
    { ...claims(), scp: undefined, roles: ["Mining.Run.Cancel"] },
    { ...claims(), idtyp: "app" },
    { ...claims(), scp: "Mining.Run.Cancel.Extra" },
    { ...claims(), oid: "77777777-7777-4777-8777-777777777777" },
    { ...claims(), tid: "77777777-7777-4777-8777-777777777777" },
    { ...claims(), exp: undefined },
  ])(
    "never promotes absent, viewer/app-only or unauthorized claims into a write (%j)",
    async (value) => {
      const { app, stop, verifyClaims } = setup();
      verifyClaims.mockResolvedValue(value);
      expect((await cancel(app)).status).toBe(value ? 403 : 401);
      expect(stop).not.toHaveBeenCalled();
    },
  );

  it.each([
    {},
    { ...body, plantId: "TRIATHLON" },
    { ...body, runId: runId.toUpperCase().replace("1111", "ABCD") },
    { ...body, durationSeconds: 30 },
    { ...body, runId: "22222222-2222-4222-8222-222222222222" },
  ])("rejects malformed or unapproved run parameters before mutation (%j)", async (input) => {
    const { app, stop } = setup();
    expect([400, 403]).toContain((await cancel(app, input)).status);
    expect(stop).not.toHaveBeenCalled();
  });

  it("accepts stop intent without claiming stopped or ingested, independently of read readiness", async () => {
    const { app, stop } = setup();
    const response = await cancel(app);
    expect(response.status).toBe(202);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      ...body,
      stopRequested: true,
      publisherStatus: "running",
      ingestionStatus: "unknown",
    });
    expect(stop).toHaveBeenCalledExactlyOnceWith(runId, expect.any(AbortSignal));
    const query = await request(app).post("/api/mining/runs/cancel?runId=other").send(body);
    expect(query.status).toBe(400);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("verifies actual signed delegation and rejects wrong audience, app-only and spoofed headers", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              keys: [
                { ...(await exportJWK(publicKey)), kid: "cancel-test", alg: "RS256", use: "sig" },
              ],
            }),
          ),
      ),
    );
    const app = express();
    const stop = vi.fn(async () => ({ accepted: true as const, status }));
    app.use(express.json());
    app.use("/api/mining", createMiningCancelRouter({ synthetic: false, env, stop }));
    const sign = (payload: JWTPayload, audience = env.ASSISTANT_AUTH_CLIENT_ID) =>
      new SignJWT(payload)
        .setProtectedHeader({ alg: "RS256", kid: "cancel-test" })
        .setIssuer(`https://login.microsoftonline.com/${env.ASSISTANT_AUTH_TENANT_ID}/v2.0`)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey);
    const signedRequest = async (payload: JWTPayload, audience?: string) =>
      cancel(app).set("Authorization", `Bearer ${await sign(payload, audience)}`);
    expect((await signedRequest(claims())).status).toBe(202);
    expect((await signedRequest({ ...claims(), idtyp: "app" })).status).toBe(403);
    expect(
      (await signedRequest({ ...claims(), scp: undefined, roles: ["Mining.Run.Cancel"] })).status,
    ).toBe(403);
    expect((await signedRequest(claims(), "unapproved-api")).status).toBe(401);
    expect((await cancel(app).set("X-MS-CLIENT-PRINCIPAL-ID", operator)).status).toBe(401);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("uses the actual configured coordinator/store to persist only same-run stop intent", async () => {
    const spec = { ...body, durationSeconds: 1200, scenario: "normal", seed: 1 };
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
    vi.spyOn(BlobMiningStore.prototype, "read").mockImplementation(async (path) =>
      documents.get(path),
    );
    const create = vi
      .spyOn(BlobMiningStore.prototype, "create")
      .mockImplementation(async (path, value) => {
        documents.set(path, { value, etag: "3", leased: false });
        return true;
      });
    for (const method of ["write", "acquire", "renew", "release"] as const) {
      vi.spyOn(BlobMiningStore.prototype, method).mockImplementation(async () => {
        throw new Error("Unexpected lease/state write.");
      });
    }
    const app = express();
    app.use(express.json());
    app.use(
      "/api/mining",
      createMiningCancelRouter({
        synthetic: false,
        verifyClaims: async () => claims(),
        env: {
          ...env,
          MINING_RUN_COORDINATION_ENABLED: "true",
          MINING_STATE_BLOB_ENDPOINT: "https://miningstate.blob.core.windows.net",
          MINING_STATE_CONTAINER: "mining-state",
        },
      }),
    );
    const response = await cancel(app);
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      stopRequested: true,
      publisherStatus: "publisher_complete",
      ingestionStatus: "unknown",
    });
    expect(create).toHaveBeenCalledExactlyOnceWith(`stops/${runId}.json`, {
      runId,
      requestedAt: expect.any(String),
    });
  });

  it("surfaces missing admission, verification outages and uncertain writes without retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { app, verifyClaims, stop } = setup();
    verifyClaims.mockRejectedValueOnce(new Error("JWKS unavailable."));
    expect((await cancel(app)).body.error.code).toBe("mining_authentication_unavailable");
    expect(stop).not.toHaveBeenCalled();
    stop.mockRejectedValueOnce(new MiningCoordinationError("conflict", "Not admitted."));
    expect((await cancel(app)).status).toBe(409);
    stop.mockRejectedValueOnce(new MiningCoordinationError("uncertain", "Lost write response."));
    const response = await cancel(app);
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("mining_cancel_outcome_unknown");
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("reports deadline uncertainty and cannot start mutation after late authentication", async () => {
    const { app, verifyClaims, stop } = setup();
    let authenticate!: (value: JWTPayload) => void;
    let started!: () => void;
    const verifying = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    verifyClaims.mockImplementation(async () => {
      started();
      return new Promise<JWTPayload>((resolve) => {
        authenticate = resolve;
      });
    });
    const response = cancel(app).then((value) => value);
    await verifying;
    await vi.advanceTimersByTimeAsync(9_900);
    expect((await response).body.error.code).toBe("mining_cancel_outcome_unknown");
    authenticate(claims());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stop).not.toHaveBeenCalled();
  });

  it("reports an in-flight write deadline as unknown and never retries or sends late success", async () => {
    const { app, stop } = setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settle!: () => void;
    let entered!: () => void;
    let signal: AbortSignal | undefined;
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    stop.mockImplementation(async (_id, callerSignal) => {
      signal = callerSignal;
      entered();
      await new Promise<void>((resolve) => {
        settle = resolve;
      });
      return { accepted: true, status };
    });
    const response = cancel(app).then((value) => value);
    await writing;
    await vi.advanceTimersByTimeAsync(9_900);
    expect((await response).body.error.code).toBe("mining_cancel_outcome_unknown");
    expect(signal?.aborted).toBe(true);
    settle();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("does not submit stop intent after an actual client disconnect during authorization", async () => {
    const { app, verifyClaims, stop } = setup();
    let entered!: () => void;
    let aborted!: () => void;
    const verifying = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const disconnected = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    verifyClaims.mockImplementation(
      async (_req, signal) =>
        new Promise<JWTPayload>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted();
              resolve(claims());
            },
            { once: true },
          );
          entered();
        }),
    );
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address.");
    const client = httpRequest(`http://127.0.0.1:${address.port}/api/mining/runs/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const socketErrors: Error[] = [];
    client.on("error", (cause) => socketErrors.push(cause));
    try {
      client.end(JSON.stringify(body));
      await verifying;
      client.destroy();
      await disconnected;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stop).not.toHaveBeenCalled();
      expect(socketErrors.every((cause) => cause.message === "socket hang up")).toBe(true);
    } finally {
      client.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((cause) => (cause ? reject(cause) : resolve())),
      );
    }
  });
});
