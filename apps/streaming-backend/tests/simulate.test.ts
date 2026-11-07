import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SeedHistoryFreshResult, SeedHistoryResult } from "@triathlon-twin/simulator";
import { createSimulateRouter } from "../src/api/simulate.js";
import { resetPrincipalAthleteMapCacheForTests } from "../src/auth/authorization.js";
import { GlobalConcurrencyLock } from "../src/services/concurrency-lock.js";

const ATHLETE_ID = "11111111-1111-1111-1111-111111111111";
const PRINCIPAL_ID = "22222222-2222-2222-2222-222222222222";

function buildFreshResult(): SeedHistoryFreshResult {
  return {
    athleteId: ATHLETE_ID,
    runId: "run-seed-001",
    outcome: "seeded",
    status: "completed",
    environment: "test",
    referenceDate: "2026-09-03",
    seededAt: "2026-09-03T12:00:00.000Z",
    counts: {
      Athlete: 1,
      TrainingBlock: 1,
      TrainingBlockPhase: 4,
      TrainingSession: 112,
      RecoveryMetrics: 112,
      NutritionLog: 504,
      SleepSession: 112,
      Race: 3,
      Equipment: 3,
      SessionMetric: 10_000,
    },
    lakehouse: {
      mode: "files-pending-load",
      dataRootPath: "demo-lakehouse/Files/history-seeding/test/1111",
      manifestPath: "demo-lakehouse/Files/history-seeding/test/1111/seed-manifest.json",
      files: {
        Athlete: "Athlete.jsonl",
        TrainingBlock: "TrainingBlock.jsonl",
        TrainingBlockPhase: "TrainingBlockPhase.jsonl",
        TrainingSession: "TrainingSession.jsonl",
        RecoveryMetrics: "RecoveryMetrics.jsonl",
        NutritionLog: "NutritionLog.jsonl",
        SleepSession: "SleepSession.jsonl",
        Race: "Race.jsonl",
        Equipment: "Equipment.jsonl",
      },
      rowCounts: {
        Athlete: 1,
        TrainingBlock: 1,
        TrainingBlockPhase: 4,
        TrainingSession: 112,
        RecoveryMetrics: 112,
        NutritionLog: 504,
        SleepSession: 112,
        Race: 3,
        Equipment: 3,
      },
      caveat:
        "Rows were written to the Lakehouse Files area only; a follow-up Fabric notebook/Data Pipeline must load Files/ into Delta Tables/ before dashboards can query them as Lakehouse tables.",
    },
    eventhouse: {
      publishedSessionMetricCount: 10_000,
      fullyQualifiedNamespace: "triathlon-demo.servicebus.windows.net",
      eventHubName: "seed-history",
      mappingName: "sessionmetric_json_map",
      route: "eventstream-custom-endpoint",
    },
    anomalies: [
      { type: "poor-sleep", date: "2026-07-12" },
      { type: "sick-day", date: "2026-08-02", sessionId: "session-1" },
      { type: "missed-session", date: "2026-08-14", sessionId: "session-2" },
    ],
  };
}

function buildAlreadySeededResult(): SeedHistoryResult {
  const fresh = buildFreshResult();
  return {
    ...fresh,
    outcome: "already-seeded",
    status: "already-seeded",
    existingStatus: "completed",
  };
}

function buildApp(options: Parameters<typeof createSimulateRouter>[0]) {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/simulate",
    createSimulateRouter({
      environment: "test",
      concurrencyLock: new GlobalConcurrencyLock(),
      ...options,
    }),
  );
  return app;
}

describe("POST /api/simulate/seed-history", () => {
  beforeEach(() => {
    process.env.ATHLETE_PRINCIPAL_MAP = JSON.stringify({ [PRINCIPAL_ID]: ATHLETE_ID });
    resetPrincipalAthleteMapCacheForTests();
  });

  afterEach(() => {
    delete process.env.ATHLETE_PRINCIPAL_MAP;
    resetPrincipalAthleteMapCacheForTests();
  });

  it("returns 202 Accepted on the first authorized seed-history request", async () => {
    const seedHistoryImpl = vi.fn(async () => buildFreshResult());
    const app = buildApp({ seedHistoryImpl });

    const res = await request(app)
      .post("/api/simulate/seed-history")
      .set("x-ms-client-principal-id", PRINCIPAL_ID)
      .send({ athleteId: ATHLETE_ID });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ runId: "run-seed-001", status: "started" });
    expect(seedHistoryImpl).toHaveBeenCalledWith({ athleteId: ATHLETE_ID, environment: "test" });
  });

  it("returns 403 Forbidden when the request athleteId is not authorized for the caller", async () => {
    const seedHistoryImpl = vi.fn(async () => buildFreshResult());
    const app = buildApp({ seedHistoryImpl });

    const res = await request(app)
      .post("/api/simulate/seed-history")
      .set("x-ms-client-principal-id", PRINCIPAL_ID)
      .send({ athleteId: "33333333-3333-3333-3333-333333333333" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: { code: "forbidden", message: "Not authorized for this athlete." },
    });
    expect(seedHistoryImpl).not.toHaveBeenCalled();
  });

  it("returns 409 Conflict when the simulator reports the athlete is already seeded", async () => {
    const seedHistoryImpl = vi.fn(async () => buildAlreadySeededResult());
    const app = buildApp({ seedHistoryImpl });

    const res = await request(app)
      .post("/api/simulate/seed-history")
      .set("x-ms-client-principal-id", PRINCIPAL_ID)
      .send({ athleteId: ATHLETE_ID });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      runId: "run-seed-001",
      status: "already-seeded",
      existingStatus: "completed",
    });
  });

  it("returns 403 Forbidden for a mismatched athlete on trigger-session and performs no work", async () => {
    const triggerSessionImpl = vi.fn(async () => undefined);
    const app = buildApp({
      seedHistoryImpl: vi.fn(async () => buildFreshResult()),
      seededHistoryPreconditionChecker: {
        hasSeededHistory: vi.fn(async () => true),
      },
      triggerSessionImpl,
    });

    const res = await request(app)
      .post("/api/simulate/trigger-session")
      .set("x-ms-client-principal-id", PRINCIPAL_ID)
      .send({
        athleteId: "33333333-3333-3333-3333-333333333333",
        discipline: "run",
      });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: { code: "forbidden", message: "Not authorized for this athlete." },
    });
    expect(triggerSessionImpl).not.toHaveBeenCalled();
  });

  it("returns 403 Forbidden for a mismatched athlete on trigger-race and performs no work", async () => {
    const triggerRaceImpl = vi.fn(async () => undefined);
    const app = buildApp({
      seedHistoryImpl: vi.fn(async () => buildFreshResult()),
      seededHistoryPreconditionChecker: {
        hasSeededHistory: vi.fn(async () => true),
      },
      triggerRaceImpl,
    });

    const res = await request(app)
      .post("/api/simulate/trigger-race")
      .set("x-ms-client-principal-id", PRINCIPAL_ID)
      .send({
        athleteId: "33333333-3333-3333-3333-333333333333",
        raceId: "44444444-4444-4444-4444-444444444444",
      });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: { code: "forbidden", message: "Not authorized for this athlete." },
    });
    expect(triggerRaceImpl).not.toHaveBeenCalled();
  });

  it("returns 422 when trigger-session is requested before history has been seeded", async () => {
    const triggerSessionImpl = vi.fn(async () => undefined);
    const app = buildApp({
      seedHistoryImpl: vi.fn(async () => buildFreshResult()),
      seededHistoryPreconditionChecker: {
        hasSeededHistory: vi.fn(async () => false),
      },
      triggerSessionImpl,
    });

    const res = await request(app)
      .post("/api/simulate/trigger-session")
      .set("x-ms-client-principal-id", PRINCIPAL_ID)
      .send({
        athleteId: ATHLETE_ID,
        discipline: "run",
      });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: {
        code: "seed_history_required",
        message: "Seed history must exist for this athlete before starting a live simulation.",
      },
    });
    expect(triggerSessionImpl).not.toHaveBeenCalled();
  });

  it("returns 400 for an unsupported discipline on trigger-session and performs no work", async () => {
    const triggerSessionImpl = vi.fn(async () => undefined);
    const app = buildApp({
      seedHistoryImpl: vi.fn(async () => buildFreshResult()),
      seededHistoryPreconditionChecker: {
        hasSeededHistory: vi.fn(async () => true),
      },
      triggerSessionImpl,
    });

    const res = await request(app)
      .post("/api/simulate/trigger-session")
      .set("x-ms-client-principal-id", PRINCIPAL_ID)
      .send({
        athleteId: ATHLETE_ID,
        discipline: "rowing",
      });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: "invalid_discipline",
        message: 'Unsupported discipline "rowing". Expected one of: swim, bike, run, strength.',
      },
    });
    expect(triggerSessionImpl).not.toHaveBeenCalled();
  });

  it("returns 409 with the in-progress global lock owner when another live run is active", async () => {
    const concurrencyLock = new GlobalConcurrencyLock();
    concurrencyLock.tryAcquire({
      runId: "run-active",
      athleteId: "99999999-9999-4999-8999-999999999999",
      kind: "race",
    });
    const app = buildApp({
      seedHistoryImpl: vi.fn(async () => buildFreshResult()),
      seededHistoryPreconditionChecker: {
        hasSeededHistory: vi.fn(async () => true),
      },
      concurrencyLock,
    });

    const res = await request(app)
      .post("/api/simulate/trigger-session")
      .set("x-ms-client-principal-id", PRINCIPAL_ID)
      .send({
        athleteId: ATHLETE_ID,
        discipline: "run",
      });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: "live_simulation_in_progress",
        message: "A live session or race simulation is already in progress.",
        runId: "run-active",
        athleteId: "99999999-9999-4999-8999-999999999999",
        kind: "race",
      },
    });
  });

  it("returns 202 and invokes the live-session runner once authorization, preconditions, and lock checks pass", async () => {
    const triggerSessionImpl = vi.fn(async () => undefined);
    const app = buildApp({
      seedHistoryImpl: vi.fn(async () => buildFreshResult()),
      seededHistoryPreconditionChecker: {
        hasSeededHistory: vi.fn(async () => true),
      },
      triggerSessionImpl,
      runIdFactory: () => "run-live-session",
    });

    const res = await request(app)
      .post("/api/simulate/trigger-session")
      .set("x-ms-client-principal-id", PRINCIPAL_ID)
      .send({
        athleteId: ATHLETE_ID,
        discipline: "bike",
      });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ runId: "run-live-session", status: "started" });
    expect(triggerSessionImpl).toHaveBeenCalledTimes(1);
    expect(triggerSessionImpl.mock.calls[0]?.[0]).toMatchObject({
      runId: "run-live-session",
      athleteId: ATHLETE_ID,
      discipline: "bike",
    });
  });

  it("returns 202 and invokes the race runner once authorization, preconditions, and lock checks pass", async () => {
    const triggerRaceImpl = vi.fn(async () => undefined);
    const app = buildApp({
      seedHistoryImpl: vi.fn(async () => buildFreshResult()),
      seededHistoryPreconditionChecker: {
        hasSeededHistory: vi.fn(async () => true),
      },
      triggerRaceImpl,
      runIdFactory: () => "run-live-race",
    });

    const res = await request(app)
      .post("/api/simulate/trigger-race")
      .set("x-ms-client-principal-id", PRINCIPAL_ID)
      .send({
        athleteId: ATHLETE_ID,
        raceId: "44444444-4444-4444-4444-444444444444",
      });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ runId: "run-live-race", status: "started" });
    expect(triggerRaceImpl).toHaveBeenCalledTimes(1);
    expect(triggerRaceImpl.mock.calls[0]?.[0]).toMatchObject({
      runId: "run-live-race",
      athleteId: ATHLETE_ID,
      raceId: "44444444-4444-4444-4444-444444444444",
      assumedDistance: "olympic",
    });
  });
});
