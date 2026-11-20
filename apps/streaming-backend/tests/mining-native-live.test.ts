import { createHash } from "node:crypto";
import { createD01Simulation } from "@triathlon-twin/simulator/mining";
import { describe, expect, it, vi } from "vitest";
import { createMiningNativeLive } from "../src/mining/native-live.js";

const uri = "https://example.region.kusto.fabric.microsoft.com";
const clientId = "11111111-2222-4333-8444-555555555555";
const resource = "https://kusto.kusto.windows.net";
const env = {
  MINING_NATIVE_LIVE_ENABLED: "true",
  MINING_EVENTHOUSE_QUERY_URI: uri,
  MINING_EVENTHOUSE_DATABASE_NAME: "ExistingDatabase",
  MINING_CURATED_SOURCE_VERSION: "d01-validated-source-v1",
  MINING_CURATED_QUERY_VERSION: "d01-g5-query-v1",
  MINING_MANAGED_IDENTITY_CLIENT_ID: clientId,
  IDENTITY_ENDPOINT: "http://127.0.0.1:1234/identity",
  IDENTITY_HEADER: "test-secret",
};
const runId = "11111111-1111-4111-8111-111111111111";
const startedAt = new Date("2026-01-01T12:00:00.000Z");
const tick = new Date(+startedAt + 5_000);
const sim = createD01Simulation({ runId, startedAt, durationSeconds: 60, flushStartup: true });
const batch = sim.step(tick).batch!;
const hash = createHash("sha256")
  .update(
    batch.events
      .map((event) => event.event_id)
      .sort()
      .join("\n"),
  )
  .digest("hex");

function fixture(resultHash = hash, ingestStatus = 200) {
  return vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        AzureAD: {
          LoginEndpoint: "https://login.microsoftonline.com",
          LoginMfaRequired: false,
          KustoServiceResourceId: resource,
        },
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        access_token: "test-token",
        token_type: "Bearer",
        resource,
        client_id: clientId,
        expires_on: String(Math.floor(Date.now() / 1000) + 300),
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: ingestStatus }))
    .mockResolvedValueOnce(
      Response.json({
        Tables: [{ Rows: [[4, 0, 4, tick.toISOString(), "", null, "", resultHash]] }],
      }),
    );
}

describe("Mining native mirror receipts", () => {
  it("writes only the isolated target and confirms the complete classified batch", async () => {
    const request = fixture();
    const send = createMiningNativeLive(env, request)!;
    await expect(
      send(runId, batch.timestamp, batch.events, new AbortController().signal),
    ).resolves.toMatchObject({ runId, stateCount: 4, telemetryCount: 0 });
    expect(request.mock.calls[2][0]).toBe(
      `${uri}/v1/rest/ingest/ExistingDatabase/mining_NativeLiveRaw?streamFormat=Json&mappingName=mining_native_live_map`,
    );
    expect(request.mock.calls[3][1]?.headers).toMatchObject({ "x-ms-readonly": "true" });
  });

  it("rejects a wrong classified ID set and never retries a failed write", async () => {
    const signal = new AbortController().signal;
    const wrong = fixture("wrong-set");
    await expect(
      createMiningNativeLive(env, wrong)!(runId, batch.timestamp, batch.events, signal),
    ).rejects.toThrow("did not validate");
    const failed = fixture(hash, 503);
    await expect(
      createMiningNativeLive(env, failed)!(runId, batch.timestamp, batch.events, signal),
    ).rejects.toThrow("HTTP 503");
    expect(failed).toHaveBeenCalledTimes(3);
  });
});
