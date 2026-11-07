import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createAssistantRouter } from "../src/api/assistant.js";

const AUTH_HEADERS = {
  authorization: "Bearer test-token",
  "content-type": "application/json",
};

function createFetchJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function buildApp(fetchImpl: typeof fetch) {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/assistant",
    createAssistantRouter({
      streamingBackendBaseUrl: "https://streaming-backend.internal",
      fetchImpl,
      buildAuthHeaders: async () => AUTH_HEADERS,
      buildUserAuthHeaders: () => AUTH_HEADERS,
      buildServiceAuthHeaders: async () => AUTH_HEADERS,
    }),
  );
  return app;
}

describe("POST /api/assistant/ask", () => {
  it("proxies a valid ask request to the Streaming Backend", async () => {
    const fetchMock = vi.fn(async () =>
      createFetchJsonResponse(200, {
        answer: "Recovery is trending up.",
        groundedOn: ["query_recovery_trend"],
        respondedInMs: 412,
      }),
    );
    const app = buildApp(fetchMock as typeof fetch);

    const res = await request(app)
      .post("/api/assistant/ask")
      .send({ athleteId: "athlete-123", question: "How is my recovery trending this week?" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      answer: "Recovery is trending up.",
      groundedOn: ["query_recovery_trend"],
      respondedInMs: 412,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://streaming-backend.internal/api/assistant/ask");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.headers).toBeInstanceOf(Headers);
    expect((init.headers as Headers).get("authorization")).toBe("Bearer test-token");
    expect(JSON.parse(init.body as string)).toEqual({
      athleteId: "athlete-123",
      question: "How is my recovery trending this week?",
    });
  });

  it("uses the managed-identity (service) auth path for a visitor who has not signed in", async () => {
    const fetchMock = vi.fn(async () =>
      createFetchJsonResponse(200, { answer: "ok", groundedOn: [], respondedInMs: 1 }),
    );
    const app = express();
    app.use(express.json());
    const buildUserAuthHeaders = vi.fn(() => AUTH_HEADERS);
    const buildServiceAuthHeadersMock = vi.fn(async () => AUTH_HEADERS);
    app.use(
      "/api/assistant",
      createAssistantRouter({
        streamingBackendBaseUrl: "https://streaming-backend.internal",
        fetchImpl: fetchMock as typeof fetch,
        buildUserAuthHeaders,
        buildServiceAuthHeaders: buildServiceAuthHeadersMock,
      }),
    );

    const res = await request(app)
      .post("/api/assistant/ask")
      .send({ athleteId: "athlete-123", question: "Recovery?" });

    expect(res.status).toBe(200);
    expect(buildServiceAuthHeadersMock).toHaveBeenCalledTimes(1);
    expect(buildUserAuthHeaders).not.toHaveBeenCalled();
  });

  it("uses the human sign-in auth path when EasyAuth headers are present", async () => {
    const fetchMock = vi.fn(async () =>
      createFetchJsonResponse(200, { answer: "ok", groundedOn: [], respondedInMs: 1 }),
    );
    const app = express();
    app.use(express.json());
    const buildUserAuthHeaders = vi.fn(() => AUTH_HEADERS);
    const buildServiceAuthHeadersMock = vi.fn(async () => AUTH_HEADERS);
    app.use(
      "/api/assistant",
      createAssistantRouter({
        streamingBackendBaseUrl: "https://streaming-backend.internal",
        fetchImpl: fetchMock as typeof fetch,
        buildUserAuthHeaders,
        buildServiceAuthHeaders: buildServiceAuthHeadersMock,
      }),
    );

    const res = await request(app)
      .post("/api/assistant/ask")
      .set("x-ms-token-aad-access-token", "visitor-token")
      .set("x-ms-client-principal-id", "11111111-1111-1111-1111-111111111111")
      .send({ athleteId: "athlete-123", question: "Recovery?" });

    expect(res.status).toBe(200);
    expect(buildUserAuthHeaders).toHaveBeenCalledTimes(1);
    expect(buildServiceAuthHeadersMock).not.toHaveBeenCalled();
  });

  it("returns 400 when athleteId or question is missing", async () => {
    const fetchMock = vi.fn();
    const app = buildApp(fetchMock as typeof fetch);

    const missingAthlete = await request(app)
      .post("/api/assistant/ask")
      .send({ question: "How is my recovery trending this week?" });
    const missingQuestion = await request(app)
      .post("/api/assistant/ask")
      .send({ athleteId: "athlete-123" });

    expect(missingAthlete.status).toBe(400);
    expect(missingAthlete.body).toEqual({
      error: {
        code: "invalid_request",
        message: "Request body must include athleteId and question.",
      },
    });
    expect(missingQuestion.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards a 403 from upstream unmodified", async () => {
    const fetchMock = vi.fn(async () =>
      createFetchJsonResponse(403, {
        error: {
          code: "forbidden",
          message: "Not authorized for this athlete.",
        },
      }),
    );
    const app = buildApp(fetchMock as typeof fetch);

    const res = await request(app)
      .post("/api/assistant/ask")
      .send({ athleteId: "athlete-123", question: "How is my recovery trending this week?" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: {
        code: "forbidden",
        message: "Not authorized for this athlete.",
      },
    });
  });

  it("forwards a 503 from upstream without crashing the router", async () => {
    const fetchMock = vi.fn(async () =>
      createFetchJsonResponse(503, {
        error: {
          code: "assistant_unavailable",
          message: "Athlete Assistant is temporarily unavailable.",
        },
      }),
    );
    const app = buildApp(fetchMock as typeof fetch);

    const res = await request(app)
      .post("/api/assistant/ask")
      .send({ athleteId: "athlete-123", question: "Am I ready for Sunday's race?" });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: {
        code: "assistant_unavailable",
        message: "Athlete Assistant is temporarily unavailable.",
      },
    });
  });

  it("preserves actionable JSON authentication errors from the backend", async () => {
    const body = { error: { code: "assistant_token_expired", canRefresh: true, message: "Refresh sign-in." } };
    const app = buildApp(vi.fn(async () => createFetchJsonResponse(401, body)));
    const res = await request(app).post("/api/assistant/ask")
      .send({ athleteId: "athlete-123", question: "Recovery?" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual(body);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("turns an EasyAuth redirect into sign-in required without following it", async () => {
    const app = buildApp(vi.fn(async () => new Response(null, {
      status: 302, headers: { location: "https://login.example.test/" },
    })));
    const res = await request(app).post("/api/assistant/ask")
      .send({ athleteId: "athlete-123", question: "Recovery?" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("assistant_authentication_required");
    expect(res.headers.location).toBeUndefined();
  });

  it("does not return raw proxy errors that might contain user tokens", async () => {
    const app = buildApp(vi.fn(async () => { throw new Error("secret-user-token"); }));
    const res = await request(app).post("/api/assistant/ask")
      .send({ athleteId: "athlete-123", question: "Recovery?" });
    expect(res.status).toBe(502);
    expect(res.text).not.toContain("secret-user-token");
  });
});

describe("POST /api/assistant/mcp-query", () => {
  it.each([
    [
      "query_recovery_trend",
      { athleteId: "athlete-123", days: 7 },
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "query_recovery_trend",
          arguments: { athleteId: "athlete-123", days: 7 },
        },
        id: 1,
      },
    ],
    [
      "query_race_splits",
      { athleteId: "athlete-123", raceId: "race-456" },
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "query_race_splits",
          arguments: { athleteId: "athlete-123", raceId: "race-456" },
        },
        id: 1,
      },
    ],
  ])(
    "builds the expected JSON-RPC tools/call payload for %s",
    async (tool, args, expectedRequest) => {
      const fetchMock = vi.fn(async () =>
        createFetchJsonResponse(200, {
          jsonrpc: "2.0",
          result: { ok: true },
          id: 1,
        }),
      );
      const app = buildApp(fetchMock as typeof fetch);

      const res = await request(app).post("/api/assistant/mcp-query").send({
        tool,
        arguments: args,
      });

      expect(res.status).toBe(200);
      const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(url.toString()).toBe("https://streaming-backend.internal/api/assistant/mcp");
      expect(JSON.parse(init.body as string)).toEqual(expectedRequest);
    },
  );

  it("returns 400 for an unknown tool name", async () => {
    const fetchMock = vi.fn();
    const app = buildApp(fetchMock as typeof fetch);

    const res = await request(app).post("/api/assistant/mcp-query").send({
      tool: "query_future_magic",
      arguments: { athleteId: "athlete-123" },
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: "invalid_request",
        message: "Request body must include a supported tool name and arguments object.",
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a clean proxy error response when the assistant bridge call fails", async () => {
    // UI-level isolation from the dashboard refresh Promise.allSettled block is verified manually;
    // this route test asserts assistant-specific failures degrade to a clean HTTP response.
    const fetchMock = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const app = buildApp(fetchMock as typeof fetch);

    const res = await request(app).post("/api/assistant/mcp-query").send({
      tool: "query_active_alerts",
      arguments: { athleteId: "athlete-123" },
    });

    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      error: {
        code: "assistant_mcp_query_proxy_failed",
        message: "connect ECONNREFUSED",
      },
    });
  });
});
