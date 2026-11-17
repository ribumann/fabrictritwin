import { describe, expect, it, vi } from "vitest";
import {
  D01_CATALOG_VERSION,
  D01_PLANT_CATALOG,
  D01_PUBLISH_PROFILE_VERSION,
  getD01TagIntervalSeconds,
} from "@triathlon-twin/simulator/mining";
import { createD01RunContract } from "../src/mining-incidents/catalog.js";
import type { ContinuousMiningRunRecord } from "../src/mining/run-coordinator.js";
import { mapContinuousThroughput } from "../src/mining/read/continuous-dto.js";
import { createMiningContinuousProvider } from "../src/mining/read/continuous-provider.js";

const asOf = "2026-01-01T12:00:00.000Z";
const request = Date.parse(asOf);
const cutoff = "2026-01-01T11:59:00.000Z";
const run: ContinuousMiningRunRecord = {
  plantId: "D01",
  runId: "11111111-1111-4111-8111-111111111111",
  scenario: "normal",
  seed: 1,
  lifetime: { kind: "continuous", generation: "release-1" },
  contract: createD01RunContract(),
  phase: "running",
  startedAt: "2026-01-01T11:40:00.000Z",
  authorityUntil: "2026-01-01T12:00:40.000Z",
};
const feedTagIds = ["D01.A.crusher.ore_flow", "D01.B.crusher.ore_flow", "D01.C.crusher.ore_flow"];
const feedIds = new Set(feedTagIds);
const lines = ["A", "B", "C"] as const;
const event = (sequence: number) => sequence.toString(16).padStart(64, "0");
const iso = (value: number) => new Date(value).toISOString();
function rows(): Record<string, unknown>[] {
  const telemetry = D01_PLANT_CATALOG.telemetry_tags.map((tag, index) => {
    const cadence = getD01TagIntervalSeconds(tag);
    const line = tag.id.split(".")[1];
    const latestTime = feedIds.has(tag.id)
      ? line === "A"
        ? Date.parse(cutoff)
        : Date.parse(cutoff) + 30_000
      : request - cadence * 1_000;
    const latestSequence = index + 1;
    const feedIndex = feedTagIds.indexOf(tag.id);
    const sourceValue =
      feedIndex >= 0
        ? 40 + feedIndex
        : (tag.simulation_envelope[0] + tag.simulation_envelope[1]) / 2;
    const feed = feedIds.has(tag.id);
    return {
      source_status: "READY",
      plant_id: "D01",
      run_id: run.runId,
      as_of_utc: asOf,
      watermark: cutoff,
      window_start: "2026-01-01T11:54:00.000Z",
      row_kind: "tag",
      catalog_version: D01_CATALOG_VERSION,
      profile_version: D01_PUBLISH_PROFILE_VERSION,
      source_contract_version: "d01-validated-source-v1",
      tag_id: tag.id,
      module_id: tag.module_id,
      equipment_id: tag.equipment_id,
      unit: tag.unit,
      cadence_seconds: cadence,
      latest_timestamp: iso(latestTime),
      latest_received_at: iso(Math.min(latestTime + 10_000, request)),
      latest_sequence: latestSequence,
      latest_event_id: event(latestSequence),
      latest_module_id: tag.module_id,
      latest_equipment_id: tag.equipment_id,
      latest_value: sourceValue,
      latest_quality: "good",
      latest_unit: tag.unit,
      latest_interval_seconds: cadence,
      latest_conflict: false,
      sample_time: feed ? cutoff : null,
      received_at: feed ? "2026-01-01T11:59:35.000Z" : null,
      sequence: feed ? 100 + index : null,
      event_id: feed ? event(100 + index) : "",
      value: feed ? 40 + feedIndex : null,
      quality: feed ? "good" : "",
      interval_seconds: feed ? cadence : null,
      event_conflict: false,
      sample_count: feed ? 10 : 0,
      distinct_timestamps: feed ? 10 : 0,
      usable_samples: feed ? 10 : 0,
      average_value: feed ? 40 + feedIndex * 2 : null,
      first_sample: feed ? "2026-01-01T11:54:30.000Z" : null,
      last_sample: feed ? cutoff : null,
      window_received_at: feed ? "2026-01-01T11:59:35.000Z" : null,
      scope_id: "",
      state: "",
      scheduled_running: null,
      state_timestamp: null,
      state_received_at: null,
      state_sequence: null,
      state_event_id: "",
      state_conflict: false,
    };
  });
  const states = lines.map((scopeId, index) => ({
    source_status: "READY",
    plant_id: "D01",
    run_id: run.runId,
    as_of_utc: asOf,
    watermark: cutoff,
    window_start: "2026-01-01T11:54:00.000Z",
    row_kind: "state",
    catalog_version: D01_CATALOG_VERSION,
    profile_version: "",
    source_contract_version: "d01-validated-source-v1",
    tag_id: "",
    module_id: "",
    equipment_id: "",
    unit: "",
    cadence_seconds: null,
    latest_timestamp: null,
    latest_received_at: null,
    latest_sequence: null,
    latest_event_id: "",
    latest_module_id: "",
    latest_equipment_id: "",
    latest_value: null,
    latest_quality: "",
    latest_unit: "",
    latest_interval_seconds: null,
    latest_conflict: false,
    sample_time: null,
    received_at: null,
    sequence: null,
    event_id: "",
    value: null,
    quality: "",
    interval_seconds: null,
    event_conflict: false,
    sample_count: 0,
    distinct_timestamps: 0,
    usable_samples: 0,
    average_value: null,
    first_sample: null,
    last_sample: null,
    window_received_at: null,
    scope_id: scopeId,
    state: "running",
    scheduled_running: true,
    state_timestamp: "2026-01-01T11:59:00.000Z",
    state_received_at: "2026-01-01T11:59:15.000Z",
    state_sequence: 1000 + index,
    state_event_id: event(1000 + index),
    state_conflict: false,
  }));
  return [...telemetry, ...states];
}

describe("continuous D01 evidence", () => {
  it("preserves the feed contract and adds exactly 53 tags plus three line states", () => {
    const data = mapContinuousThroughput(run, asOf, rows());
    expect(data.throughput).toEqual({ value: 126, unit: "t/h", quality: "good", coverage: 1 });
    expect(data.watermarkLagSeconds).toBe(60);
    expect(data.readings[0]).toMatchObject({
      value: 40,
      average: 40,
      ageSeconds: 60,
      receivedAt: "2026-01-01T11:59:35.000Z",
      sampleCount: 10,
      latestValue: 40,
      latestEventId: event(
        D01_PLANT_CATALOG.telemetry_tags.findIndex((tag) => tag.id === feedTagIds[0]) + 1,
      ),
    });
    expect(data.detail.readings).toHaveLength(53);
    expect(data.detail.lineStates.map((state) => state.scopeId)).toEqual(["A", "B", "C"]);
    expect(data.detail.runningLines).toEqual({ value: 3, unit: "lines", quality: "good" });
    expect(data.detail.readings[0]).toMatchObject({
      tagId: expect.any(String),
      equipmentId: expect.any(String),
      quality: "good",
      sampleTime: expect.any(String),
      receivedAt: expect.any(String),
      eventId: expect.any(String),
    });
    expect(data.capabilities.incidents).toBe(false);
    expect(data).not.toHaveProperty("ingestion");
  });

  it("requires the exact pinned 56-tag plus three-state scaffold and provenance", () => {
    const evidence = rows();
    expect(evidence.filter((row) => row.row_kind === "tag")).toHaveLength(56);
    expect(evidence.filter((row) => row.row_kind === "state")).toHaveLength(3);
    for (const change of [
      (row: Record<string, unknown>) => (row.module_id = "foreign"),
      (row: Record<string, unknown>) => (row.equipment_id = "foreign"),
      (row: Record<string, unknown>) => (row.unit = "kg"),
      (row: Record<string, unknown>) => (row.cadence_seconds = 60),
      (row: Record<string, unknown>) => (row.catalog_version = "other"),
      (row: Record<string, unknown>) => (row.profile_version = "other"),
      (row: Record<string, unknown>) => (row.source_contract_version = "other"),
      (row: Record<string, unknown>) => (row.plant_id = "other"),
      (row: Record<string, unknown>) => (row.run_id = "other"),
      (row: Record<string, unknown>) => (row.as_of_utc = "2026-01-01T12:00:01.000Z"),
    ]) {
      const corrupted = rows();
      change(corrupted[0]);
      expect(() => mapContinuousThroughput(run, asOf, corrupted)).toThrow("Invalid continuous");
    }
    const incomplete = rows();
    incomplete.pop();
    expect(() => mapContinuousThroughput(run, asOf, incomplete)).toThrow("Invalid continuous");
    const duplicate = rows();
    duplicate[1].tag_id = duplicate[0].tag_id;
    expect(() => mapContinuousThroughput(run, asOf, duplicate)).toThrow("Invalid continuous");
  });

  it("uses request UTC and the exact per-tag cadence age boundary", () => {
    const sixtySecondTag = D01_PLANT_CATALOG.telemetry_tags.find(
      (tag) => getD01TagIntervalSeconds(tag) === 60,
    )!;
    const exact = rows();
    const target = exact.find((row) => row.tag_id === sixtySecondTag.id)!;
    target.latest_timestamp = iso(request - 195_000);
    target.latest_received_at = iso(request - 190_000);
    expect(
      mapContinuousThroughput(run, asOf, exact).detail.readings.find(
        (reading) => reading.tagId === sixtySecondTag.id,
      ),
    ).toMatchObject({
      quality: "good",
      value: (sixtySecondTag.simulation_envelope[0] + sixtySecondTag.simulation_envelope[1]) / 2,
    });
    const stale = rows();
    const staleTarget = stale.find((row) => row.tag_id === sixtySecondTag.id)!;
    staleTarget.latest_timestamp = iso(request - 196_000);
    staleTarget.latest_received_at = iso(request - 190_000);
    expect(
      mapContinuousThroughput(run, asOf, stale).detail.readings.find(
        (reading) => reading.tagId === sixtySecondTag.id,
      ),
    ).toMatchObject({ quality: "stale", value: null });
    const future = rows();
    future.find((row) => row.tag_id === sixtySecondTag.id)!.latest_timestamp =
      "2026-01-01T12:00:01.000Z";
    expect(() => mapContinuousThroughput(run, asOf, future)).toThrow("Invalid continuous");
  });

  it("does not launder a stale request through an older common watermark", () => {
    const later = "2026-01-01T12:01:00.000Z";
    const evidence = rows().map((row) => ({ ...row, as_of_utc: later }));
    const data = mapContinuousThroughput(run, later, evidence);
    expect(data.quality).toBe("unavailable");
    expect(data.readings.every((reading) => reading.quality === "stale")).toBe(true);
    expect(data.throughput.value).toBeNull();
  });

  it("preserves observed versus usable coverage and fails closed on a bad window sample", () => {
    const evidence = rows();
    const feed = evidence.find((row) => row.tag_id === feedTagIds[0])!;
    feed.usable_samples = 9;
    const bad = mapContinuousThroughput(run, asOf, evidence);
    expect(bad.readings[0]).toMatchObject({
      quality: "bad",
      coverage: 0.9,
      observationCoverage: 1,
    });
    expect(bad.throughput.value).toBeNull();
    feed.sample_count = feed.distinct_timestamps = 9;
    const absent = mapContinuousThroughput(run, asOf, evidence);
    expect(absent.readings[0]).toMatchObject({
      quality: "good",
      coverage: 0.9,
      observationCoverage: 0.9,
    });
    const warming = mapContinuousThroughput(
      { ...run, startedAt: "2026-01-01T11:55:00.000Z" },
      asOf,
      evidence,
    );
    expect(warming.throughput.value).toBeNull();
    expect(warming.readings.every((reading) => reading.quality === "warming_up")).toBe(true);
  });

  it("suppresses unresolved telemetry and state payloads and requires all three states for the count", () => {
    const conflicted = rows();
    const tag = conflicted.find((row) => row.tag_id === D01_PLANT_CATALOG.telemetry_tags[0].id)!;
    Object.assign(tag, {
      latest_timestamp: null,
      latest_received_at: null,
      latest_sequence: null,
      latest_event_id: "",
      latest_module_id: "",
      latest_equipment_id: "",
      latest_value: null,
      latest_quality: "",
      latest_unit: "",
      latest_interval_seconds: null,
      latest_conflict: true,
    });
    const conflictedData = mapContinuousThroughput(run, asOf, conflicted);
    expect(
      conflictedData.detail.readings.find(
        (reading) => reading.tagId === D01_PLANT_CATALOG.telemetry_tags[0].id,
      ),
    ).toMatchObject({ quality: "bad", value: null, sampleTime: null, eventId: null });
    const oneStateConflict = rows();
    const state = oneStateConflict.find((row) => row.row_kind === "state" && row.scope_id === "B")!;
    Object.assign(state, {
      state: "",
      scheduled_running: null,
      state_timestamp: null,
      state_received_at: null,
      state_sequence: null,
      state_event_id: "",
      state_conflict: true,
    });
    const conflictData = mapContinuousThroughput(run, asOf, oneStateConflict);
    expect(conflictData.detail.lineStates[1]).toMatchObject({ quality: "bad", state: null });
    expect(conflictData.detail.runningLines).toEqual({
      value: null,
      unit: "lines",
      quality: "unavailable",
    });
    const missingState = rows();
    const missing = missingState.find((row) => row.row_kind === "state" && row.scope_id === "C")!;
    Object.assign(missing, {
      state: "",
      scheduled_running: null,
      state_timestamp: null,
      state_received_at: null,
      state_sequence: null,
      state_event_id: "",
    });
    expect(mapContinuousThroughput(run, asOf, missingState).detail.runningLines.value).toBeNull();
  });

  it("counts only explicit running and scheduled-running observations", () => {
    const evidence = rows();
    const lineB = evidence.find((row) => row.row_kind === "state" && row.scope_id === "B")!;
    lineB.state = "idle";
    const lineC = evidence.find((row) => row.row_kind === "state" && row.scope_id === "C")!;
    lineC.scheduled_running = false;
    expect(mapContinuousThroughput(run, asOf, evidence).detail.runningLines).toEqual({
      value: 1,
      unit: "lines",
      quality: "good",
    });
  });

  it("maps an empty live scaffold without claiming telemetry, state, or zero running lines", () => {
    const evidence = rows();
    for (const row of evidence) {
      row.watermark = null;
      row.window_start = null;
      for (const name of [
        "latest_timestamp",
        "latest_received_at",
        "latest_sequence",
        "latest_value",
        "latest_interval_seconds",
        "sample_time",
        "received_at",
        "sequence",
        "value",
        "interval_seconds",
        "average_value",
        "first_sample",
        "last_sample",
        "window_received_at",
        "state_timestamp",
        "state_received_at",
        "state_sequence",
        "scheduled_running",
      ])
        row[name] = null;
      for (const name of [
        "latest_event_id",
        "latest_module_id",
        "latest_equipment_id",
        "latest_quality",
        "latest_unit",
        "event_id",
        "quality",
        "state_event_id",
        "state",
      ])
        row[name] = "";
      row.sample_count = row.distinct_timestamps = row.usable_samples = 0;
    }
    const data = mapContinuousThroughput(run, asOf, evidence);
    expect(data.watermark).toBeNull();
    expect(data.throughput.value).toBeNull();
    expect(data.detail.readings.every((reading) => reading.quality === "missing")).toBe(true);
    expect(data.detail.lineStates.every((state) => state.quality === "missing")).toBe(true);
    expect(data.detail.runningLines.value).toBeNull();
  });

  it("keeps stale state unavailable independently of good throughput and validates state identity", () => {
    const evidence = rows();
    const state = evidence.find((row) => row.scope_id === "A")!;
    state.state_timestamp = iso(request - 196_000);
    state.state_received_at = iso(request - 190_000);
    const data = mapContinuousThroughput(run, asOf, evidence);
    expect(data.throughput.quality).toBe("good");
    expect(data.detail.lineStates[0]).toMatchObject({ quality: "stale", state: "running" });
    expect(data.detail.runningLines.value).toBeNull();
    for (const change of [
      { scope_id: "shared" },
      { state: "healthy" },
      { state_event_id: "invalid" },
      { state_received_at: "2026-01-01T12:00:01.000Z" },
      { scheduled_running: "true" },
    ]) {
      const corrupt = rows();
      Object.assign(
        corrupt.find((row) => row.scope_id === "A")!,
        change,
      );
      expect(() => mapContinuousThroughput(run, asOf, corrupt)).toThrow("Invalid continuous");
    }
  });

  it("keeps unavailable source readiness distinct from successful line and tag evidence", () => {
    const evidence = rows().map((row) => ({ ...row, source_status: "BLOCKED_PROFILE" }));
    const data = mapContinuousThroughput(run, asOf, evidence);
    expect(data.quality).toBe("unavailable");
    expect(data.throughput.value).toBeNull();
    expect(data.detail.sourceStatus).toBe("BLOCKED_PROFILE");
    expect(data.detail.readings.every((reading) => reading.quality === "unavailable")).toBe(true);
    expect(data.detail.runningLines.value).toBeNull();
  });

  it("rejects malformed, future, or conflicting feed evidence without inventing a KPI", () => {
    for (const change of [
      { watermark: "2026-01-01T11:58:30.000Z" },
      { latest_received_at: "2026-01-01T12:00:01.000Z" },
      { latest_conflict: null },
      { latest_value: Number.NaN },
      { distinct_timestamps: 9 },
      { sample_count: 11 },
      { value: Number.NaN },
    ]) {
      const evidence = rows();
      Object.assign(
        evidence.find((row) => row.tag_id === feedTagIds[0])!,
        change,
      );
      expect(() => mapContinuousThroughput(run, asOf, evidence)).toThrow("Invalid continuous");
    }
    const feedConflict = rows();
    const feed = feedConflict.find((row) => row.tag_id === "D01.A.crusher.ore_flow")!;
    Object.assign(feed, {
      sample_time: null,
      received_at: null,
      sequence: null,
      event_id: "",
      value: null,
      quality: "",
      unit: "t/h",
      interval_seconds: null,
      event_conflict: true,
    });
    expect(mapContinuousThroughput(run, asOf, feedConflict).throughput.value).toBeNull();
  });

  it("uses only the bounded read when independently enabled and requests the 59-row cap", async () => {
    const query = vi.fn(async () => rows());
    const signal = new AbortController().signal;
    await expect(createMiningContinuousProvider({}, query)(run, asOf, signal)).rejects.toThrow(
      "disabled",
    );
    const result = await createMiningContinuousProvider(
      { MINING_CONTINUOUS_READ_ENABLED: "true" },
      query,
    )(run, asOf, signal);
    expect(result.throughput.value).toBe(126);
    expect(query).toHaveBeenCalledExactlyOnceWith(
      { kind: "continuous-throughput", runId: run.runId, asOf, maxRows: 59 },
      signal,
    );
  });
});
