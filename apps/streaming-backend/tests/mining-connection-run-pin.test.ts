import { describe, expect, it, vi } from "vitest";
import {
  D01_CATALOG_VERSION,
  D01_CONNECTION_MEASUREMENT_CATALOG_VERSION,
  D01_CONNECTION_PROFILE_VERSION,
} from "@triathlon-twin/simulator/mining";
import {
  configuredConnectionRunPinHandler,
  createConnectionRunPinHandler,
} from "../src/mining/connection-run-pin.js";

const pin = {
  plant_id: "D01" as const,
  run_id: "11111111-1111-4111-8111-111111111111",
  catalog_version: D01_CATALOG_VERSION,
  measurement_catalog_version: D01_CONNECTION_MEASUREMENT_CATALOG_VERSION,
  profile_version: D01_CONNECTION_PROFILE_VERSION,
  started_at: "2026-01-01T12:01:00.000Z",
};
const row = {
  ...pin,
  started_at: "2026-01-01T12:01:00Z",
  pinned_at: "2026-01-01T12:00:00Z",
  received_at: "2026-01-01T12:00:15Z",
};

function fixture() {
  const publish = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const query = vi.fn(async (): Promise<Record<string, unknown>[]> => [row]);
  query.mockResolvedValueOnce([]);
  const wait = vi.fn(async () => {});
  const handler = createConnectionRunPinHandler(query, () => ({ publish, close }), wait);
  return { publish, close, query, wait, handler };
}

describe("connection run-pin confirmation", () => {
  it("sends once and waits for exact persisted run and receipt evidence", async () => {
    const f = fixture();
    f.query.mockResolvedValueOnce([]);
    const signal = new AbortController().signal;
    await f.handler(pin, signal);
    expect(f.publish).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.query).toHaveBeenCalledTimes(3);
    expect(f.query).toHaveBeenCalledWith(
      { kind: "connection-run-pin", runId: pin.run_id, maxRows: 2 },
      signal,
    );
    expect(f.wait).toHaveBeenCalledOnce();
  });

  it("fails closed for mismatched, duplicated or unverified receipt", async () => {
    for (const result of [
      [{ ...row, started_at: "2026-01-01T12:01:00.0000001Z" }],
      [{ ...row, received_at: null }],
      [{ ...row, plant_id: "other" }],
      [row, row],
    ]) {
      const f = fixture();
      f.query.mockResolvedValueOnce(result);
      await expect(f.handler(pin, new AbortController().signal)).rejects.toThrow();
      expect(f.publish).toHaveBeenCalledOnce();
      expect(f.query).toHaveBeenCalledTimes(2);
    }
  });

  it("never resends an ambiguous send and surfaces cleanup errors", async () => {
    const f = fixture();
    f.publish.mockRejectedValueOnce(new Error("delivery unknown"));
    f.close.mockRejectedValueOnce(new Error("close failed"));
    await expect(f.handler(pin, new AbortController().signal)).rejects.toBeInstanceOf(
      AggregateError,
    );
    expect(f.publish).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.query).toHaveBeenCalledOnce();
  });

  it("stops polling when cancelled", async () => {
    const f = fixture();
    f.query.mockResolvedValue([]);
    const controller = new AbortController();
    f.wait.mockImplementationOnce(async () => controller.abort());
    await expect(f.handler(pin, controller.signal)).rejects.toThrow();
    expect(f.publish).toHaveBeenCalledOnce();
    expect(f.query).toHaveBeenCalledTimes(2);
  });

  it("does not send if a prior pin already exists", async () => {
    const publish = vi.fn(async () => {});
    const query = vi.fn(async () => [row]);
    const handler = createConnectionRunPinHandler(query, () => ({
      publish,
      close: async () => {},
    }));
    await expect(handler(pin, new AbortController().signal)).rejects.toThrow("already exists");
    expect(publish).not.toHaveBeenCalled();
  });

  it("requires explicit opt-in and a separate flow Eventstream", () => {
    expect(configuredConnectionRunPinHandler({})).toBeUndefined();
    expect(() =>
      configuredConnectionRunPinHandler({ MINING_CONNECTION_PIN_EVENTSTREAM_ENABLED: "yes" }),
    ).toThrow();
    const connection =
      "Endpoint=sb://flow.servicebus.windows.net/;" +
      "SharedAccessKeyName=send;SharedAccessKey=test-only;EntityPath=flow";
    const env = {
      MINING_CONNECTION_PIN_EVENTSTREAM_ENABLED: "true",
      MINING_CONNECTION_FLOW_ENABLED: "true",
      MINING_CONNECTION_EVENTSTREAM_EVENTHUB_CONNECTION_STRING: connection,
      MINING_EVENTSTREAM_EVENTHUB_CONNECTION_STRING: connection,
    };
    expect(() => configuredConnectionRunPinHandler(env)).toThrow("separate Eventstream");
    expect(
      configuredConnectionRunPinHandler({
        ...env,
        MINING_EVENTSTREAM_EVENTHUB_CONNECTION_STRING: connection.replace(
          "EntityPath=flow",
          "EntityPath=legacy",
        ),
      }),
    ).toBeTypeOf("function");
  });

  it("uses the mining Eventhouse for pin reads when the main Eventhouse differs", async () => {
    const clientId = "11111111-2222-4333-8444-555555555555";
    const miningUri = "https://mining.region.kusto.windows.net";
    const connection = (path: string) =>
      `Endpoint=sb://flow.servicebus.windows.net/;SharedAccessKeyName=send;SharedAccessKey=test-only;EntityPath=${path}`;
    const request = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => {
      switch (request.mock.calls.length) {
        case 1:
          return Response.json({
            AzureAD: {
              LoginEndpoint: "https://login.microsoftonline.com",
              LoginMfaRequired: false,
              KustoServiceResourceId: "https://kusto.kusto.windows.net",
            },
          });
        case 2:
          return Response.json({
            access_token: "test-token",
            token_type: "Bearer",
            resource: "https://kusto.kusto.windows.net",
            client_id: clientId,
            expires_on: Math.floor(Date.now() / 1000) + 300,
          });
        default:
          return Response.json([
            { FrameType: "DataSetHeader", Version: "v2.0", IsProgressive: false },
            {
              FrameType: "DataTable",
              TableId: 0,
              TableName: "PrimaryResult",
              TableKind: "PrimaryResult",
              Columns: [{ ColumnName: "value", ColumnType: "string" }],
              Rows: [["existing pin"]],
            },
            { FrameType: "DataSetCompletion", HasErrors: false, Cancelled: false },
          ]);
      }
    });
    vi.stubGlobal("fetch", request);
    try {
      const handler = configuredConnectionRunPinHandler({
        MINING_CONNECTION_PIN_EVENTSTREAM_ENABLED: "true",
        MINING_CONNECTION_FLOW_ENABLED: "true",
        MINING_CONNECTION_EVENTSTREAM_EVENTHUB_CONNECTION_STRING: connection("flow"),
        MINING_EVENTSTREAM_EVENTHUB_CONNECTION_STRING: connection("legacy"),
        EVENTHOUSE_QUERY_URI: "https://triathlon.region.kusto.windows.net",
        EVENTHOUSE_DATABASE_NAME: "triathlon",
        MINING_EVENTHOUSE_QUERY_URI: miningUri,
        MINING_EVENTHOUSE_DATABASE_NAME: "mining",
        MINING_CURATED_SOURCE_VERSION: "d01-validated-source-v1",
        MINING_CURATED_QUERY_VERSION: "d01-g5-query-v1",
        MINING_MANAGED_IDENTITY_CLIENT_ID: clientId,
        IDENTITY_ENDPOINT: "http://127.0.0.1:1234/identity",
        IDENTITY_HEADER: "test-only",
      });
      expect(handler).toBeDefined();
      await expect(handler!(pin, new AbortController().signal)).rejects.toThrow("already exists");
      expect(String(request.mock.calls[0][0])).toBe(`${miningUri}/v1/rest/auth/metadata`);
      expect(JSON.parse(String(request.mock.calls[2][1]?.body)).db).toBe("mining");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
