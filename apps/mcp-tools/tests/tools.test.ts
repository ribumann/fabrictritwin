import { describe, expect, it, vi } from "vitest";
import type {
  ActiveAlertsToolResponse,
  RaceSplitsResponse,
  RecoveryTrendResponse,
  ToolErrorResponse,
  TrainingLoadResponse,
} from "../src/models.js";
import type { AthleteAssistantDataService } from "../src/services/athlete-assistant-data.js";
import { AUTHORIZED_ATHLETE_HEADER } from "../src/tool-context.js";
import { executeQueryActiveAlertsTool } from "../src/tools/query-active-alerts.js";
import { executeQueryRaceSplitsTool } from "../src/tools/query-race-splits.js";
import { executeQueryRecoveryTrendTool } from "../src/tools/query-recovery-trend.js";
import { executeQueryTrainingLoadTool } from "../src/tools/query-training-load.js";

const ATHLETE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ATHLETE_ID = "33333333-3333-4333-8333-333333333333";

function buildExtra(athleteId = ATHLETE_ID) {
  return {
    requestInfo: {
      headers: {
        [AUTHORIZED_ATHLETE_HEADER]: athleteId,
      },
    },
  };
}

function buildDataService(overrides: Partial<AthleteAssistantDataService>): AthleteAssistantDataService {
  return {
    getRecoveryTrend: vi.fn(async () => ({ trend: [] })),
    getTrainingLoad: vi.fn(async () => ({
      currentPhase: "Build",
      acwr: 1.02,
      recentSessions: [],
    })),
    getActiveAlerts: vi.fn(async () => ({ alerts: [] })),
    getRaceSplits: vi.fn(async () => ({ splits: [], projectedFinishTimeSeconds: 0 })),
    ...overrides,
  };
}

describe("query_recovery_trend", () => {
  it("returns the recovery trend for the authorized athlete", async () => {
    const expected: RecoveryTrendResponse = {
      trend: [{ date: "2026-09-04", recoveryScore: 82.4, sleepDebtMinutes: 18.6, hrv: 71 }],
    };
    const dataService = buildDataService({
      getRecoveryTrend: vi.fn(async () => expected),
    });

    const result = await executeQueryRecoveryTrendTool(
      { athleteId: ATHLETE_ID, days: 7 },
      buildExtra(),
      dataService,
    );

    expect(result).toEqual(expected);
    expect(dataService.getRecoveryTrend).toHaveBeenCalledWith(ATHLETE_ID, 7);
  });

  it("rejects a mismatched caller-supplied athleteId per FR-017", async () => {
    const dataService = buildDataService({});

    const result = (await executeQueryRecoveryTrendTool(
      { athleteId: OTHER_ATHLETE_ID, days: 7 },
      buildExtra(),
      dataService,
    )) as ToolErrorResponse;

    expect(result).toEqual({ error: "Not authorized for this athlete." });
    expect(dataService.getRecoveryTrend).not.toHaveBeenCalled();
  });
});

describe("query_training_load", () => {
  it("returns the current phase, acwr, and recent sessions", async () => {
    const expected: TrainingLoadResponse = {
      currentPhase: "Peak",
      acwr: 1.18,
      recentSessions: [
        {
          sessionId: "session-1",
          date: "2026-09-03",
          discipline: "bike",
          durationMinutes: 90,
          rpe: 7,
          maxHeartRate: 174,
        },
      ],
    };
    const dataService = buildDataService({
      getTrainingLoad: vi.fn(async () => expected),
    });

    const result = await executeQueryTrainingLoadTool({ athleteId: ATHLETE_ID }, buildExtra(), dataService);

    expect(result).toEqual(expected);
    expect(dataService.getTrainingLoad).toHaveBeenCalledWith(ATHLETE_ID);
  });
});

describe("query_active_alerts", () => {
  it("returns active alerts for the authorized athlete", async () => {
    const expected: ActiveAlertsToolResponse = {
      alerts: [
        {
          alertId: "alert-1",
          type: "acwr",
          raisedAt: "2026-09-04T06:30:00.000Z",
          detail: "Acute:Chronic Workload Ratio is 1.6.",
        },
      ],
    };
    const dataService = buildDataService({
      getActiveAlerts: vi.fn(async () => expected),
    });

    const result = await executeQueryActiveAlertsTool({ athleteId: ATHLETE_ID }, buildExtra(), dataService);

    expect(result).toEqual(expected);
    expect(dataService.getActiveAlerts).toHaveBeenCalledWith(ATHLETE_ID);
  });
});

describe("query_race_splits", () => {
  it("returns race splits and projected finish time", async () => {
    const expected: RaceSplitsResponse = {
      splits: [
        {
          leg: "run",
          timestamp: "2026-09-04T08:30:00.000Z",
          currentPaceSecPerKm: 248.4,
          plannedPaceSecPerKm: 245,
          currentHeartRate: 168,
        },
      ],
      projectedFinishTimeSeconds: 8_620,
    };
    const dataService = buildDataService({
      getRaceSplits: vi.fn(async () => expected),
    });

    const result = await executeQueryRaceSplitsTool(
      { athleteId: ATHLETE_ID, raceId: "race-1" },
      buildExtra(),
      dataService,
    );

    expect(result).toEqual(expected);
    expect(dataService.getRaceSplits).toHaveBeenCalledWith(ATHLETE_ID, "race-1");
  });
});
