import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { D01_PLANT_CATALOG } from "@triathlon-twin/simulator/mining";
import {
  createBoundedMiningQuery,
  parseMiningQueryFrames,
} from "../src/mining/read/bounded-query.js";

const uri = "https://example.region.kusto.windows.net";
const clientId = "11111111-2222-4333-8444-555555555555";
const resource = "https://kusto.kusto.windows.net";
const env = {
  EVENTHOUSE_QUERY_URI: uri,
  MINING_EVENTHOUSE_QUERY_URI: uri,
  EVENTHOUSE_DATABASE_NAME: "ExistingDatabase",
  MINING_EVENTHOUSE_DATABASE_NAME: "ExistingDatabase",
  MINING_CURATED_SOURCE_VERSION: "d01-validated-source-v1",
  MINING_CURATED_QUERY_VERSION: "d01-g5-query-v1",
  MINING_MANAGED_IDENTITY_CLIENT_ID: clientId,
  IDENTITY_ENDPOINT: "http://127.0.0.1:1234/identity",
  IDENTITY_HEADER: "secret",
};
const input = {
  kind: "compare" as const,
  runId: "11111111-1111-4111-8111-111111111111",
  maxRows: 1000,
  start: "2026-01-01T11:00:00.000Z",
  end: "2026-01-01T12:00:00.000Z",
  metric: "feed" as const,
  binMinutes: 1 as const,
};
const now = () => Date.parse("2026-01-01T12:00:00.000Z");
const metadata = {
  AzureAD: {
    LoginEndpoint: "https://login.microsoftonline.com",
    LoginMfaRequired: false,
    KustoServiceResourceId: resource,
  },
};
const token = {
  access_token: "test-token",
  token_type: "Bearer",
  resource,
  client_id: clientId,
  expires_on: String(now() / 1000 + 300),
};
const header = { FrameType: "DataSetHeader", Version: "v2.0", IsProgressive: false };
const complete = { FrameType: "DataSetCompletion", HasErrors: false, Cancelled: false };
function frames(rows: unknown[][] = [["ok"]]) {
  return [
    header,
    {
      FrameType: "DataTable",
      TableId: 0,
      TableName: "PrimaryResult",
      TableKind: "PrimaryResult",
      Columns: [{ ColumnName: "value", ColumnType: "string" }],
      Rows: rows,
    },
    complete,
  ];
}
function fixture(result: unknown = frames()) {
  const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
    const number = request.mock.calls.length % 3;
    return Response.json(number === 1 ? metadata : number === 2 ? token : result);
  });
  return { request, query: createBoundedMiningQuery(env, { fetch: request, now }) };
}

describe("bounded mining query transport", () => {
  it("uses the verified resource and fixed parameterized comparison query", async () => {
    const { request, query } = fixture();
    expect(await query(input)).toEqual([{ value: "ok" }]);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[0][0]).toBe(`${uri}/v1/rest/auth/metadata`);
    const identity = new URL(String(request.mock.calls[1][0]));
    expect(identity.searchParams.get("resource")).toBe(resource);
    expect(identity.searchParams.get("client_id")).toBe(clientId);
    expect(identity.searchParams.get("api-version")).toBe("2019-08-01");
    const queryInit = request.mock.calls[2][1]!;
    expect(request.mock.calls[2][0]).toBe(`${uri}/v2/rest/query`);
    expect(queryInit.headers).toMatchObject({
      Authorization: "Bearer test-token",
      "x-ms-readonly": "true",
    });
    const body = JSON.parse(String(queryInit.body));
    expect(body.db).toBe("ExistingDatabase");
    expect(body.csl).toContain("mining_CompareLines(plant, run, metric, start, end, bin)");
    expect(body.csl).not.toContain(input.runId);
    expect(body.properties.Parameters.run).toBe(`'${input.runId}'`);
    expect(body.properties.Options.truncationmaxrecords).toBe(1001);
    expect(body.properties.Options.truncationmaxsize).toBe(1_048_576);
    expect(request.mock.calls.every((call) => call[1]?.redirect === "error")).toBe(true);
    expect(request.mock.calls[0][1]?.signal).toBe(request.mock.calls[2][1]?.signal);
  });

  it("uses only the other four allowlisted function signatures", async () => {
    const f = fixture();
    const scope = { runId: input.runId, maxRows: 1000 };
    await f.query({ ...scope, kind: "latest", asOf: input.end });
    await f.query({ ...scope, kind: "incidents", asOf: input.end });
    await f.query({ ...scope, kind: "summary", start: input.start, end: input.end });
    await f.query({
      ...scope,
      kind: "trend",
      start: input.start,
      end: input.end,
      moduleId: D01_PLANT_CATALOG.modules[0].id,
      metric: "vibration",
      binMinutes: 5,
    });
    expect(
      f.request.mock.calls
        .filter((_, i) => i % 3 === 2)
        .map((call) => JSON.parse(String(call[1]?.body)).csl),
    ).toEqual([
      expect.stringContaining("mining_PlantLatest(plant, run, asof)"),
      expect.stringContaining("mining_ActiveIncidents(plant, run, asof)"),
      expect.stringContaining("mining_PlantSummary(plant, run, start, end)"),
      expect.stringContaining("mining_AssetTrend(plant, run, module, metric, start, end, bin)"),
    ]);
  });

  it("rejects foreign targets, invalid identity endpoints and invalid inputs before I/O", async () => {
    const f = fixture();
    const unsafe = [
      { MINING_EVENTHOUSE_QUERY_URI: "https://other.region.kusto.windows.net" },
      {
        EVENTHOUSE_QUERY_URI: "https://ingest-example.region.kusto.windows.net",
        MINING_EVENTHOUSE_QUERY_URI: "https://ingest-example.region.kusto.windows.net",
      },
      { IDENTITY_ENDPOINT: "http://example.com/identity" },
      { IDENTITY_ENDPOINT: "http://127.0.0.1/identity?other=x" },
      { MINING_MANAGED_IDENTITY_CLIENT_ID: "" },
    ];
    for (const change of unsafe) {
      await expect(
        createBoundedMiningQuery({ ...env, ...change }, { fetch: f.request, now })(input),
      ).rejects.toMatchObject({ code: "configuration" });
    }
    for (const invalid of [
      { ...input, runId: "x' | print 1" },
      { ...input, maxRows: 1001 },
      { ...input, end: "2026-01-01T12:00:01Z" },
      { ...input, start: "2025-12-30T12:00:00Z" },
      { ...input, metric: "water-energy" as const },
    ])
      await expect(f.query(invalid)).rejects.toMatchObject({ code: "invalid" });
    expect(f.request).not.toHaveBeenCalled();
  });

  it("fails closed on cloud, identity, HTTP and response limits", async () => {
    expect(
      await fixture(frames(Array.from({ length: 1000 }, () => ["ok"]))).query(input),
    ).toHaveLength(1000);
    await expect(
      fixture(frames(Array.from({ length: 1001 }, () => ["ok"]))).query(input),
    ).rejects.toMatchObject({ code: "overflow" });
    const f = fixture(frames([["one"], ["two"]]));
    await expect(f.query({ ...input, maxRows: 1 })).rejects.toMatchObject({ code: "overflow" });
    await expect(fixture(frames([["x".repeat(1_048_577)]])).query(input)).rejects.toMatchObject({
      code: "overflow",
    });
    const wrongCloud = vi.fn(async () =>
      Response.json({ AzureAD: { ...metadata.AzureAD, LoginMfaRequired: true } }),
    );
    await expect(
      createBoundedMiningQuery(env, { fetch: wrongCloud, now })(input),
    ).rejects.toMatchObject({ code: "configuration" });
    expect(wrongCloud).toHaveBeenCalledTimes(1);
    const wrongToken = vi.fn(async (_url: string | URL | Request) =>
      Response.json(
        wrongToken.mock.calls.length === 1 ? metadata : { ...token, client_id: "other" },
      ),
    );
    await expect(
      createBoundedMiningQuery(env, { fetch: wrongToken, now })(input),
    ).rejects.toMatchObject({ code: "malformed" });
    expect(wrongToken).toHaveBeenCalledTimes(2);
    const unavailable = vi.fn(async () => new Response("", { status: 429 }));
    await expect(createBoundedMiningQuery(env, { fetch: unavailable, now })(input)).rejects.toThrow(
      "HTTP 429",
    );
  });

  it("rejects incomplete, cancelled, failed and malformed V2 result frames", () => {
    const result = frames();
    expect(parseMiningQueryFrames(result, 1)).toEqual([{ value: "ok" }]);
    for (const value of [
      result.slice(0, 2),
      [{ ...header, IsProgressive: true }, result[1], complete],
      [header, result[1], result[1], complete],
      [header, { ...result[1], Rows: [["a", "b"]] }, complete],
      [header, result[1], { ...complete, OneApiErrors: [{ error: "truncated" }] }],
    ])
      expect(() => parseMiningQueryFrames(value, 1000)).toThrowError(
        expect.objectContaining({ code: "malformed" }),
      );
    expect(() =>
      parseMiningQueryFrames([header, result[1], { ...complete, HasErrors: true }], 1),
    ).toThrowError(expect.objectContaining({ code: "upstream" }));
    expect(() =>
      parseMiningQueryFrames([header, result[1], { ...complete, Cancelled: true }], 1),
    ).toThrowError(expect.objectContaining({ code: "cancelled" }));
    const status = {
      FrameType: "DataTable",
      TableId: 1,
      TableName: "Status",
      TableKind: "QueryCompletionInformation",
      Columns: [{ ColumnName: "Level", ColumnType: "int" }],
      Rows: [[2]],
    };
    expect(() => parseMiningQueryFrames([header, result[1], status, complete], 1)).toThrowError(
      expect.objectContaining({ code: "upstream" }),
    );
  });

  it.each([1, 2, 3])(
    "aborts pending HTTP stage %i without starting a later stage",
    async (stage) => {
      const controller = new AbortController();
      let started!: () => void;
      const pending = new Promise<void>((resolve) => {
        started = resolve;
      });
      let observedAbort = false;
      const request = vi.fn(
        async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const count = request.mock.calls.length;
          if (count === stage) {
            started();
            return new Promise((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => {
                  observedAbort = true;
                  reject(new Error("network aborted"));
                },
                { once: true },
              );
            });
          }
          return Response.json(count === 1 ? metadata : token);
        },
      );
      const result = createBoundedMiningQuery(env, { fetch: request, now })(
        input,
        controller.signal,
      );
      await pending;
      controller.abort();
      await expect(result).rejects.toMatchObject({ code: "cancelled" });
      expect(observedAbort).toBe(true);
      expect(request).toHaveBeenCalledTimes(stage);
    },
  );

  it("aborts stalled response body consumption before starting identity", async () => {
    const controller = new AbortController();
    let reading!: () => void;
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    let observedAbort = false;
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode("{"));
          init?.signal?.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              stream.error(new Error("body aborted"));
            },
            { once: true },
          );
          reading();
        },
      });
      return new Response(body);
    });
    const result = createBoundedMiningQuery(env, { fetch: request, now })(input, controller.signal);
    await started;
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    expect(observedAbort).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("aborts the underlying request at the shared deadline", async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    let observedAbort = false;
    const request = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        started();
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              reject(new Error("network aborted"));
            },
            { once: true },
          );
        });
      },
    );
    try {
      const result = createBoundedMiningQuery(env, { fetch: request, now })(input);
      const rejected = expect(result).rejects.toMatchObject({ code: "timeout" });
      await pending;
      await vi.advanceTimersByTimeAsync(9_000);
      await rejected;
      expect(observedAbort).toBe(true);
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a real HTTP stream when the caller disconnects during metadata", async () => {
    let started!: () => void;
    let closed!: () => void;
    const bodyStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const socketClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const server = createServer((_req, res) => {
      res.on("close", closed);
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
      started();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      fetch(`http://127.0.0.1:${port}/mock-metadata`, init),
    );
    const controller = new AbortController();
    try {
      const result = createBoundedMiningQuery(env, { fetch: request, now })(
        input,
        controller.signal,
      );
      await bodyStarted;
      controller.abort();
      await expect(result).rejects.toMatchObject({ code: "cancelled" });
      await socketClosed;
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
