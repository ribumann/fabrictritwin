import express from "express";
import https from "node:https";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateSeedHistoryDataset } from "@triathlon-twin/simulator";
import { createAnalysesRouter } from "../src/api/analyses.js";
import { createAlertsRouter } from "../src/api/alerts.js";
import { resetPrincipalAthleteMapCacheForTests } from "../src/auth/authorization.js";
import {
  createRealtimeInsightsService,
  resetRealtimeInsightsClientForTests,
} from "../src/services/realtime-insights.js";
import { resolveRuntimeProfile } from "../src/services/runtime-profile.js";
import {
  SyntheticInsightsService,
  SYNTHETIC_ATHLETE_ID,
} from "../src/services/synthetic-insights.js";
import { createDefaultAlertListener } from "../src/services/alert-listener.js";
import { RealtimeStreamBroker } from "../src/services/realtime-stream.js";

vi.mock("@triathlon-twin/simulator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@triathlon-twin/simulator")>();
  return { ...actual, generateSeedHistoryDataset: vi.fn(actual.generateSeedHistoryDataset) };
});

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: class {
    constructor() {
      throw new Error("Azure credentials are forbidden in synthetic mode.");
    }
  },
}));
vi.mock("@azure/storage-file-datalake", () => ({
  DataLakeServiceClient: class {
    constructor() {
      throw new Error("OneLake is forbidden in synthetic mode.");
    }
  },
}));
vi.mock("azure-kusto-data", () => ({
  Client: class {
    constructor() {
      throw new Error("Kusto is forbidden in synthetic mode.");
    }
  },
  ClientRequestProperties: class {},
  KustoConnectionStringBuilder: {},
}));

describe("synthetic insights provider", () => {
  beforeEach(() => {
    vi.stubEnv("DEMO_PROFILE", "synthetic");
    vi.stubEnv("EVENTHOUSE_QUERY_URI", "");
    vi.stubEnv("EVENTHOUSE_DATABASE_NAME", "");
    vi.spyOn(https, "request").mockImplementation(() => {
      throw new Error("Outbound HTTPS is forbidden.");
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("Outbound fetch is forbidden.");
      }),
    );
    resetRealtimeInsightsClientForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetPrincipalAthleteMapCacheForTests();
    resetRealtimeInsightsClientForTests();
  });

  it("returns deterministic derived analyses and alerts without credentials or network", async () => {
    const first = createRealtimeInsightsService();
    const analyses = await first.getAnalyses(SYNTHETIC_ATHLETE_ID);
    const alerts = await first.getActiveAlerts(SYNTHETIC_ATHLETE_ID);
    const second = createRealtimeInsightsService();
    expect(await second.getAnalyses(SYNTHETIC_ATHLETE_ID)).toEqual(analyses);
    expect(await second.getActiveAlerts(SYNTHETIC_ATHLETE_ID)).toEqual(alerts);
    expect(analyses.provenance).toMatchObject({ source: "synthetic", referenceDate: "2026-09-07" });
    expect(analyses.recoveryScore).toBeGreaterThan(0);
    expect(analyses.taperIndex).toBeLessThan(1);
    expect(analyses.nutritionAdequacy).toBeNull(); // Seed history has no live session.
    expect(alerts.alerts.length).toBeGreaterThan(0);
    for (const alert of alerts.alerts) {
      expect(alert.context.source).toBe("synthetic");
      expect(alert.alertId).toMatch(/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/);
      expect(["sustained-high-hr", "race-pace-drift"]).not.toContain(alert.type);
    }
    alerts.alerts.length = 0;
    if (analyses.provenance) {
      analyses.provenance.source = "synthetic";
      analyses.provenance.seed = 0;
    }
    expect(await first.getActiveAlerts(SYNTHETIC_ATHLETE_ID)).toEqual(
      await second.getActiveAlerts(SYNTHETIC_ATHLETE_ID),
    );
    expect((await first.getAnalyses(SYNTHETIC_ATHLETE_ID)).provenance?.seed).not.toBe(0);
    expect(https.request).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("computes workload and sleep from the real generator, not canned response constants", async () => {
    const dataset = generateSeedHistoryDataset({
      athleteId: SYNTHETIC_ATHLETE_ID,
      referenceDate: "2026-09-07",
      seed: 123,
    });
    const loads = new Map<string, number>();
    for (const session of dataset.sessions) {
      if (session.status === "completed" && session.rpe !== null) {
        const day = session.plannedDate.slice(0, 10);
        loads.set(day, (loads.get(day) ?? 0) + session.plannedDurationMinutes * session.rpe);
      }
    }
    const latest = [...loads.keys()].sort().at(-1)!;
    const avg = (days: number) => {
      const rows = [...loads].filter(
        ([date]) => Date.parse(date) > Date.parse(latest) - days * 86_400_000,
      );
      return rows.reduce((sum, [, load]) => sum + load, 0) / rows.length;
    };
    const analyses = await new SyntheticInsightsService({ seed: 123 }).getAnalyses(
      SYNTHETIC_ATHLETE_ID,
    );
    expect(analyses.acuteChronicWorkloadRatio).toBe(Math.round((avg(7) / avg(28)) * 100) / 100);
    const sleep = dataset.sleepSessions.slice(-7);
    const sleepAvg =
      Math.round((sleep.reduce((sum, row) => sum + row.totalSleepMinutes, 0) / 7) * 10) / 10;
    expect(analyses.sleepDebtMinutes).toBe(Math.round((480 - sleepAvg) * 10) / 10);
    expect(analyses).not.toEqual(
      await new SyntheticInsightsService({ seed: 124 }).getAnalyses(SYNTHETIC_ATHLETE_ID),
    );
  });

  it("rejects unknown athletes and invalid dataset inputs explicitly", async () => {
    const service = createRealtimeInsightsService();
    await expect(service.getAnalyses("someone-else")).rejects.toThrow("not present");
    await expect(service.getActiveAlerts("someone-else")).rejects.toThrow("not present");
    expect(() => new SyntheticInsightsService({ referenceDate: "2026-02-30" })).toThrow(
      "referenceDate",
    );
    expect(() => new SyntheticInsightsService({ seed: -1 })).toThrow("seed");
  });

  it("matches analytical formulas and inclusive alert thresholds on a controlled snapshot", async () => {
    const dataset = generateSeedHistoryDataset({
      athleteId: SYNTHETIC_ATHLETE_ID,
      referenceDate: "2026-09-07",
      seed: 123,
    });
    const session = dataset.sessions[0];
    dataset.sessions = [
      {
        ...session,
        sessionId: "peak-1",
        plannedDate: "2026-08-11T00:00:00Z",
        status: "completed",
        plannedDurationMinutes: 100,
        rpe: 1,
      },
      {
        ...session,
        sessionId: "peak-2",
        plannedDate: "2026-08-25T00:00:00Z",
        status: "completed",
        plannedDurationMinutes: 100,
        rpe: 2,
      },
      {
        ...session,
        sessionId: "taper",
        plannedDate: "2026-09-07T00:00:00Z",
        status: "completed",
        plannedDurationMinutes: 100,
        rpe: 6,
      },
      {
        ...session,
        sessionId: "live",
        plannedDate: "2026-09-07T06:00:00Z",
        status: "live",
        plannedDurationMinutes: 60,
        rpe: 8,
      },
      { ...session, sessionId: "overdue", plannedDate: "2026-09-05T00:00:00Z", status: "planned" },
      {
        ...session,
        sessionId: "not-overdue",
        plannedDate: "2026-09-05T00:10:00Z",
        status: "missed",
      },
    ];
    dataset.phases = [
      { ...dataset.phases[0], phase: "Peak", startDate: "2026-08-01", endDate: "2026-08-31" },
      { ...dataset.phases[0], phase: "Taper", startDate: "2026-09-01", endDate: "2026-09-07" },
    ];
    dataset.recoveryMetrics = [
      {
        ...dataset.recoveryMetrics[0],
        date: "2026-09-06",
        hrv: 50,
        restingHeartRate: 50,
        sleepScore: 80,
        sorenessScore: 2,
      },
      {
        ...dataset.recoveryMetrics[0],
        date: "2026-09-07",
        hrv: 50,
        restingHeartRate: 50,
        sleepScore: 80,
        sorenessScore: 2,
      },
    ];
    dataset.sleepSessions = [
      { ...dataset.sleepSessions[0], date: "2026-08-31", totalSleepMinutes: 1 },
      { ...dataset.sleepSessions[0], date: "2026-09-06", totalSleepMinutes: 480 },
      { ...dataset.sleepSessions[0], date: "2026-09-07", totalSleepMinutes: 420 },
    ];
    dataset.nutritionLogs = [
      { ...dataset.nutritionLogs[0], date: "2026-09-07T05:00:00Z", carbsGrams: 44 },
      { ...dataset.nutritionLogs[0], date: "2026-09-07T02:00:00Z", carbsGrams: 500 },
    ];
    vi.mocked(generateSeedHistoryDataset).mockReturnValueOnce(dataset);
    const service = new SyntheticInsightsService({ seed: 123 });
    expect(await service.getAnalyses(SYNTHETIC_ATHLETE_ID)).toMatchObject({
      acuteChronicWorkloadRatio: 2,
      recoveryScore: 63.5,
      sleepDebtMinutes: 30,
      taperIndex: 4,
      nutritionAdequacy: 0.49,
      asOf: "2026-09-07T06:00:00.000Z",
    });
    const { alerts } = await service.getActiveAlerts(SYNTHETIC_ATHLETE_ID);
    expect(alerts.map((alert) => alert.type).sort()).toEqual([
      "acwr",
      "fueling-shortfall",
      "missed-session",
    ]);
    expect(alerts.find((alert) => alert.type === "missed-session")?.context).toMatchObject({
      sessionId: "overdue",
      overdueHours: 48,
    });
    expect(alerts.find((alert) => alert.type === "fueling-shortfall")?.context).toMatchObject({
      recentCarbsGrams: 44,
      estimatedCarbDemandGrams: 90,
      adequacyRatio: 0.49,
    });

    dataset.nutritionLogs[0].carbsGrams = 45;
    vi.mocked(generateSeedHistoryDataset).mockReturnValueOnce(dataset);
    expect(
      (await new SyntheticInsightsService().getActiveAlerts(SYNTHETIC_ATHLETE_ID)).alerts.some(
        (alert) => alert.type === "fueling-shortfall",
      ),
    ).toBe(false);
    dataset.sessions[0].plannedDate = "2026-08-10T00:00:00Z";
    dataset.recoveryMetrics[0].hrv = 40;
    dataset.recoveryMetrics[1].hrv = 60;
    vi.mocked(generateSeedHistoryDataset).mockReturnValueOnce(dataset);
    const atUpperBoundary = new SyntheticInsightsService();
    expect(await atUpperBoundary.getAnalyses(SYNTHETIC_ATHLETE_ID)).toMatchObject({
      acuteChronicWorkloadRatio: 1.5,
      recoveryScore: 67.6,
    });
    expect(
      (await atUpperBoundary.getActiveAlerts(SYNTHETIC_ATHLETE_ID)).alerts.some(
        (alert) => alert.type === "acwr",
      ),
    ).toBe(false);
    dataset.sessions[0].plannedDate = "2026-08-11T00:00:00Z";
    dataset.sessions[1].plannedDurationMinutes = 175;
    dataset.sessions[1].rpe = 1;
    dataset.sessions[2].plannedDurationMinutes = 100;
    dataset.sessions[2].rpe = 1;
    vi.mocked(generateSeedHistoryDataset).mockReturnValueOnce(dataset);
    const atLowerBoundary = new SyntheticInsightsService();
    expect(
      (await atLowerBoundary.getAnalyses(SYNTHETIC_ATHLETE_ID)).acuteChronicWorkloadRatio,
    ).toBe(0.8);
    expect(
      (await atLowerBoundary.getActiveAlerts(SYNTHETIC_ATHLETE_ID)).alerts.some(
        (alert) => alert.type === "acwr",
      ),
    ).toBe(false);
    dataset.sessions[2].plannedDurationMinutes = 99;
    vi.mocked(generateSeedHistoryDataset).mockReturnValueOnce(dataset);
    expect(
      (await new SyntheticInsightsService().getActiveAlerts(SYNTHETIC_ATHLETE_ID)).alerts.some(
        (alert) => alert.type === "acwr",
      ),
    ).toBe(true);
  });

  it("returns null rather than invented numbers for unavailable analytical inputs", async () => {
    const dataset = generateSeedHistoryDataset({
      athleteId: SYNTHETIC_ATHLETE_ID,
      referenceDate: "2026-09-07",
    });
    dataset.sessions = [];
    dataset.recoveryMetrics = [];
    dataset.sleepSessions = [];
    vi.mocked(generateSeedHistoryDataset).mockReturnValueOnce(dataset);
    const service = new SyntheticInsightsService();
    expect(await service.getAnalyses(SYNTHETIC_ATHLETE_ID)).toMatchObject({
      acuteChronicWorkloadRatio: null,
      recoveryScore: null,
      sleepDebtMinutes: null,
      taperIndex: null,
      nutritionAdequacy: null,
      asOf: null,
    });
    expect((await service.getActiveAlerts(SYNTHETIC_ATHLETE_ID)).alerts).toEqual([]);
  });

  it("never falls back to synthetic data by default or on live failures", async () => {
    expect(resolveRuntimeProfile({})).toBe("live");
    expect(resolveRuntimeProfile({ DEMO_PROFILE: "live" })).toBe("live");
    for (const value of ["", "true", "Synthetic", " synthetic ", "demo"]) {
      expect(() => resolveRuntimeProfile({ DEMO_PROFILE: value })).toThrow("DEMO_PROFILE");
    }
    vi.stubEnv("DEMO_PROFILE", "live");
    expect(() => createRealtimeInsightsService()).toThrow("Azure credentials are forbidden");
    const live = createRealtimeInsightsService({
      queryExecutor: {
        queryRows: vi.fn(async () => {
          throw new Error("Eventhouse denied");
        }),
      },
    });
    await expect(live.getAnalyses(SYNTHETIC_ATHLETE_ID)).rejects.toThrow("Eventhouse denied");
  });

  it("rejects mixing a live executor with the synthetic profile", () => {
    expect(() =>
      createRealtimeInsightsService({
        queryExecutor: { queryRows: vi.fn(async () => []) },
      }),
    ).toThrow("live query executor");
  });

  it("serves the existing REST routes with provenance while preserving authorization and error behavior", async () => {
    const principal = "22222222-2222-4222-8222-222222222222";
    vi.stubEnv("ATHLETE_PRINCIPAL_MAP", JSON.stringify({ [principal]: SYNTHETIC_ATHLETE_ID }));
    resetPrincipalAthleteMapCacheForTests();
    const app = express();
    app.use("/api/analyses", createAnalysesRouter());
    app.use("/api/alerts", createAlertsRouter());
    for (const route of ["analyses", "alerts"]) {
      const path = `/api/${route}/${SYNTHETIC_ATHLETE_ID}`;
      expect((await request(app).get(path)).status).toBe(403);
      const response = await request(app).get(path).set("x-ms-client-principal-id", principal);
      expect(response.status).toBe(200);
      expect(response.body.provenance.source).toBe("synthetic");
      expect(
        (await request(app).get(`/api/${route}/unknown`).set("x-ms-client-principal-id", principal))
          .status,
      ).toBe(403);
    }
    expect(
      (
        await request(app)
          .get(`/api/alerts/${SYNTHETIC_ATHLETE_ID}?active=false`)
          .set("x-ms-client-principal-id", principal)
      ).status,
    ).toBe(400);
    vi.stubEnv("DEMO_PROFILE", "invalid");
    const failingApp = express();
    failingApp.use("/api/analyses", createAnalysesRouter());
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await request(failingApp)
      .get(`/api/analyses/${SYNTHETIC_ATHLETE_ID}`)
      .set("x-ms-client-principal-id", principal);
    expect(failed.status).toBe(500);
    expect(failed.body.error.code).toBe("analyses_query_failed");
    expect(log).toHaveBeenCalled();
  });

  it("uses the synthetic provider in the existing alert listener even with live configuration present", async () => {
    vi.stubEnv("EVENTHOUSE_QUERY_URI", "https://example.invalid");
    vi.stubEnv("EVENTHOUSE_DATABASE_NAME", "unused");
    const broker = new RealtimeStreamBroker();
    const events = vi.fn();
    broker.subscribe(events);
    const listener = createDefaultAlertListener({
      athleteIds: [SYNTHETIC_ATHLETE_ID],
      streamBroker: broker,
    });
    expect(listener).toBeDefined();
    await listener!.pollNow();
    expect(events).toHaveBeenCalled();
    expect(events.mock.calls[0][0].frame.alert.context.source).toBe("synthetic");
    events.mockClear();
    await listener!.pollNow();
    expect(events).not.toHaveBeenCalled();
  });
});
