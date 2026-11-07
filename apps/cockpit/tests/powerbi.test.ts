import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPowerBiEmbedConfigAction } from "../src/api/powerbi.js";
import { createPowerBiService, PowerBiError, readPowerBiConfig, type PowerBiConfig } from "../src/services/powerbi.js";

const config: PowerBiConfig = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  clientId: "22222222-2222-2222-2222-222222222222",
  clientSecret: "test-client-secret",
  workspaceId: "33333333-3333-3333-3333-333333333333",
  reportId: "44444444-4444-4444-4444-444444444444",
  datasetId: "55555555-5555-5555-5555-555555555555",
  allowedPrincipalIds: ["66666666-6666-6666-6666-666666666666"],
};
function principal(objectId = config.allowedPrincipalIds[0], tenantId = config.tenantId) {
  return Buffer.from(JSON.stringify({
    auth_typ: "aad", claims: [{ typ: "oid", val: objectId }, { typ: "tid", val: tenantId }],
  })).toString("base64");
}
function fixture() {
  let now = Date.parse("2026-09-09T12:00:00Z");
  const getToken = vi.fn(async () => ({ token: "test-entra-token", expiresOnTimestamp: now + 3_600_000 }));
  const fetchImpl = vi.fn<typeof fetch>(async (url) => {
    if (String(url).endsWith(`/reports/${config.reportId}`)) {
      return Response.json({ id: config.reportId, datasetId: config.datasetId, reportType: "PowerBIReport" });
    }
    if (String(url).endsWith(`/datasets/${config.datasetId}`)) {
      return Response.json({ id: config.datasetId, isEffectiveIdentityRequired: false, isEffectiveIdentityRolesRequired: false });
    }
    return Response.json({ token: "test-embed-token", expiration: new Date(now + 600_000).toISOString() });
  });
  const service = createPowerBiService(config, { credential: { getToken }, fetchImpl, now: () => now });
  const app = express();
  app.get("/api/powerbi/embed-config", createPowerBiEmbedConfigAction({ readConfig: () => config, createService: () => service }));
  return { app, getToken, fetchImpl, service, advance: (ms: number) => { now += ms; } };
}

afterEach(() => vi.restoreAllMocks());

describe("Power BI authentication and API boundary", () => {
  it("serves the embed config via Cockpit's own service-principal identity for anonymous visitors (MI-mode fallback)", async () => {
    const { app, getToken } = fixture();
    const res = await request(app).get("/api/powerbi/embed-config");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ready", tokenType: "Embed" });
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(getToken).toHaveBeenCalledWith("https://analysis.windows.net/powerbi/api/.default");
  });

  it.each(["not-base64-json", Buffer.from("null").toString("base64")])("rejects a malformed principal as a failed sign-in attempt, not an anonymous visitor", async (header) => {
    const { app, fetchImpl, getToken } = fixture();
    const res = await request(app).get("/api/powerbi/embed-config").set("x-ms-client-principal", header);
    expect(res.status).toBe(401);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
  });

  it("does not trust a standalone principal-id header", async () => {
    const { app } = fixture();
    const res = await request(app).get("/api/powerbi/embed-config").set("x-ms-client-principal-id", config.allowedPrincipalIds[0]);
    expect(res.status).toBe(401);
  });

  it.each([
    principal("77777777-7777-7777-7777-777777777777"),
    principal(config.allowedPrincipalIds[0], "77777777-7777-7777-7777-777777777777"),
  ])("rejects unapproved users/tenants without upstream requests", async (header) => {
    const { app, fetchImpl } = fixture();
    const res = await request(app).get("/api/powerbi/embed-config").set("x-ms-client-principal", header);
    expect(res.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects conflicting EasyAuth claims", async () => {
    const { app } = fixture();
    const res = await request(app).get("/api/powerbi/embed-config")
      .set("x-ms-client-principal", principal()).set("x-ms-client-principal-id", config.clientId);
    expect(res.status).toBe(401);
  });

  it("returns only a scoped Embed token, never the service credentials, regardless of caller-selected IDs", async () => {
    const { app, fetchImpl, getToken } = fixture();
    const res = await request(app).get("/api/powerbi/embed-config?reportId=another&datasetId=another")
      .set("x-ms-client-principal", principal());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ready", tokenType: "Embed", datasetId: config.datasetId, reportId: config.reportId });
    expect(res.text).not.toContain(config.clientSecret);
    expect(res.text).not.toContain("test-entra-token");
    expect(getToken).toHaveBeenCalledWith("https://analysis.windows.net/powerbi/api/.default");
    expect(fetchImpl.mock.calls[2][0]).toBe("https://api.powerbi.com/v1.0/myorg/GenerateToken");
    expect(JSON.parse(String(fetchImpl.mock.calls[2][1]?.body))).toEqual({
      datasets: [{ id: config.datasetId }], reports: [{ id: config.reportId, allowEdit: false }], lifetimeInMinutes: 10,
    });
  });

  it("distinguishes missing configuration from upstream failures without leaking details", async () => {
    const app = express();
    app.get("/", createPowerBiEmbedConfigAction({ readConfig: () => readPowerBiConfig({ POWERBI_EMBED_TOKEN: "retired-static-token" }) }));
    expect((await request(app).get("/").set("x-ms-client-principal", principal())).status).toBe(503);
    const f = fixture();
    f.getToken.mockRejectedValue(new Error("test-client-secret test-entra-token"));
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await request(f.app).get("/api/powerbi/embed-config").set("x-ms-client-principal", principal());
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("powerbi-identity-unavailable");
    expect(res.text + JSON.stringify(log.mock.calls)).not.toContain("test-client-secret");
    expect(res.text + JSON.stringify(log.mock.calls)).not.toContain("test-entra-token");
  });
});

describe("Power BI token lifecycle", () => {
  it("deduplicates requests, caches in memory and refreshes before expiration", async () => {
    const f = fixture();
    const [a, b] = await Promise.all([f.service.getEmbedConfig(), f.service.getEmbedConfig()]);
    expect(a).toBe(b);
    expect(f.fetchImpl).toHaveBeenCalledTimes(3);
    f.advance(400_000);
    await f.service.getEmbedConfig();
    expect(f.fetchImpl).toHaveBeenCalledTimes(3);
    f.advance(30_000);
    const refreshed = await f.service.getEmbedConfig();
    expect(f.fetchImpl).toHaveBeenCalledTimes(6);
    expect(Date.parse(refreshed.expiration)).toBeGreaterThan(Date.parse(a.expiration));
  });

  it("does not return a stale token after refresh failure and permits retry", async () => {
    const f = fixture();
    await f.service.getEmbedConfig();
    f.advance(500_000);
    f.getToken.mockRejectedValueOnce(new Error("secret"));
    await expect(f.service.getEmbedConfig()).rejects.toEqual(new PowerBiError("identity-unavailable"));
    await expect(f.service.getEmbedConfig()).resolves.toHaveProperty("status", "ready");
  });

  it("rejects an expired or near-expiry Entra token before GenerateToken", async () => {
    const f = fixture();
    f.getToken.mockResolvedValue({ token: "test-entra-token", expiresOnTimestamp: 0 });
    await expect(f.service.getEmbedConfig()).rejects.toHaveProperty("code", "identity-unavailable");
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed if the report is rebound to a different model", async () => {
    const f = fixture();
    f.fetchImpl.mockResolvedValueOnce(Response.json({ id: config.reportId, datasetId: config.clientId, reportType: "PowerBIReport" }));
    await expect(f.service.getEmbedConfig()).rejects.toHaveProperty("code", "report-mismatch");
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses RLS models rather than issuing a full-data token", async () => {
    const f = fixture();
    f.fetchImpl.mockResolvedValueOnce(Response.json({ id: config.reportId, datasetId: config.datasetId, reportType: "PowerBIReport" }))
      .mockResolvedValueOnce(Response.json({ id: config.datasetId, isEffectiveIdentityRequired: true, isEffectiveIdentityRolesRequired: true }));
    await expect(f.service.getEmbedConfig()).rejects.toHaveProperty("code", "unsupported-model");
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 404, 429, 500])("sanitizes Power BI HTTP %i errors", async (status) => {
    const f = fixture();
    f.fetchImpl.mockResolvedValueOnce(new Response("test-client-secret", { status }));
    await expect(f.service.getEmbedConfig()).rejects.toEqual(new PowerBiError("upstream-failed"));
  });

  it("sanitizes malformed upstream JSON and network errors", async () => {
    const f = fixture();
    f.fetchImpl.mockResolvedValueOnce(new Response("invalid-json test-client-secret"));
    await expect(f.service.getEmbedConfig()).rejects.toEqual(new PowerBiError("upstream-failed"));
    f.fetchImpl.mockRejectedValueOnce(new Error("test-entra-token"));
    await expect(f.service.getEmbedConfig()).rejects.toEqual(new PowerBiError("upstream-failed"));
  });

  it.each(["invalid", "2020-01-01T00:00:00Z", "2030-01-01T00:00:00Z"])("rejects invalid token expiration %s", async (expiration) => {
    const f = fixture();
    const original = f.fetchImpl.getMockImplementation()!;
    f.fetchImpl.mockImplementation(async (url, init) =>
      String(url).endsWith("/GenerateToken") ? Response.json({ token: "token", expiration }) : original(url, init));
    await expect(f.service.getEmbedConfig()).rejects.toHaveProperty("code", "upstream-failed");
  });

  it("requires IDs, credentials, and an explicit allowlist; static env token is not a fallback", () => {
    expect(() => readPowerBiConfig({ POWERBI_EMBED_TOKEN: "obsolete" })).toThrow("not-configured");
    const env = {
      POWERBI_TENANT_ID: config.tenantId, POWERBI_CLIENT_ID: config.clientId,
      POWERBI_CLIENT_SECRET: config.clientSecret, POWERBI_WORKSPACE_ID: config.workspaceId,
      POWERBI_REPORT_ID: config.reportId, POWERBI_SEMANTIC_MODEL_ID: config.datasetId,
      POWERBI_ALLOWED_PRINCIPAL_IDS: config.allowedPrincipalIds.join(","),
    };
    expect(readPowerBiConfig(env)).toEqual(config);
    expect(() => readPowerBiConfig({ ...env, POWERBI_REPORT_ID: "../other" })).toThrow("not-configured");
    expect(() => readPowerBiConfig({ ...env, POWERBI_ALLOWED_PRINCIPAL_IDS: "" })).toThrow("not-configured");
  });
});
