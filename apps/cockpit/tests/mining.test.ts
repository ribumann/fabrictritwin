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
  it("only forwards bounded connection requests through the enabled demo boundary", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
    const options = {
      streamingBackendBaseUrl: "https://internal.example",
      fetchImpl,
      buildAuthHeaders: async () => ({ authorization: "Bearer service" }),
    };
    const app = express();
    app.use("/api/mining", createMiningRouter(options, false, true, true));
    const query = new URLSearchParams({
      plantId: "D01",
      runId: "00000000-0000-4000-8000-000000000001",
      streamIds: "utility-A-fines,utility-B-fines",
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-01T00:15:00.000Z",
      windowSeconds: "30",
    });
    await request(app).get(`/api/mining/connection-trend?${query}`).expect(200);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/api/mining/demo/connection-trend?");
    query.delete("runId");
    await request(app).get(`/api/mining/connection-trend?${query}`).expect(200);
    expect(String(fetchImpl.mock.calls[1][0])).not.toContain("runId=");
    query.set("streamIds", "utility-A-fines,utility-A-fines");
    await request(app).get(`/api/mining/connection-trend?${query}`).expect(400);
    query.set("streamIds", "utility-A-fines");
    query.set("end", "2026-01-01T00:16:00.000Z");
    await request(app).get(`/api/mining/connection-trend?${query}`).expect(400);
    const disabled = express();
    disabled.use("/api/mining", createMiningRouter(options, false, true, false));
    await request(disabled)
      .get("/api/mining/connection-latest?plantId=D01&runId=00000000-0000-4000-8000-000000000001")
      .expect(503);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("relays a full ten-minute demo signal history but still bounds oversized upstream status", async () => {
    const runId = "00000000-0000-4000-8000-000000000001";
    const simulatorPreview = Array.from({ length: 120 }, (_, i) => ({
      runId,
      hopperTonnes: 780.1234,
      sampleTime: new Date(Date.UTC(2026, 0, 1) + (i + 1) * 5_000).toISOString(),
    }));
    const fabricSignal = simulatorPreview.map((point, i) => ({
      ...point,
      receivedAt: new Date(Date.parse(point.sampleTime) + 230).toISOString(),
      ...((i + 1) % 6 === 0 ? { avg30: 780.123456 } : {}),
      ...((i + 1) % 12 === 0 ? { avg60: 780.123456 } : {}),
    }));
    const status = {
      plantId: "D01",
      mode: "bounded",
      run: { runId, simulatorPreview, fabricSignal },
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(status))
      .mockResolvedValueOnce(Response.json({ unexpected: "x".repeat(65_536) }));
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
      ),
    );

    const reply = await request(app).get("/api/mining/demo/runs/status").expect(200);
    expect(reply.body).toEqual(status);
    await request(app).get("/api/mining/demo/runs/status").expect(502);
  });

  it("proxies only a bounded, run-free cross-run request to the authenticated demo service", async () => {
    const buildAuthHeaders = vi.fn(async () => ({ authorization: "Bearer service" }));
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async (url) =>
          new Response(
            String(url).includes("/context?")
              ? JSON.stringify({ mode: "continuous", capabilities: { trends: true } })
              : "{}",
          ),
      );
    const app = express();
    app.use(
      "/api/mining",
      createMiningRouter(
        {
          streamingBackendBaseUrl: "https://internal.example",
          fetchImpl,
          buildAuthHeaders,
        },
        false,
        true,
        true,
      ),
    );
    const query =
      "start=2026-01-01T00:00:00.000Z&end=2026-01-02T00:00:00.000Z&binMinutes=5&metric=feed";
    expect((await request(app).get(`/api/mining/cross-run-trends?${query}`)).status).toBe(200);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/api/mining/demo/context?");
    expect(String(fetchImpl.mock.calls[1][0])).toContain("/api/mining/demo/cross-run-trends?");
    expect(String(fetchImpl.mock.calls[1][0])).not.toContain("runId");
    expect(fetchImpl.mock.calls[0][1]?.signal).toBe(fetchImpl.mock.calls[1][1]?.signal);
    expect(buildAuthHeaders).toHaveBeenCalledTimes(1);
    expect(
      (await request(app).get(`/api/mining/cross-run-trends?${query}&runId=other`)).status,
    ).toBe(400);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("uses one deadline for stalled authentication, capability and trend response bodies", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const query =
      "start=2026-01-01T00:00:00.000Z&end=2026-01-01T01:00:00.000Z&binMinutes=5&metric=feed";
    const stalledBody = (cancel: ReturnType<typeof vi.fn>) =>
      new Response(new ReadableStream({ cancel }));
    const capabilityCancelled = vi.fn();
    const trendCancelled = vi.fn();
    const capabilityFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(stalledBody(capabilityCancelled));
    const trendFetch = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).includes("/context?")) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return new Response(JSON.stringify({ mode: "continuous", capabilities: { trends: true } }));
      }
      return stalledBody(trendCancelled);
    });
    const authFetch = vi.fn<typeof fetch>();
    const authAborted = vi.fn();
    const makeApp = (
      fetchImpl: typeof fetch,
      buildAuthHeaders: (signal?: AbortSignal) => Promise<Record<string, string>>,
    ) => {
      const app = express();
      app.use(
        "/api/mining",
        createMiningRouter(
          {
            streamingBackendBaseUrl: "https://internal.example",
            fetchImpl,
            buildAuthHeaders,
          },
          false,
          true,
          true,
        ),
      );
      return app;
    };
    const auth = async () => ({ authorization: "Bearer service" });
    const started = Date.now();
    const responses = await Promise.all([
      request(
        makeApp(
          authFetch,
          (signal) =>
            new Promise((_resolve, reject) => {
              signal?.addEventListener(
                "abort",
                () => {
                  authAborted();
                  reject(new Error("cancelled"));
                },
                { once: true },
              );
            }),
        ),
      ).get(`/api/mining/cross-run-trends?${query}`),
      request(makeApp(capabilityFetch, auth)).get(`/api/mining/cross-run-trends?${query}`),
      request(makeApp(trendFetch, auth)).get(`/api/mining/cross-run-trends?${query}`),
    ]);
    expect(responses.map((response) => response.status)).toEqual([504, 504, 504]);
    expect(Date.now() - started).toBeLessThan(10_500);
    expect(authFetch).not.toHaveBeenCalled();
    expect(authAborted).toHaveBeenCalledTimes(1);
    expect(capabilityFetch).toHaveBeenCalledTimes(1);
    expect(trendFetch).toHaveBeenCalledTimes(2);
    expect(trendFetch.mock.calls[0][1]?.signal).toBe(trendFetch.mock.calls[1][1]?.signal);
    expect(capabilityCancelled).toHaveBeenCalledTimes(1);
    expect(trendCancelled).toHaveBeenCalledTimes(1);
  }, 13_000);
  it.each(["capability", "trend"])(
    "aborts the %s request when the browser disconnects",
    async (stage) => {
      let notifyStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      let activeSignal: AbortSignal | undefined;
      let finishLate: (() => void) | undefined;
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
        if (stage === "trend" && String(url).includes("/context?"))
          return new Response(
            JSON.stringify({ mode: "continuous", capabilities: { trends: true } }),
          );
        activeSignal = init?.signal ?? undefined;
        notifyStarted();
        if (stage === "capability") {
          return new Promise<Response>((resolve) => {
            finishLate = () =>
              resolve(
                new Response(
                  JSON.stringify({ mode: "continuous", capabilities: { trends: true } }),
                ),
              );
          });
        }
        return new Promise<Response>((_resolve, reject) => {
          activeSignal?.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          });
        });
      });
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
      const query =
        "start=2026-01-01T00:00:00.000Z&end=2026-01-01T01:00:00.000Z&binMinutes=5&metric=feed";
      const client = request(app).get(`/api/mining/cross-run-trends?${query}`);
      client.end(() => {});
      await started;
      const aborted = new Promise<void>((resolve) =>
        activeSignal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      client.abort();
      await aborted;
      finishLate?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(activeSignal?.aborted).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(stage === "trend" ? 2 : 1);
    },
  );
  it.each([
    { mode: "continuous", capabilities: { trends: false } },
    { mode: "continuous", capabilities: {} },
    { mode: "bounded", capabilities: { trends: true } },
  ])(
    "does not forward cross-run requests when the backend does not advertise them",
    async (context) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => new Response(JSON.stringify(context)));
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
      const query =
        "start=2026-01-01T00:00:00.000Z&end=2026-01-01T01:00:00.000Z&binMinutes=5&metric=feed";
      expect((await request(app).get(`/api/mining/cross-run-trends?${query}`)).status).toBe(503);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(String(fetchImpl.mock.calls[0][0])).toContain("/api/mining/demo/context?");
    },
  );
  it.each([
    { label: "malformed", body: "not-json" },
    { label: "too large", body: "x".repeat(16_385) },
  ])("fails closed when the capability response is $label", async ({ body }) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(body));
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
    const query =
      "start=2026-01-01T00:00:00.000Z&end=2026-01-01T01:00:00.000Z&binMinutes=5&metric=feed";
    expect((await request(app).get(`/api/mining/cross-run-trends?${query}`)).status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
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
    expect(mining.text).toContain('<a href="/">Triathlon dashboard</a>');
    expect(triathlon.status).toBe(200);
    expect(triathlon.text).toContain("Triathlon Training Twin");
    expect(triathlon.text).toContain('<a href="/mining/">Mining dashboard</a>');
    expect(triathlon.text).toContain('id="simulation-form"');
    expect(triathlon.text).toContain('class="alerts-summary"');
    expect(triathlon.text).not.toContain("/mining/app.js");
  });
});
