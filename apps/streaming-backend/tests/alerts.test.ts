import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlertsRouter } from "../src/api/alerts.js";
import { resetPrincipalAthleteMapCacheForTests } from "../src/auth/authorization.js";
import { PollingAlertListener } from "../src/services/alert-listener.js";
import { RealtimeStreamBroker } from "../src/services/realtime-stream.js";
import type { ActiveAlert, ActiveAlertsResponse } from "../src/services/realtime-insights.js";

const ATHLETE_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ATHLETE_ID = "33333333-3333-3333-3333-333333333333";
const PRINCIPAL_ID = "22222222-2222-2222-2222-222222222222";

function buildAlert(alertId: string, type: ActiveAlert["type"], raisedAt: string): ActiveAlert {
  return {
    alertId,
    type,
    raisedAt,
    detail: `${type} detail`,
    context: {},
  };
}

function buildApp(alertsService: { getActiveAlerts: (athleteId: string) => Promise<ActiveAlertsResponse> }) {
  const app = express();
  app.use("/api/alerts", createAlertsRouter({ alertsService }));
  return app;
}

describe("GET /api/alerts/:athleteId", () => {
  beforeEach(() => {
    process.env.ATHLETE_PRINCIPAL_MAP = JSON.stringify({ [PRINCIPAL_ID]: ATHLETE_ID });
    resetPrincipalAthleteMapCacheForTests();
  });

  afterEach(() => {
    delete process.env.ATHLETE_PRINCIPAL_MAP;
    resetPrincipalAthleteMapCacheForTests();
  });

  it("returns active alerts for the authorized athlete", async () => {
    const alerts: ActiveAlertsResponse = {
      alerts: [
        buildAlert("alert-1", "acwr", "2026-09-04T06:30:00.000Z"),
        buildAlert("alert-2", "fueling-shortfall", "2026-09-04T06:32:00.000Z"),
      ],
    };
    const alertsService = {
      getActiveAlerts: vi.fn(async () => alerts),
    };
    const app = buildApp(alertsService);

    const res = await request(app)
      .get(`/api/alerts/${ATHLETE_ID}?active=true`)
      .set("x-ms-client-principal-id", PRINCIPAL_ID);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(alerts);
    expect(alertsService.getActiveAlerts).toHaveBeenCalledWith(ATHLETE_ID);
  });

  it("returns 403 Forbidden when the caller requests a different athleteId (FR-017)", async () => {
    const alertsService = {
      getActiveAlerts: vi.fn(async () => ({ alerts: [] })),
    };
    const app = buildApp(alertsService);

    const res = await request(app)
      .get(`/api/alerts/${OTHER_ATHLETE_ID}?active=true`)
      .set("x-ms-client-principal-id", PRINCIPAL_ID);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: { code: "forbidden", message: "Not authorized for this athlete." },
    });
    expect(alertsService.getActiveAlerts).not.toHaveBeenCalled();
  });

  it("returns 400 for unsupported alert filters", async () => {
    const alertsService = {
      getActiveAlerts: vi.fn(async () => ({ alerts: [] })),
    };
    const app = buildApp(alertsService);

    const res = await request(app)
      .get(`/api/alerts/${ATHLETE_ID}?active=false`)
      .set("x-ms-client-principal-id", PRINCIPAL_ID);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: "invalid_alert_filter",
        message: "Only ?active=true is currently supported.",
      },
    });
    expect(alertsService.getActiveAlerts).not.toHaveBeenCalled();
  });
});

describe("PollingAlertListener", () => {
  it("publishes only newly observed active alerts across poll cycles", async () => {
    const broker = new RealtimeStreamBroker();
    const published: ActiveAlert[] = [];
    const unsubscribe = broker.subscribe((event) => {
      if (event.frame.type === "alert") {
        published.push(event.frame.alert);
      }
    });

    const firstAlert = buildAlert("alert-1", "acwr", "2026-09-04T06:30:00.000Z");
    const secondAlert = buildAlert("alert-2", "missed-session", "2026-09-04T06:45:00.000Z");
    const alertsService = {
      getActiveAlerts: vi
        .fn<() => Promise<ActiveAlertsResponse>>()
        .mockResolvedValueOnce({ alerts: [firstAlert] })
        .mockResolvedValueOnce({ alerts: [firstAlert] })
        .mockResolvedValueOnce({ alerts: [firstAlert, secondAlert] }),
    };
    const listener = new PollingAlertListener(alertsService, [ATHLETE_ID], broker, 30_000);

    try {
      await listener.pollNow();
      await listener.pollNow();
      await listener.pollNow();
    } finally {
      unsubscribe();
      listener.stop();
    }

    expect(alertsService.getActiveAlerts).toHaveBeenCalledTimes(3);
    expect(published).toEqual([firstAlert, secondAlert]);
  });
});

