import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createSeedHistoryAction } from "../src/actions/seed-history.js";

function buildApp(fetchImpl: typeof fetch, resolveDefaultAthleteId?: () => string | undefined) {
  const buildAuthHeaders = async () => ({
    "content-type": "application/json",
    authorization: "Bearer service-token-xyz",
  });
  const app = express();
  app.use(express.json());
  app.post(
    "/actions/seed-history",
    createSeedHistoryAction({
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

describe("POST /actions/seed-history", () => {
  it("returns 400 when no athleteId is supplied and no default is configured", async () => {
    const fetchImpl = vi.fn();
    const app = buildApp(fetchImpl as unknown as typeof fetch, () => undefined);

    const res = await request(app).post("/actions/seed-history").send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("missing_athlete_id");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("forwards to the streaming backend using the default athleteId and relays the response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(202, { status: "accepted" }));
    const app = buildApp(fetchImpl as unknown as typeof fetch, () => "athlete-123");

    const res = await request(app).post("/actions/seed-history").send({});

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "accepted" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://streaming-backend.example.internal/api/simulate/seed-history");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ athleteId: "athlete-123" });
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer service-token-xyz");
  });

  it("prefers an explicit athleteId in the request body over the default", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(202, { status: "accepted" }));
    const app = buildApp(fetchImpl as unknown as typeof fetch, () => "default-athlete");

    await request(app).post("/actions/seed-history").send({ athleteId: "explicit-athlete" });

    const [, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ athleteId: "explicit-athlete" });
  });

  it("relays a non-2xx status from the streaming backend unchanged", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(403, { error: { code: "forbidden", message: "not your athlete" } }),
    );
    const app = buildApp(fetchImpl as unknown as typeof fetch, () => "athlete-123");

    const res = await request(app).post("/actions/seed-history").send({});

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it("returns 502 when the streaming backend is unreachable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const app = buildApp(fetchImpl as unknown as typeof fetch, () => "athlete-123");

    const res = await request(app).post("/actions/seed-history").send({});

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("streaming_backend_unreachable");
  });
});
