import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createAuthDebugAction } from "../src/actions/auth-debug.js";

function buildApp() {
  const app = express();
  app.get("/actions/auth-debug", createAuthDebugAction());
  return app;
}

describe("GET /actions/auth-debug", () => {
  it("reports all-false/null when no Easy Auth headers are present", async () => {
    const app = buildApp();

    const res = await request(app).get("/actions/auth-debug");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      hasPrincipalIdHeader: false,
      hasPrincipalHeader: false,
      hasAccessTokenHeader: false,
      hasIdTokenHeader: false,
      accessTokenLength: 0,
      accessTokenAudience: null,
      accessTokenScopes: null,
      accessTokenAppId: null,
      accessTokenExpiresAt: null,
    });
  });

  it("reports presence flags and decoded claims when Easy Auth headers are present", async () => {
    const app = buildApp();
    const header = (value: Record<string, unknown>) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const fakeJwt = `${header({ alg: "none" })}.${header({
      aud: "api://test-audience",
      scp: "user_impersonation",
      appid: "test-app-id",
      exp: 1999999999,
    })}.signature`;

    const res = await request(app)
      .get("/actions/auth-debug")
      .set("x-ms-client-principal-id", "athlete-1")
      .set("x-ms-client-principal", "eyJmYWtlIjoidHJ1ZSJ9")
      .set("x-ms-token-aad-access-token", fakeJwt)
      .set("x-ms-token-aad-id-token", "fake-id-token");

    expect(res.status).toBe(200);
    expect(res.body.hasPrincipalIdHeader).toBe(true);
    expect(res.body.hasPrincipalHeader).toBe(true);
    expect(res.body.hasAccessTokenHeader).toBe(true);
    expect(res.body.hasIdTokenHeader).toBe(true);
    expect(res.body.accessTokenLength).toBe(fakeJwt.length);
    expect(res.body.accessTokenAudience).toBe("api://test-audience");
    expect(res.body.accessTokenScopes).toBe("user_impersonation");
    expect(res.body.accessTokenAppId).toBe("test-app-id");
    expect(res.body.accessTokenExpiresAt).toBe(new Date(1999999999 * 1000).toISOString());
  });
});
