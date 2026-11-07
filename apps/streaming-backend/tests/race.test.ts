import type { Race, RaceSplit } from "@triathlon-twin/simulator";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRaceRouter } from "../src/api/race.js";
import { resetPrincipalAthleteMapCacheForTests } from "../src/auth/authorization.js";
import { RaceStateStore, type RaceCatalog } from "../src/services/race-state.js";

const ATHLETE_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ATHLETE_ID = "33333333-3333-3333-3333-333333333333";
const PRINCIPAL_ID = "22222222-2222-2222-2222-222222222222";
const RACE_ID = "44444444-4444-4444-4444-444444444444";

function buildRace(overrides: Partial<Race> = {}): Race {
  return {
    raceId: RACE_ID,
    athleteId: ATHLETE_ID,
    name: "Demo Olympic Triathlon",
    date: "2026-09-13",
    distance: "olympic",
    goalTimeSeconds: 9_000,
    status: "upcoming",
    predictedFinishTimeSeconds: null,
    actualFinishTimeSeconds: null,
    pacingEvennessStdDev: null,
    ...overrides,
  };
}

function buildSplit(overrides: Partial<RaceSplit> = {}): RaceSplit {
  return {
    raceId: RACE_ID,
    timestamp: "2026-09-13T07:00:00.000Z",
    distanceCoveredMeters: 1_500,
    currentPaceSecPerKm: 130,
    plannedPaceSecPerKm: 128,
    currentHeartRate: 152,
    leg: "swim",
    isFinish: false,
    ...overrides,
  };
}

function buildApp(raceCatalog: RaceCatalog, raceState: RaceStateStore) {
  const app = express();
  app.use("/api/race", createRaceRouter({ raceCatalog, raceState }));
  return app;
}

describe("GET /api/race/:raceId/live and /summary", () => {
  beforeEach(() => {
    process.env.ATHLETE_PRINCIPAL_MAP = JSON.stringify({ [PRINCIPAL_ID]: ATHLETE_ID });
    resetPrincipalAthleteMapCacheForTests();
  });

  afterEach(() => {
    delete process.env.ATHLETE_PRINCIPAL_MAP;
    resetPrincipalAthleteMapCacheForTests();
  });

  it("returns 403 when the caller has no authorized athlete (FR-017)", async () => {
    const raceCatalog: RaceCatalog = { findRaceForAthlete: vi.fn(async () => buildRace()) };
    const raceState = new RaceStateStore();
    const app = buildApp(raceCatalog, raceState);

    const res = await request(app).get(`/api/race/${RACE_ID}/live`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: { code: "forbidden", message: "Not authorized for this athlete." },
    });
    expect(raceCatalog.findRaceForAthlete).not.toHaveBeenCalled();
  });

  it("returns 403 when the race does not belong to the authorized athlete (FR-017 cross-athlete isolation)", async () => {
    const raceCatalog: RaceCatalog = { findRaceForAthlete: vi.fn(async () => null) };
    const raceState = new RaceStateStore();
    const app = buildApp(raceCatalog, raceState);

    const res = await request(app)
      .get(`/api/race/${RACE_ID}/live`)
      .set("x-ms-client-principal-id", PRINCIPAL_ID);

    expect(res.status).toBe(403);
    expect(raceCatalog.findRaceForAthlete).toHaveBeenCalledWith(ATHLETE_ID, RACE_ID);
  });

  it("returns the live view with a computed progress percentage while the race is in progress", async () => {
    const race = buildRace({ status: "live" });
    const raceCatalog: RaceCatalog = { findRaceForAthlete: vi.fn(async () => race) };
    const raceState = new RaceStateStore();
    raceState.startRace({ athleteId: ATHLETE_ID, raceId: RACE_ID });
    raceState.recordSplit({
      athleteId: ATHLETE_ID,
      raceId: RACE_ID,
      split: buildSplit({ distanceCoveredMeters: 25_965 }), // half of the olympic distance
      projectedFinishTimeSeconds: 9_100,
    });
    const app = buildApp(raceCatalog, raceState);

    const res = await request(app)
      .get(`/api/race/${RACE_ID}/live`)
      .set("x-ms-client-principal-id", PRINCIPAL_ID);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("live");
    expect(res.body.projectedFinishTimeSeconds).toBe(9_100);
    expect(res.body.progressPct).toBeCloseTo(50, 0);
  });

  it("returns 404 race_summary_unavailable when the race hasn't completed yet", async () => {
    const race = buildRace({ status: "upcoming" });
    const raceCatalog: RaceCatalog = { findRaceForAthlete: vi.fn(async () => race) };
    const raceState = new RaceStateStore();
    const app = buildApp(raceCatalog, raceState);

    const res = await request(app)
      .get(`/api/race/${RACE_ID}/summary`)
      .set("x-ms-client-principal-id", PRINCIPAL_ID);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: "race_summary_unavailable",
        message: "Race summary is only available after a race simulation completes.",
      },
    });
  });

  it("computes the summary (predicted/actual finish time, pacing evenness) for a race completed this session", async () => {
    const race = buildRace({ status: "live" });
    const raceCatalog: RaceCatalog = { findRaceForAthlete: vi.fn(async () => race) };
    const raceState = new RaceStateStore();
    raceState.startRace({ athleteId: ATHLETE_ID, raceId: RACE_ID });
    // Two splits: one right on plan (delta 0), one 10s/km slow (delta +10) -- population stddev
    // of [0, 10] is 5, matching computePacingEvennessStdDev's Math.sqrt(variance) formula.
    raceState.recordSplit({
      athleteId: ATHLETE_ID,
      raceId: RACE_ID,
      split: buildSplit({ currentPaceSecPerKm: 128, plannedPaceSecPerKm: 128, isFinish: false }),
      projectedFinishTimeSeconds: 9_050,
    });
    raceState.recordSplit({
      athleteId: ATHLETE_ID,
      raceId: RACE_ID,
      split: buildSplit({
        currentPaceSecPerKm: 138,
        plannedPaceSecPerKm: 128,
        isFinish: true,
        leg: "run",
      }),
      projectedFinishTimeSeconds: 9_180,
    });
    const app = buildApp(raceCatalog, raceState);

    const res = await request(app)
      .get(`/api/race/${RACE_ID}/summary`)
      .set("x-ms-client-principal-id", PRINCIPAL_ID);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      raceId: RACE_ID,
      athleteId: ATHLETE_ID,
      status: "completed",
      predictedFinishTimeSeconds: 9_050,
      actualFinishTimeSeconds: 9_180,
      pacingEvennessStdDev: 5,
    });
  });

  it("falls back to the persisted (Lakehouse) summary for a race completed in an earlier server session", async () => {
    const race = buildRace({
      status: "completed",
      predictedFinishTimeSeconds: 9_000,
      actualFinishTimeSeconds: 9_240,
      pacingEvennessStdDev: 8.4,
    });
    const raceCatalog: RaceCatalog = { findRaceForAthlete: vi.fn(async () => race) };
    // Fresh store: no in-memory runtime state for this race (simulates a server restart after
    // the race completed in a prior process).
    const raceState = new RaceStateStore();
    const app = buildApp(raceCatalog, raceState);

    const res = await request(app)
      .get(`/api/race/${RACE_ID}/summary`)
      .set("x-ms-client-principal-id", PRINCIPAL_ID);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "completed",
      predictedFinishTimeSeconds: 9_000,
      actualFinishTimeSeconds: 9_240,
      pacingEvennessStdDev: 8.4,
      completedAt: null,
    });
  });

  it("returns 500 race_live_query_failed when the race catalog lookup throws", async () => {
    const raceCatalog: RaceCatalog = {
      findRaceForAthlete: vi.fn(async () => {
        throw new Error("Lakehouse read failed");
      }),
    };
    const raceState = new RaceStateStore();
    const app = buildApp(raceCatalog, raceState);

    const res = await request(app)
      .get(`/api/race/${RACE_ID}/live`)
      .set("x-ms-client-principal-id", PRINCIPAL_ID);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("race_live_query_failed");
  });

  it("never leaks another athlete's race even when the caller supplies a plausible raceId (OTHER_ATHLETE_ID has no mapping)", async () => {
    const raceCatalog: RaceCatalog = { findRaceForAthlete: vi.fn(async () => null) };
    const raceState = new RaceStateStore();
    const app = buildApp(raceCatalog, raceState);

    process.env.ATHLETE_PRINCIPAL_MAP = JSON.stringify({
      [PRINCIPAL_ID]: OTHER_ATHLETE_ID,
    });
    resetPrincipalAthleteMapCacheForTests();

    const res = await request(app)
      .get(`/api/race/${RACE_ID}/summary`)
      .set("x-ms-client-principal-id", PRINCIPAL_ID);

    expect(res.status).toBe(403);
    expect(raceCatalog.findRaceForAthlete).toHaveBeenCalledWith(OTHER_ATHLETE_ID, RACE_ID);
  });
});
