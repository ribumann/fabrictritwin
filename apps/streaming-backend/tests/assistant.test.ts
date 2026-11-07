import express from "express";
import type { Request } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProxyHeaders, createAssistantRouter } from "../src/api/assistant.js";
import { resetPrincipalAthleteMapCacheForTests } from "../src/auth/authorization.js";
import { verifyMcpCallerPrincipalId } from "../src/auth/mcp-caller.js";
import type {
  AssistantAskResponse,
  AthleteAssistantService,
} from "../src/services/athlete-assistant-agent.js";
import { AssistantUnavailableError } from "../src/services/athlete-assistant-agent.js";

// `/api/assistant/mcp` is excluded from Container Apps Easy Auth (see mcp-caller.ts's
// docstring for why) and instead verifies the caller's bearer token itself via a tenant
// JWKS fetch -- not something a unit test should do over the network. Mock the module so
// tests control the verified principal id directly, exactly like Easy-Auth-injected
// headers are used to emulate authenticated callers on the other (Easy-Auth-gated) routes.
vi.mock("../src/auth/mcp-caller.js", () => ({
  verifyMcpCallerPrincipalId: vi.fn(),
}));

const ATHLETE_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ATHLETE_ID = "33333333-3333-3333-3333-333333333333";
const PRINCIPAL_ID = "22222222-2222-2222-2222-222222222222";
const TENANT_ID = "44444444-4444-4444-4444-444444444444";
const BACKEND_CLIENT_ID = "55555555-5555-5555-5555-555555555555";
const COCKPIT_CLIENT_ID = "66666666-6666-6666-6666-666666666666";

// The test host emulates EasyAuth's verified identity; these are not real signed tokens.
function userToken(overrides: Record<string, unknown> = {}): string {
  const claims = {
    tid: TENANT_ID, oid: PRINCIPAL_ID, aud: BACKEND_CLIENT_ID, azp: COCKPIT_CLIENT_ID,
    iss: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
    scp: "user_impersonation", exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

function buildApp(assistantService: AthleteAssistantService) {
  const app = express();
  app.use(express.json());
  app.use("/api/assistant", createAssistantRouter({ assistantService }));
  return app;
}

describe("POST /api/assistant/ask", () => {
  beforeEach(() => {
    vi.stubEnv("ASSISTANT_AUTH_TENANT_ID", TENANT_ID);
    vi.stubEnv("ASSISTANT_AUTH_CLIENT_ID", BACKEND_CLIENT_ID);
    vi.stubEnv("ASSISTANT_AUTH_ALLOWED_CLIENT_ID", COCKPIT_CLIENT_ID);
    process.env.ATHLETE_PRINCIPAL_MAP = JSON.stringify({ [PRINCIPAL_ID]: ATHLETE_ID });
    resetPrincipalAthleteMapCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.ATHLETE_PRINCIPAL_MAP;
    resetPrincipalAthleteMapCacheForTests();
  });

  it("returns the assistant answer for the authorized athlete", async () => {
    const answer: AssistantAskResponse = {
      answer: "Your recovery has improved over the last week.",
      groundedOn: ["query_recovery_trend", "fabric_dataagent_preview"],
      respondedInMs: 824,
    };
    const assistantService: AthleteAssistantService = {
      askQuestion: vi.fn(async () => answer),
    };
    const app = buildApp(assistantService);

    const assertion = userToken();
    const res = await request(app)
      .post("/api/assistant/ask")
      .set("authorization", `Bearer ${assertion}`)
      .set("x-ms-client-principal-id", PRINCIPAL_ID)
      .send({ athleteId: ATHLETE_ID, question: "How is my recovery trending this week?" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(answer);
    expect(assistantService.askQuestion).toHaveBeenCalledWith(
      ATHLETE_ID,
      "How is my recovery trending this week?",
      { principalId: PRINCIPAL_ID, tenantId: TENANT_ID, userAssertionToken: assertion },
    );
  });

  it("returns 403 Forbidden when the caller requests a different athleteId (FR-017)", async () => {
    const assistantService: AthleteAssistantService = {
      askQuestion: vi.fn(async () => ({
        answer: "should not run",
        groundedOn: [],
        respondedInMs: 1,
      })),
    };
    const app = buildApp(assistantService);

    const res = await request(app)
      .post("/api/assistant/ask")
      .set("authorization", `Bearer ${userToken()}`)
      .set("x-ms-client-principal-id", PRINCIPAL_ID)
      .send({ athleteId: OTHER_ATHLETE_ID, question: "How is my recovery trending this week?" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: { code: "forbidden", message: "Not authorized for this athlete." },
    });
    expect(assistantService.askQuestion).not.toHaveBeenCalled();
  });

  it("returns 503 when the Foundry agent is unavailable", async () => {
    const assistantService: AthleteAssistantService = {
      askQuestion: vi.fn(async () => {
        throw new AssistantUnavailableError();
      }),
    };
    const app = buildApp(assistantService);

    const res = await request(app)
      .post("/api/assistant/ask")
      .set("authorization", `Bearer ${userToken()}`)
      .set("x-ms-client-principal-id", PRINCIPAL_ID)
      .send({ athleteId: ATHLETE_ID, question: "Am I ready for Sunday's race?" });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: {
        code: "assistant_unavailable",
        message: "Athlete Assistant is temporarily unavailable.",
      },
    });
  });

  it.each([
    ["wrong audience", { aud: "https://graph.microsoft.com" }],
    ["wrong tenant", { tid: "other-tenant" }],
    ["wrong issuer", { iss: "https://example.test/" }],
    ["unexpected caller app", { azp: "cli-client" }],
    ["different user", { oid: "another-user" }],
    ["missing required scope", { scp: "read" }],
    ["invalid expiry", { exp: "tomorrow" }],
    ["not yet valid", { nbf: Math.floor(Date.now() / 1000) + 3600 }],
  ])("rejects %s before invoking Foundry", async (_label, claims) => {
    const askQuestion = vi.fn();
    const res = await request(buildApp({ askQuestion })).post("/api/assistant/ask")
      .set("x-ms-client-principal-id", PRINCIPAL_ID)
      .set("authorization", `Bearer ${userToken(claims)}`)
      .send({ athleteId: ATHLETE_ID, question: "Recovery?" });
    expect(res.status).toBe(401);
    expect(askQuestion).not.toHaveBeenCalled();
  });

  it("proceeds anonymously (MI-mode, no Fabric Data Agent) when the caller presents no bearer assertion at all", async () => {
    const answer: AssistantAskResponse = {
      answer: "Your recovery has improved over the last week.",
      groundedOn: ["query_recovery_trend"],
      respondedInMs: 400,
    };
    const askQuestion = vi.fn(async () => answer);
    const res = await request(buildApp({ askQuestion })).post("/api/assistant/ask")
      .set("x-ms-client-principal-id", PRINCIPAL_ID)
      .send({ athleteId: ATHLETE_ID, question: "Recovery?" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(answer);
    expect(askQuestion).toHaveBeenCalledWith(ATHLETE_ID, "Recovery?", undefined);
  });

  it("proceeds anonymously (MI-mode) when the caller presents an app-only/service token", async () => {
    const answer: AssistantAskResponse = {
      answer: "Your recovery has improved over the last week.",
      groundedOn: ["query_recovery_trend"],
      respondedInMs: 400,
    };
    const askQuestion = vi.fn(async () => answer);
    const res = await request(buildApp({ askQuestion })).post("/api/assistant/ask")
      .set("x-ms-client-principal-id", PRINCIPAL_ID)
      .set("authorization", "Bearer " + userToken({ scp: undefined, idtyp: "app" }))
      .send({ athleteId: ATHLETE_ID, question: "Recovery?" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(answer);
    expect(askQuestion).toHaveBeenCalledWith(ATHLETE_ID, "Recovery?", undefined);
  });

  it("proceeds anonymously (MI-mode) when the token has neither idtyp nor scp (observed live managed-identity shape)", async () => {
    // Microsoft Entra ID does not reliably emit `idtyp` for app-only tokens against custom API
    // audiences -- confirmed absent on a live Cockpit managed-identity token during manual
    // testing. The only universally reliable app-only signal is the absence of `scp`.
    const answer: AssistantAskResponse = {
      answer: "Your recovery has improved over the last week.",
      groundedOn: ["query_recovery_trend"],
      respondedInMs: 400,
    };
    const askQuestion = vi.fn(async () => answer);
    const res = await request(buildApp({ askQuestion })).post("/api/assistant/ask")
      .set("x-ms-client-principal-id", PRINCIPAL_ID)
      .set("authorization", "Bearer " + userToken({ scp: undefined, idtyp: undefined }))
      .send({ athleteId: ATHLETE_ID, question: "Recovery?" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(answer);
    expect(askQuestion).toHaveBeenCalledWith(ATHLETE_ID, "Recovery?", undefined);
  });

  it("requests bounded refresh for expired user access tokens", async () => {
    const askQuestion = vi.fn();
    const res = await request(buildApp({ askQuestion })).post("/api/assistant/ask")
      .set("x-ms-client-principal-id", PRINCIPAL_ID)
      .set("authorization", `Bearer ${userToken({ exp: 1 })}`)
      .send({ athleteId: ATHLETE_ID, question: "Recovery?" });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: "assistant_token_expired", canRefresh: true });
    expect(askQuestion).not.toHaveBeenCalled();
  });

  it("fails closed when auth settings are absent", async () => {
    vi.stubEnv("ASSISTANT_AUTH_CLIENT_ID", "");
    const askQuestion = vi.fn();
    const res = await request(buildApp({ askQuestion })).post("/api/assistant/ask")
      .set("x-ms-client-principal-id", PRINCIPAL_ID)
      .set("authorization", `Bearer ${userToken()}`)
      .send({ athleteId: ATHLETE_ID, question: "Recovery?" });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("assistant_auth_configuration_error");
    expect(askQuestion).not.toHaveBeenCalled();
  });
});

describe("/api/assistant/mcp (FR-017 bridge)", () => {
  const assistantService: AthleteAssistantService = {
    askQuestion: vi.fn(),
  };
  const verifyMcpCallerPrincipalIdMock = vi.mocked(verifyMcpCallerPrincipalId);

  beforeEach(() => {
    process.env.ATHLETE_PRINCIPAL_MAP = JSON.stringify({ [PRINCIPAL_ID]: ATHLETE_ID });
    process.env.ATHLETE_ASSISTANT_MCP_INTERNAL_URL = "http://mcp-tools.internal/mcp";
    resetPrincipalAthleteMapCacheForTests();
    verifyMcpCallerPrincipalIdMock.mockReset();
  });

  afterEach(() => {
    delete process.env.ATHLETE_PRINCIPAL_MAP;
    delete process.env.ATHLETE_ASSISTANT_MCP_INTERNAL_URL;
    resetPrincipalAthleteMapCacheForTests();
    vi.unstubAllGlobals();
  });

  it("rejects with 403 and never calls upstream when the caller has no authorized athlete (impersonation attempt via query string)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    verifyMcpCallerPrincipalIdMock.mockResolvedValue(undefined);
    const app = buildApp(assistantService);

    // No verifiable bearer token at all -- a caller with no valid identity must not be able
    // to reach any athlete's data merely by supplying a query string.
    const res = await request(app)
      .post("/api/assistant/mcp")
      .query({ authorizedAthleteId: OTHER_ATHLETE_ID })
      .send({ jsonrpc: "2.0", method: "tools/list", id: 1 });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: { code: "forbidden", message: "Not authorized for this athlete." },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores any client-supplied authorizedAthleteId and forwards the verified-caller's athlete instead (FR-017 anti-impersonation)", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", result: {}, id: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    verifyMcpCallerPrincipalIdMock.mockResolvedValue(PRINCIPAL_ID);
    const app = buildApp(assistantService);

    const res = await request(app)
      .post("/api/assistant/mcp")
      // A caller authorized for ATHLETE_ID attempts to impersonate OTHER_ATHLETE_ID via the
      // query string; the resolved (verified-token-based) athlete must win, not the query
      // string.
      .query({ authorizedAthleteId: OTHER_ATHLETE_ID })
      .send({ jsonrpc: "2.0", method: "tools/list", id: 1 });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get("x-triatwin-authorized-athlete-id")).toBe(ATHLETE_ID);
  });

  it("always forwards a spec-compliant Accept header upstream, regardless of what the caller sent (406 regression)", async () => {
    // Live regression: Foundry's real MCP tool-enumeration callback does not always send an
    // `Accept` header satisfying the MCP Streamable HTTP transport's strict requirement for
    // BOTH `application/json` and `text/event-stream`, causing the upstream `mcp-tools`
    // server to reject the request with 406. Since this bridge fully controls both legs of
    // the proxy, it must normalize the Accept header on the outbound call rather than
    // forwarding whatever the original caller supplied (or omitted).
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", result: {}, id: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    verifyMcpCallerPrincipalIdMock.mockResolvedValue(PRINCIPAL_ID);
    const app = buildApp(assistantService);

    const res = await request(app)
      .post("/api/assistant/mcp")
      .set("Accept", "application/json")
      .send({ jsonrpc: "2.0", method: "tools/list", id: 1 });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get("accept")).toBe("application/json, text/event-stream");
  });

  it("never forwards the caller's transfer-encoding header upstream (undici fetch-failed regression)", () => {
    // Live regression: Foundry's real MCP tool-enumeration POST sends `Transfer-Encoding:
    // chunked` (its body is streamed, not a fixed-length buffer). This bridge re-serializes
    // the parsed body as a plain JSON string, so blindly forwarding that header onto the
    // outbound `fetch()` call is both incorrect (the outbound request isn't chunked) and
    // fatal: undici's fetch() throws `TypeError: fetch failed` (cause: "invalid
    // transfer-encoding header") synchronously if a caller manually sets this header,
    // before sending any bytes -- silently breaking every real Foundry callback while
    // manually-crafted test requests (which don't send a real chunked body, so exercising
    // this through the real HTTP layer is itself rejected upstream as a malformed request)
    // never reproduced it. Tested directly against `buildProxyHeaders` rather than through
    // supertest/superagent, which -- like most HTTP clients -- refuses to send a request
    // with both a computed Content-Length and a manually-set Transfer-Encoding header at
    // the same time (correctly, per HTTP/1.1), making this otherwise unreproducible
    // end-to-end in a unit test.
    const fakeReq = {
      headers: {
        "transfer-encoding": "chunked",
        "content-type": "application/json",
      },
    } as unknown as Request;

    const headers = buildProxyHeaders(fakeReq, PRINCIPAL_ID);

    expect(headers.has("transfer-encoding")).toBe(false);
  });

  it("returns 503 when the upstream MCP tool server is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    );
    verifyMcpCallerPrincipalIdMock.mockResolvedValue(PRINCIPAL_ID);
    const app = buildApp(assistantService);

    const res = await request(app)
      .post("/api/assistant/mcp")
      .send({ jsonrpc: "2.0", method: "tools/list", id: 1 });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Athlete Assistant MCP bridge unavailable." },
      id: null,
    });
  });
});
