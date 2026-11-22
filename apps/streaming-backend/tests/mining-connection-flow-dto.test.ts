import { describe, expect, it } from "vitest";
import {
  D01_CATALOG_VERSION,
  D01_CONNECTION_MEASUREMENT_CATALOG_VERSION,
  D01_CONNECTION_PROFILE_VERSION,
  toD01ConnectionMeasurementBindingRecords,
} from "@triathlon-twin/simulator/mining";
import { mapConnectionLatest, mapConnectionTrend } from "../src/mining/read/connection-flow-dto.js";

const runId = "11111111-1111-4111-8111-111111111111";
const asOf = "2026-01-01T12:00:30.000Z";
const runStartedAt = "2026-01-01T12:00:00.000Z";
const streamIds = ["process-A-feed"];
const binding = toD01ConnectionMeasurementBindingRecords().find(
  (item) => item.stream_id === streamIds[0],
)!;
const scope = {
  RunId: runId,
  CatalogVersion: D01_CATALOG_VERSION,
  MeasurementCatalogVersion: D01_CONNECTION_MEASUREMENT_CATALOG_VERSION,
  ProfileVersion: D01_CONNECTION_PROFILE_VERSION,
  StreamId: binding.stream_id,
  MeasurementTagId: binding.measurement_tag_id,
  Quantity: binding.quantity,
  Basis: binding.basis,
  Unit: binding.unit,
};
const latest = () => ({
  ...scope,
  Status: "OK",
  Value: 0,
  Quality: "good",
  SampleTime: "2026-01-01T12:00:25.000Z",
  ReceiptTime: "2026-01-01T12:00:27.000Z",
  EventId: "a".repeat(64),
  Sequence: 1,
  IsStale: false,
  DuplicateCount: 0,
  ConflictCount: 0,
});
const trend = () => ({
  ...scope,
  Status: "COMPLETE",
  WindowStart: "2026-01-01T12:00:00.000Z",
  WindowEnd: asOf,
  WindowClosed: true,
  Value: 0,
  SampleCount: 6,
  ExpectedSampleCount: 6,
  ObservedTickCount: 6,
  BadSampleCount: 0,
  UncertainSampleCount: 0,
  Coverage: 1,
  DuplicateCount: 0,
  ConflictCount: 0,
  Quality: "good",
  WindowState: "COMPLETE",
  IsComplete: true,
  LastSampleTime: "2026-01-01T12:00:25.000Z",
  LastReceiptTime: "2026-01-01T12:00:27.000Z",
});
const openTrend = () => ({
  ...trend(),
  Status: "OPEN_WINDOW",
  WindowStart: asOf,
  WindowEnd: "2026-01-01T12:01:00.000Z",
  WindowClosed: false,
  Value: null,
  SampleCount: 0,
  ObservedTickCount: 0,
  Coverage: 0,
  Quality: "missing",
  WindowState: "OPEN_WINDOW",
  IsComplete: false,
  LastSampleTime: null,
  LastReceiptTime: null,
});

describe("connection flow result validation", () => {
  it("preserves a real zero and missing observation as distinct values", () => {
    const input = { runId, runStartedAt, asOf, streamIds };
    expect(mapConnectionLatest(input, [latest()]).readings[0]).toMatchObject({
      value: 0,
      quality: "good",
      status: "OK",
      source: binding.source,
      target: binding.target,
    });
    const missing = {
      ...latest(),
      Status: "MISSING",
      Value: null,
      Quality: "missing",
      SampleTime: null,
      ReceiptTime: null,
      EventId: "",
      Sequence: null,
    };
    expect(mapConnectionLatest(input, [missing]).readings[0]).toMatchObject({
      value: null,
      quality: "missing",
    });
    expect(() => mapConnectionLatest(input, [{ ...missing, Value: 0 }])).toThrow(
      "missing flow observation",
    );
  });

  it("rejects incomplete, wrong-scope, late and conflicting success-shaped readings", () => {
    const input = { runId, runStartedAt, asOf, streamIds };
    expect(() => mapConnectionLatest(input, [])).toThrow("Incomplete");
    expect(() => mapConnectionLatest(input, [{ ...latest(), RunId: "other" }])).toThrow(
      "requested run",
    );
    expect(() =>
      mapConnectionLatest(input, [{ ...latest(), ReceiptTime: "2026-01-01T12:00:31.000Z" }]),
    ).toThrow("cutoff");
    expect(() =>
      mapConnectionLatest(input, [{ ...latest(), ReceiptTime: "2026-01-01T12:00:30.0000001Z" }]),
    ).toThrow("cutoff");
    expect(() =>
      mapConnectionLatest(input, [{ ...latest(), SampleTime: "2026-01-01T12:00:10.000Z" }]),
    ).toThrow("freshness");
    expect(() =>
      mapConnectionLatest({ ...input, runStartedAt: "2026-01-01T12:00:26.000Z" }, [latest()]),
    ).toThrow("cutoff");
    expect(() => mapConnectionLatest(input, [{ ...latest(), ConflictCount: 1 }])).toThrow(
      "conflict",
    );
    expect(() => mapConnectionLatest(input, [{ ...scope, Status: "TRUNCATED" }])).toThrow(
      "TRUNCATED",
    );
  });

  it("checks the entire aligned trend grid and does not invent missing samples", () => {
    const input = {
      runId,
      runStartedAt,
      start: "2026-01-01T12:00:00.000Z",
      end: asOf,
      streamIds,
      windowSeconds: 30 as const,
    };
    const rows = [trend()];
    const points = mapConnectionTrend(input, rows).points;
    expect(points[0]).toMatchObject({ value: 0, complete: true, coverage: 1 });
    expect(() => mapConnectionTrend(input, [])).toThrow("Incomplete");
    expect(() => mapConnectionTrend(input, [trend(), trend()])).toThrow("Incomplete");
    expect(() => mapConnectionTrend(input, [{ ...trend(), Coverage: 0.5 }])).toThrow("coverage");
    expect(() => mapConnectionTrend(input, [{ ...trend(), IsComplete: false }])).toThrow(
      "completeness",
    );
    const extended = { ...input, end: "2026-01-01T12:00:35.000Z" };
    expect(mapConnectionTrend(extended, [trend(), openTrend()]).points[1]).toMatchObject({
      value: null,
      complete: false,
      state: "OPEN_WINDOW",
    });
  });
  it("uses the pinned run start, including for non-clock-aligned windows", () => {
    const shift = (value: string | null) =>
      value === null ? null : new Date(Date.parse(value) + 7_000).toISOString();
    const shifted = (row: ReturnType<typeof trend> | ReturnType<typeof openTrend>) => ({
      ...row,
      WindowStart: shift(row.WindowStart),
      WindowEnd: shift(row.WindowEnd),
      LastSampleTime: shift(row.LastSampleTime),
      LastReceiptTime: shift(row.LastReceiptTime),
    });
    const input = {
      runId,
      runStartedAt: "2026-01-01T12:00:07.000Z",
      start: "2026-01-01T12:00:07.000Z",
      end: "2026-01-01T12:00:37.000Z",
      streamIds,
      windowSeconds: 30 as const,
    };
    expect(mapConnectionTrend(input, [shifted(trend())]).points).toHaveLength(1);
    expect(() => mapConnectionTrend({ ...input, start: runStartedAt }, [shifted(trend())])).toThrow(
      "window",
    );
  });

  it("places a boundary tick in the window ending at that tick", () => {
    const input = {
      runId,
      runStartedAt,
      start: runStartedAt,
      end: asOf,
      streamIds,
      windowSeconds: 30 as const,
    };
    expect(
      mapConnectionTrend(input, [{ ...trend(), LastSampleTime: asOf }]).points[0],
    ).toMatchObject({ complete: true, lastSampleTime: asOf });
    expect(() => mapConnectionTrend(input, [{ ...trend(), LastSampleTime: runStartedAt }])).toThrow(
      "sample time",
    );
  });
});
