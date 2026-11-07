import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createTriggerRaceAction, createTriggerSessionAction } from "../src/actions/trigger-session.js";

function buildApp(fetchImpl: typeof fetch, resolveDefaultAthleteId?: () => string | undefined) {
  const buildAuthHeaders = async () => ({
    "content-type": "application/json",
    authorization: "Bearer service-token-xyz",
  });
  const app = express();
  app.use(express.json());
  app.post(
    "/actions/trigger-session",
    createTriggerSessionAction({
      streamingBackendBaseUrl: "https://streaming-backend.example.internal",
      fetchImpl,
      resolveDefaultAthleteId,
      buildAuthHeaders,
    }),
  );
  app.post(
    "/actions/trigger-race",
    createTriggerRaceAction({
      streamingBackendBaseUrl: "https://streaming-backend.example.internal",
      fetchImpl,
      resolveDefaultAthleteId,
      buildAuthHeaders,
    }),
  );
  return app;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("POST /actions/trigger-session", () => {
  it("returns 400 when no athleteId is supplied and no default is configured", async () => {
    const fetchImpl = vi.fn();
    const app = buildApp(fetchImpl as unknown as typeof fetch, () => undefined);

    const res = await request(app).post("/actions/trigger-session").send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("missing_athlete_id");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("forwards to the streaming backend with a default discipline of 'run' and relays the response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(202, { status: "accepted" }));
    const app = buildApp(fetchImpl as unknown as typeof fetch, () => "athlete-123");

    const res = await request(app).post("/actions/trigger-session").send({});

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "accepted" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://streaming-backend.example.internal/api/simulate/trigger-session");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ athleteId: "athlete-123", discipline: "run" });
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer service-token-xyz");
  });

  it("forwards an explicit discipline from the request body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(202, { status: "accepted" }));
    const app = buildApp(fetchImpl as unknown as typeof fetch, () => "athlete-123");

    await request(app).post("/actions/trigger-session").send({ discipline: "bike" });

    const [, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ athleteId: "athlete-123", discipline: "bike" });
  });

  it("relays a non-2xx status from the streaming backend unchanged", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(409, { error: { code: "session_in_progress", message: "another session is live" } }),
    );
    const app = buildApp(fetchImpl as unknown as typeof fetch, () => "athlete-123");

    const res = await request(app).post("/actions/trigger-session").send({});

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("session_in_progress");
  });

  it("returns 502 when the streaming backend is unreachable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const app = buildApp(fetchImpl as unknown as typeof fetch, () => "athlete-123");

    const res = await request(app).post("/actions/trigger-session").send({});

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("streaming_backend_unreachable");
  });
});

describe("POST /actions/trigger-race", () => {
  it("returns 400 when raceId is missing, without calling the streaming backend", async () => {
    const fetchImpl = vi.fn();
    const app = buildApp(fetchImpl as unknown as typeof fetch, () => "athlete-123");

    const res = await request(app).post("/actions/trigger-race").send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("missing_race_id");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns 400 when no athleteId is supplied and no default is configured", async () => {
    const fetchImpl = vi.fn();
    const app = buildApp(fetchImpl as unknown as typeof fetch, () => undefined);

    const res = await request(app).post("/actions/trigger-race").send({ raceId: "race-1" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("missing_athlete_id");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("forwards raceId and athleteId to the streaming backend and relays the response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(202, { status: "accepted" }));
    const app = buildApp(fetchImpl as unknown as typeof fetch, () => "athlete-123");

    const res = await request(app).post("/actions/trigger-race").send({ raceId: "race-1" });

    expect(res.status).toBe(202);
    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://streaming-backend.example.internal/api/simulate/trigger-race");
    expect(JSON.parse(init.body as string)).toEqual({ athleteId: "athlete-123", raceId: "race-1" });
  });

  it("returns 502 when the streaming backend is unreachable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const app = buildApp(fetchImpl as unknown as typeof fetch, () => "athlete-123");

    const res = await request(app).post("/actions/trigger-race").send({ raceId: "race-1" });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("streaming_backend_unreachable");
  });
});
