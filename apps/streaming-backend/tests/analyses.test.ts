import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAnalysesRouter } from "../src/api/analyses.js";
import { resetPrincipalAthleteMapCacheForTests } from "../src/auth/authorization.js";
import type { AthleteAnalysesResponse } from "../src/services/realtime-insights.js";

const ATHLETE_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ATHLETE_ID = "33333333-3333-3333-3333-333333333333";
const PRINCIPAL_ID = "22222222-2222-2222-2222-222222222222";

function buildApp(analysesService: { getAnalyses: (athleteId: string) => Promise<AthleteAnalysesResponse> }) {
  const app = express();
  app.use("/api/analyses", createAnalysesRouter({ analysesService }));
  return app;
}

describe("GET /api/analyses/:athleteId", () => {
  beforeEach(() => {
    process.env.ATHLETE_PRINCIPAL_MAP = JSON.stringify({ [PRINCIPAL_ID]: ATHLETE_ID });
    resetPrincipalAthleteMapCacheForTests();
  });

  afterEach(() => {
    delete process.env.ATHLETE_PRINCIPAL_MAP;
    resetPrincipalAthleteMapCacheForTests();
  });

  it("returns the 5 analyses for the authorized athlete", async () => {
    const analyses: AthleteAnalysesResponse = {
      acuteChronicWorkloadRatio: 1.08,
      recoveryScore: 82.4,
      nutritionAdequacy: 0.76,
      sleepDebtMinutes: 34.5,
      taperIndex: 0.68,
      asOf: "2026-09-04T06:30:00.000Z",
    };
    const analysesService = {
      getAnalyses: vi.fn(async () => analyses),
    };
    const app = buildApp(analysesService);

    const res = await request(app)
      .get(`/api/analyses/${ATHLETE_ID}`)
      .set("x-ms-client-principal-id", PRINCIPAL_ID);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(analyses);
    expect(analysesService.getAnalyses).toHaveBeenCalledWith(ATHLETE_ID);
  });

  it("returns 403 Forbidden when the caller requests a different athleteId (FR-017)", async () => {
    const analysesService = {
      getAnalyses: vi.fn(async () => ({
        acuteChronicWorkloadRatio: 1,
        recoveryScore: 1,
        nutritionAdequacy: 1,
        sleepDebtMinutes: 1,
        taperIndex: 1,
        asOf: "2026-09-04T06:30:00.000Z",
      })),
    };
    const app = buildApp(analysesService);

    const res = await request(app)
      .get(`/api/analyses/${OTHER_ATHLETE_ID}`)
      .set("x-ms-client-principal-id", PRINCIPAL_ID);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: { code: "forbidden", message: "Not authorized for this athlete." },
    });
    expect(analysesService.getAnalyses).not.toHaveBeenCalled();
  });

  it("returns 500 when the Eventhouse-backed analyses query fails", async () => {
    const analysesService = {
      getAnalyses: vi.fn(async () => {
        throw new Error("Kusto query failed");
      }),
    };
    const app = buildApp(analysesService);

    const res = await request(app)
      .get(`/api/analyses/${ATHLETE_ID}`)
      .set("x-ms-client-principal-id", PRINCIPAL_ID);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: "analyses_query_failed", message: "Kusto query failed" },
    });
  });
});

