import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantRouter } from "../src/api/assistant.js";

function token(overrides: Record<string, unknown> = {}) {
  return `header.${Buffer.from(JSON.stringify({
    aud: "backend", tid: "tenant", oid: "human", exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  })).toString("base64url")}.signature`;
}

describe("assistant delegated proxy boundary", () => {
  beforeEach(() => {
    vi.stubEnv("ASSISTANT_AUTH_TENANT_ID", "tenant");
    vi.stubEnv("ASSISTANT_AUTH_BACKEND_CLIENT_ID", "backend");
  });
  afterEach(() => vi.unstubAllEnvs());

  function buildApp(baseUrl = "https://backend.example.test") {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ answer: "grounded" }), {
      headers: { "content-type": "application/json" },
    }));
    const serviceAuth = vi.fn(async () => ({ authorization: "Bearer workload-token" }));
    const app = express().use(express.json());
    app.use("/api/assistant", createAssistantRouter({
      streamingBackendBaseUrl: baseUrl, fetchImpl, buildAuthHeaders: serviceAuth,
    }));
    return { app, fetchImpl, serviceAuth };
  }

  it("forwards only the platform user's backend token, never MI/cookies/identity hints", async () => {
    const { app, fetchImpl, serviceAuth } = buildApp();
    const assertion = token();
    const res = await request(app).post("/api/assistant/ask")
      .set("x-ms-client-principal-id", "human")
      .set("x-ms-token-aad-access-token", assertion)
      .set("x-ms-token-aad-refresh-token", "do-not-relay")
      .set("authorization", "Bearer do-not-relay")
      .set("cookie", "session=do-not-relay")
      .send({ athleteId: "athlete", question: "Recovery?" });
    expect(res.status).toBe(200);
    expect(serviceAuth).not.toHaveBeenCalled();
    const [, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    const headers = new Headers(init.headers);
    expect([...headers.keys()].sort()).toEqual(["authorization", "content-type"]);
    expect(headers.get("authorization")).toBe(`Bearer ${assertion}`);
    expect(init.redirect).toBe("manual");
  });

  it.each([
    ["wrong audience", { aud: "graph" }],
    ["wrong tenant", { tid: "other" }],
    ["wrong user", { oid: "other" }],
    ["invalid expiry", { exp: null }],
  ])("rejects %s instead of sending a token", async (_name, claims) => {
    const { app, fetchImpl, serviceAuth } = buildApp();
    const res = await request(app).post("/api/assistant/ask")
      .set("x-ms-client-principal-id", "human").set("x-ms-token-aad-access-token", token(claims))
      .send({ athleteId: "athlete", question: "Recovery?" });
    expect(res.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(serviceAuth).not.toHaveBeenCalled();
  });

  it("signals refresh for a nearly expired token", async () => {
    const { app, fetchImpl } = buildApp();
    const res = await request(app).post("/api/assistant/ask")
      .set("x-ms-client-principal-id", "human")
      .set("x-ms-token-aad-access-token", token({ exp: Math.floor(Date.now() / 1000) + 5 }))
      .send({ athleteId: "athlete", question: "Recovery?" });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: "assistant_token_expired", canRefresh: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not accept an arbitrary browser Authorization token when token store is absent", async () => {
    const { app, fetchImpl, serviceAuth } = buildApp();
    const res = await request(app).post("/api/assistant/ask")
      .set("x-ms-client-principal-id", "human").set("authorization", `Bearer ${token()}`)
      .send({ athleteId: "athlete", question: "Recovery?" });
    expect(res.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(serviceAuth).not.toHaveBeenCalled();
  });

  it("never sends user credentials over plain HTTP", async () => {
    const { app, fetchImpl } = buildApp("http://backend.example.test");
    const res = await request(app).post("/api/assistant/ask")
      .set("x-ms-client-principal-id", "human").set("x-ms-token-aad-access-token", token())
      .send({ athleteId: "athlete", question: "Recovery?" });
    expect(res.status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
