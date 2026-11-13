import { ClientRequestProperties, KustoResponseDataSet, KustoResultTable } from "azure-kusto-data";
import { describe, expect, it, vi } from "vitest";
import { D01_PLANT_CATALOG } from "@triathlon-twin/simulator/mining";
import { createBoundedMiningQuery } from "../src/mining/read/bounded-query.js";

const uri = "https://example.region.kusto.windows.net";
const env = {
  EVENTHOUSE_QUERY_URI: uri,
  MINING_EVENTHOUSE_QUERY_URI: uri,
  EVENTHOUSE_DATABASE_NAME: "ExistingDatabase",
  MINING_EVENTHOUSE_DATABASE_NAME: "ExistingDatabase",
  MINING_CURATED_SOURCE_VERSION: "d01-validated-source-v1",
  MINING_CURATED_QUERY_VERSION: "d01-g5-query-v1",
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

class Dataset extends KustoResponseDataSet {
  dataSetCompletion: { HasErrors: boolean; Cancelled: boolean } | null = {
    HasErrors: false,
    Cancelled: false,
  };
  constructor(values: unknown[]) {
    super([]);
    this.primaryResults = [
      new KustoResultTable({
        TableName: "PrimaryResult",
        Columns: [{ ColumnName: "value", ColumnType: "string" }],
        Rows: values.map((value) => [value]),
      }),
    ];
  }
  getStatusColumn() {
    return "Payload";
  }
  getErrorColumn() {
    return "Level";
  }
  getCridColumn() {
    return "ClientRequestId";
  }
}

function fixture(result = new Dataset(["ok"])) {
  const client = {
    axiosInstance: { defaults: { maxContentLength: 0 } },
    executeQuery: vi.fn(
      async (
        _database: string,
        _query: string,
        _properties: ClientRequestProperties,
      ): Promise<KustoResponseDataSet> => result,
    ),
    close: vi.fn(),
  };
  const create = vi.fn(() => client);
  return { client, create, query: createBoundedMiningQuery(env, { client: create, now }) };
}

describe("bounded mining query transport", () => {
  it("uses only the fixed comparison function and typed bound parameters", async () => {
    const { client, query } = fixture();
    expect(await query(input)).toEqual([{ value: "ok" }]);
    const [database, text, properties] = client.executeQuery.mock.calls[0];
    expect(database).toBe("ExistingDatabase");
    expect(text).toContain("mining_CompareLines(plant, run, metric, start, end, bin)");
    expect(text).not.toContain(input.runId);
    expect(properties.getParameter("run")).toBe(`'${input.runId}'`);
    expect(properties.getParameter("start")).toBe(`datetime(${input.start})`);
    expect(properties.getOption("truncationmaxrecords")).toBe(1001);
    expect(properties.getOption("truncationmaxsize")).toBe(1_048_576);
    expect(properties.getTimeout()).toBe(9000);
    expect(properties.getClientTimeout()).toBe(9000);
    expect(client.axiosInstance.defaults.maxContentLength).toBe(1_048_576);
    expect(client.close).toHaveBeenCalled();
  });

  it("uses only the other four allowlisted function signatures", async () => {
    const f = fixture();
    const scope = { runId: input.runId, maxRows: 1000 };
    const asOf = input.end;
    await f.query({ ...scope, kind: "latest", asOf });
    await f.query({ ...scope, kind: "incidents", asOf });
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
    expect(f.client.executeQuery.mock.calls.map((call) => call[1])).toEqual([
      expect.stringContaining("mining_PlantLatest(plant, run, asof)"),
      expect.stringContaining("mining_ActiveIncidents(plant, run, asof)"),
      expect.stringContaining("mining_PlantSummary(plant, run, start, end)"),
      expect.stringContaining("mining_AssetTrend(plant, run, module, metric, start, end, bin)"),
    ]);
  });

  it("rejects foreign targets, invalid scope, future windows and unsupported metrics before querying", async () => {
    const { create, query } = fixture();
    await expect(
      createBoundedMiningQuery(
        { ...env, MINING_EVENTHOUSE_QUERY_URI: "https://other.region.kusto.windows.net" },
        { client: create },
      )(input),
    ).rejects.toMatchObject({ code: "configuration" });
    for (const invalid of [
      { ...input, runId: "x' | print 1" },
      { ...input, maxRows: 1001 },
      { ...input, end: "2026-01-01T12:00:01Z" },
      { ...input, start: "2025-12-30T12:00:00Z" },
      { ...input, metric: "water-energy" as const },
    ])
      await expect(query(invalid)).rejects.toMatchObject({ code: "invalid" });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects caller row overflow, oversized data, cancelled or incomplete responses", async () => {
    expect(await fixture(new Dataset(Array(1000).fill("a"))).query(input)).toHaveLength(1000);
    await expect(fixture(new Dataset(Array(1001).fill("a"))).query(input)).rejects.toMatchObject({
      code: "overflow",
    });
    await expect(
      fixture(new Dataset(["a", "b"])).query({ ...input, maxRows: 1 }),
    ).rejects.toMatchObject({ code: "overflow" });
    await expect(fixture(new Dataset(["x".repeat(1_048_577)])).query(input)).rejects.toMatchObject({
      code: "overflow",
    });
    const incomplete = new Dataset(["partial"]);
    incomplete.dataSetCompletion = null;
    await expect(fixture(incomplete).query(input)).rejects.toMatchObject({ code: "malformed" });
    const cancelled = new Dataset(["partial"]);
    cancelled.dataSetCompletion = { HasErrors: false, Cancelled: true };
    await expect(fixture(cancelled).query(input)).rejects.toMatchObject({ code: "malformed" });
  });

  it("preserves upstream failures and cancels in-flight calls", async () => {
    const f = fixture();
    const failure = new Error("transport failure");
    f.client.executeQuery.mockRejectedValueOnce(failure);
    await expect(f.query(input)).rejects.toBe(failure);
    f.client.executeQuery.mockImplementationOnce(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = f.query(input, controller.signal);
    await vi.waitFor(() => expect(f.client.executeQuery).toHaveBeenCalledTimes(2));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(f.client.close).toHaveBeenCalled();
  });

  it("enforces the complete query deadline and closes the client", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.client.executeQuery.mockImplementationOnce(() => new Promise(() => {}));
      const assertion = expect(f.query(input)).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(9000);
      await assertion;
      expect(f.client.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
