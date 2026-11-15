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
  it("forwards only bounded same-origin demo questions, never visitor auth or chosen scope", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    const app = express();
    app.use(express.json());
    app.use(
      "/api/mining",
      createMiningRouter(
        {
          streamingBackendBaseUrl: "https://internal.example",
          fetchImpl,
          buildAuthHeaders: async () => ({ authorization: "Bearer service" }),
        },
        false,
        true,
        true,
      ),
    );
    const ask = () => request(app).post("/api/mining/demo/assistant").set("host", "demo.example");
    const body = { plantId: "D01", question: "Is Line B slower?" };
    expect((await ask().set("origin", "https://attacker.example").send(body)).status).toBe(403);
    expect(
      (
        await ask()
          .set("origin", "https://demo.example")
          .send({ ...body, runId: "other" })
      ).status,
    ).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    const response = await ask()
      .set("origin", "https://demo.example")
      .set("authorization", "Bearer attacker")
      .send(body);
    expect(response.status).toBe(200);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://internal.example/api/mining/demo/assistant");
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer service");
    expect(JSON.parse(String(options?.body))).toEqual(body);
    for (let i = 0; i < 5; i++) {
      expect((await ask().set("origin", "https://demo.example").send(body)).status).toBe(200);
    }
    expect((await ask().set("origin", "https://demo.example").send(body)).status).toBe(429);
  });
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

  it("forwards only bounded same-origin demo actions with server credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ runId: "11111111-1111-4111-8111-111111111111" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );
    const app = express();
    app.use(express.json());
    app.use(
      "/api/mining",
      createMiningRouter(
        {
          streamingBackendBaseUrl: "https://internal.example",
          fetchImpl,
          buildAuthHeaders: async () => ({ authorization: "Bearer service" }),
        },
        false,
        true,
      ),
    );
    const post = () => request(app).post("/api/mining/demo/runs/start").set("host", "demo.example");
    expect(
      (await post().set("origin", "https://attacker.example").send({ plantId: "D01" })).status,
    ).toBe(403);
    expect(
      (
        await post()
          .set("origin", "https://demo.example")
          .send({ plantId: "D01", durationSeconds: 1800 })
      ).status,
    ).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    const response = await post()
      .set("origin", "https://demo.example")
      .set("authorization", "Bearer attacker")
      .send({ plantId: "D01" });
    expect(response.status).toBe(202);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://internal.example/api/mining/demo/runs/start");
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer service");
    expect(options?.body).toBe(JSON.stringify({ plantId: "D01" }));
    for (let i = 0; i < 4; i++) {
      expect(
        (await post().set("origin", "https://demo.example").send({ plantId: "D01" })).status,
      ).toBe(202);
    }
    expect(
      (await post().set("origin", "https://demo.example").send({ plantId: "D01" })).status,
    ).toBe(429);
    expect(
      (
        await request(app)
          .post("/api/mining/demo/runs/cancel")
          .set("host", "demo.example")
          .set("origin", "https://demo.example")
          .send({ plantId: "D01", runId: "11111111-1111-4111-8111-111111111111" })
      ).status,
    ).toBe(202);
  });

  it("uses the demo read path only when explicitly enabled", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    const app = express();
    app.use(
      "/api/mining",
      createMiningRouter(
        {
          streamingBackendBaseUrl: "https://internal.example",
          fetchImpl,
          buildAuthHeaders: async () => ({ authorization: "Bearer service" }),
        },
        false,
        true,
        true,
      ),
    );
    expect((await request(app).get("/api/mining/context")).status).toBe(200);
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      "https://internal.example/api/mining/demo/context?plantId=D01",
    );
    expect((await request(app).get("/api/mining/runs/status")).status).toBe(200);
    expect(String(fetchImpl.mock.calls[1][0])).toBe(
      "https://internal.example/api/mining/runs/status?plantId=D01",
    );
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
