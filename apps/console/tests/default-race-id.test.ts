import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createDefaultRaceIdAction } from "../src/actions/default-race-id.js";
import { deriveGoalRaceId } from "@triathlon-twin/simulator";

function buildApp(resolveDefaultAthleteId?: () => string | undefined) {
  const app = express();
  app.get("/actions/default-race-id", createDefaultRaceIdAction({ resolveDefaultAthleteId }));
  return app;
}

describe("GET /actions/default-race-id", () => {
  it("returns 400 when no athleteId is supplied and no default is configured", async () => {
    const app = buildApp(() => undefined);

    const res = await request(app).get("/actions/default-race-id");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("missing_athlete_id");
  });

  it("returns the deterministic goal race id for the default athlete", async () => {
    const app = buildApp(() => "athlete-123");

    const res = await request(app).get("/actions/default-race-id");

    expect(res.status).toBe(200);
    expect(res.body.athleteId).toBe("athlete-123");
    expect(res.body.raceId).toBe(deriveGoalRaceId("athlete-123"));
  });

  it("prefers an explicit ?athleteId= query param over the default", async () => {
    const app = buildApp(() => "default-athlete");

    const res = await request(app).get("/actions/default-race-id?athleteId=explicit-athlete");

    expect(res.status).toBe(200);
    expect(res.body.athleteId).toBe("explicit-athlete");
    expect(res.body.raceId).toBe(deriveGoalRaceId("explicit-athlete"));
  });

  it("is deterministic -- the same athleteId always yields the same raceId", async () => {
    const app = buildApp(() => "athlete-123");

    const first = await request(app).get("/actions/default-race-id");
    const second = await request(app).get("/actions/default-race-id");

    expect(first.body.raceId).toBe(second.body.raceId);
  });
});
