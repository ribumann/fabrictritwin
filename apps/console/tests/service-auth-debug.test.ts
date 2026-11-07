import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createServiceAuthDebugAction } from "../src/actions/service-auth-debug.js";

function buildApp(getToken: () => Promise<string>) {
  const app = express();
  app.get("/actions/service-auth-debug", createServiceAuthDebugAction({ getToken }));
  return app;
}

describe("GET /actions/service-auth-debug", () => {
  it("reports decoded claims from the acquired service token", async () => {
    const header = (value: Record<string, unknown>) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const fakeJwt = `${header({ alg: "none" })}.${header({
      aud: "599d8879-5505-41db-bcb3-a7bf11283282",
      appid: "786c87dd-ad1d-4045-ac2d-d1913fe638b0",
      oid: "0659db0c-55ec-4698-9554-6c1f79db7da1",
      iss: "https://login.microsoftonline.com/dee4515b-50c3-59a0-a184-3a6a4039cb31/v2.0",
      ver: "2.0",
      idtyp: "app",
      exp: 1999999999,
    })}.signature`;
    const getToken = vi.fn().mockResolvedValue(fakeJwt);

    const res = await request(buildApp(getToken)).get("/actions/service-auth-debug");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      acquired: true,
      audience: "599d8879-5505-41db-bcb3-a7bf11283282",
      appId: "786c87dd-ad1d-4045-ac2d-d1913fe638b0",
      objectId: "0659db0c-55ec-4698-9554-6c1f79db7da1",
      issuer: "https://login.microsoftonline.com/dee4515b-50c3-59a0-a184-3a6a4039cb31/v2.0",
      tokenVersion: "2.0",
      idtyp: "app",
      roles: null,
      scopes: null,
      expiresAt: new Date(1999999999 * 1000).toISOString(),
    });
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it("reports acquired:false with an error message when token acquisition fails", async () => {
    const getToken = vi.fn().mockRejectedValue(new Error("boom"));

    const res = await request(buildApp(getToken)).get("/actions/service-auth-debug");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ acquired: false, error: "boom" });
  });
});
