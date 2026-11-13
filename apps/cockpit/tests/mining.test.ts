import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createMiningRouter } from "../src/mining/router.js";

function harness(fetchImpl = vi.fn<typeof fetch>()) {
  const headers = vi.fn(async () => ({ authorization: "Bearer viewer-scoped" }));
  const app = express();
  app.use(express.json());
  app.use(
    "/api/mining",
    createMiningRouter({
      streamingBackendBaseUrl: "https://internal.example",
      fetchImpl,
      buildAuthHeaders: headers,
    }),
  );
  return { app, fetchImpl, headers };
}
afterEach(() => vi.restoreAllMocks());

describe("isolated mining BFF", () => {
  it("uses only server auth and constructed bounded query fields", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ plantId: "D01" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const { app } = harness(fetchImpl);
    const result = await request(app)
      .get("/api/mining/overview?runId=approved")
      .set("authorization", "Bearer attacker")
      .set("x-ms-client-principal", "spoof");
    expect(result.status).toBe(200);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(
      "https://internal.example/api/mining/overview?runId=approved&plantId=D01",
    );
    expect(options?.headers).toEqual({ authorization: "Bearer viewer-scoped" });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(result.headers["cache-control"]).toBe("no-store");
  });

  it.each([
    "?plantId=other",
    "?athleteId=athlete",
    "?query=print%201",
    "?runId=a&runId=b",
    "?moduleId=athlete.module",
    "?metric=arbitrary",
    "?maxRows=1001",
    "?maxRows=0",
    "?binMinutes=60",
    "?start=2026-01-01T00:00:00Z&end=2026-01-02T00:00:01Z",
    "?start=2026-01-01T00:00:00Z",
    "?start=2026-01-01T00:00:00Z&end=2025-01-01T00:00:00Z",
    "?asOf=2026-01-01",
  ])("rejects unsafe inputs without contacting upstream: %s", async (query) => {
    const { app, fetchImpl, headers } = harness();
    expect((await request(app).get(`/api/mining/overview${query}`)).status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(headers).not.toHaveBeenCalled();
  });

  it.each(["start", "end", "binMinutes", "metric", "maxRows", "moduleId"])(
    "requires the explicit trend bound/scope %s",
    async (field) => {
      const { app, fetchImpl } = harness();
      const query = new URLSearchParams({
        runId: "approved",
        moduleId: "D01.A.dms",
        start: "2026-01-01T00:00:00Z",
        end: "2026-01-02T00:00:00Z",
        binMinutes: "5",
        metric: "density",
        maxRows: "1000",
      });
      query.delete(field);
      expect((await request(app).get(`/api/mining/trends?${query}`)).status).toBe(400);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
  it("accepts bounded trends and rejects unbounded line comparison", async () => {
    const { app, fetchImpl } = harness(vi.fn<typeof fetch>().mockResolvedValue(new Response("{}")));
    const query =
      "runId=approved&moduleId=D01.A.dms&start=2026-01-01T00:00:00Z&end=2026-01-02T00:00:00Z&binMinutes=5&metric=density&maxRows=1000";
    expect((await request(app).get(`/api/mining/trends?${query}`)).status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await request(app).get("/api/mining/compare-lines?metric=feed")).status).toBe(400);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["runs/start", "runs/cancel", "assistant"])(
    "never forwards anonymous or claimed-human %s as the MI",
    async (route) => {
      const { app, fetchImpl, headers } = harness();
      const result = await request(app)
        .post(`/api/mining/${route}`)
        .set("x-ms-client-principal", "pretend-human")
        .send({ principal: "admin", plantId: "D01" });
      expect(result.status).toBe(503);
      expect(result.body.error.code).toBe("mining_delegated_boundary_required");
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(headers).not.toHaveBeenCalled();
    },
  );

  it("preserves upstream auth/query failures instead of returning healthy empty data", async () => {
    const { app } = harness(
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: "forbidden" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const result = await request(app).get("/api/mining/context");
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe("forbidden");
  });

  it("bounds a streamed response at 1 MiB", async () => {
    const { app } = harness(
      vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(1_048_577))),
    );
    const result = await request(app).get("/api/mining/context");
    expect(result.status).toBe(502);
    expect(result.body.error.message).toMatch(/byte limit/);
  });

  it("does not use synthetic athlete authorization for mining", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const app = express();
    app.use(
      "/api/mining",
      createMiningRouter({ streamingBackendBaseUrl: "https://internal.example", fetchImpl }, true),
    );
    expect((await request(app).get("/api/mining/context")).status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("serves separate mining and existing triathlon entry documents", async () => {
    const { app } = await import("../src/index.js");
    const mining = await request(app).get("/mining");
    const triathlon = await request(app).get("/");
    expect(mining.status).toBe(200);
    expect(mining.text).toContain("/mining/app.js");
    expect(mining.text).not.toContain('src="/app.js"');
    expect(triathlon.status).toBe(200);
    expect(triathlon.text).toContain("Triathlon Training Twin");
    expect(triathlon.text).toContain('id="simulation-form"');
    expect(triathlon.text).toContain('class="alerts-summary"');
    expect(triathlon.text).not.toContain("/mining/app.js");
  });
});
