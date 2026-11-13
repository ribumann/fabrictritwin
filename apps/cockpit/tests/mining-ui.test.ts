import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MiningReads,
  MiningPolling,
  usable,
  formatTimestamp,
  readingAt,
  normalizeReading,
  unknownQuality,
  validIncidentWindows,
  validIncidentAssociation,
  refreshedIncidentSelection,
  sameScope,
  moduleStatus,
  validOverview,
  validAsOf,
  currentIncidentQuery,
  validCurrentAssessmentAsOf,
  validSeries,
} from "../src/ui/public/mining/data.js";
import { connections, relevantTags, visibleModules } from "../src/ui/public/mining/plant.js";

afterEach(() => vi.useRealTimers());
describe("mining request lifecycle", () => {
  it("does not call browser fetch with the MiningReads instance as its receiver", async () => {
    let receiver: unknown;
    const fetchImpl = function (this: unknown) {
      receiver = this;
      return Promise.resolve(new Response("{}"));
    };
    const reads = new MiningReads(fetchImpl);
    await reads.read("context");
    expect(receiver).not.toBe(reads);
  });
  it("reuses identical in-flight and 15-second cached reads, not failures", async () => {
    let now = 0;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ rows: [] })));
    const reads = new MiningReads(fetchImpl, () => now);
    const first = reads.read("context");
    expect(reads.read("context")).toBe(first);
    await first;
    await reads.read("context");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 15_000;
    fetchImpl.mockResolvedValueOnce(new Response("", { status: 503 }));
    await expect(reads.read("context")).rejects.toThrow("503");
    fetchImpl.mockResolvedValueOnce(new Response("{}"));
    await reads.read("context");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it("canonicalizes fields and omits absent optional as-of values", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}"));
    const reads = new MiningReads(fetchImpl);
    await reads.read("overview", { runId: "approved", asOf: undefined, plantId: "D01" });
    await reads.read("overview", { plantId: "D01", runId: "approved" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).not.toContain("undefined");
  });
  it("aborts pending work when the view changes", async () => {
    let signal: AbortSignal | undefined;
    const reads = new MiningReads((_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    });
    const pending = reads.read("context");
    reads.abort();
    await expect(pending).rejects.toThrow("aborted");
    expect(signal?.aborted).toBe(true);
  });
  it("uses consolidated 30/60-second polling and stops hidden/replay/disconnected work", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const polling = new MiningPolling(refresh);
    polling.update({ mode: "live", hidden: false, connected: true });
    vi.advanceTimersByTime(60_000);
    expect(refresh.mock.calls.map(([scope]) => scope)).toEqual(["overview", "overview", "detail"]);
    for (const state of [
      { mode: "replay", hidden: false, connected: true },
      { mode: "live", hidden: true, connected: true },
      { mode: "live", hidden: false, connected: false },
    ]) {
      polling.update(state);
      vi.advanceTimersByTime(120_000);
      expect(refresh).toHaveBeenCalledTimes(3);
    }
    polling.update({ mode: "live", hidden: false, connected: true });
    polling.update({ mode: "live", hidden: false, connected: true });
    vi.advanceTimersByTime(30_000);
    expect(refresh).toHaveBeenCalledTimes(4);
    polling.stop();
  });
});
describe("unknown and catalog selection semantics", () => {
  it("accepts an absent current hold without weakening the evidence window", () => {
    const incident = {
      holdWindowStart: null,
      holdWindowEnd: null,
      evidenceWindowStart: "2026-01-01T00:00:00Z",
      evidenceWindowEnd: "2026-01-01T00:05:00Z",
    };
    expect(validIncidentWindows(incident)).toBe(true);
    expect(
      validIncidentWindows({
        ...incident,
        holdWindowStart: "2026-01-01T00:00:00Z",
      }),
    ).toBe(false);
    expect(
      validIncidentWindows({
        ...incident,
        evidenceWindowEnd: "2025-12-31T23:59:00Z",
      }),
    ).toBe(false);
    expect(
      validIncidentWindows({
        ...incident,
        holdWindowStart: "2026-01-01T00:01:00Z",
        holdWindowEnd: "2026-01-01T00:00:00Z",
      }),
    ).toBe(false);
  });
  it("rejects non-string evidence-window bounds before parsing", () => {
    const incident = {
      holdWindowStart: null,
      holdWindowEnd: null,
      evidenceWindowStart: "2026-01-01T00:00:00Z",
      evidenceWindowEnd: "2026-01-01T00:05:00Z",
    };
    expect(validIncidentWindows({ ...incident, evidenceWindowStart: 2026 })).toBe(false);
    expect(validIncidentWindows({ ...incident, evidenceWindowEnd: 2026 })).toBe(false);
  });
  it("keeps incident assessments current-only and separates measurement time from replay time", () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    const replayParams = {
      plantId: "D01",
      runId: "approved",
      asOf: "2026-01-01T11:59:00Z",
    };
    expect(currentIncidentQuery("replay", replayParams)).toBeNull();
    expect(currentIncidentQuery("live", replayParams)).toEqual({
      plantId: "D01",
      runId: "approved",
    });
    expect(validCurrentAssessmentAsOf(replayParams.asOf, now)).toBe(true);
    expect(validCurrentAssessmentAsOf("2026-01-01T11:58:00Z", now)).toBe(false);
    expect(validCurrentAssessmentAsOf("not-a-timestamp", now)).toBe(false);
    expect(validCurrentAssessmentAsOf(2026, Date.parse("2026-01-01T00:00:00Z"))).toBe(false);
  });
  it("allows only canonical module associations and does not invent a metric for state-only incidents", () => {
    const catalog = { modules: [{ id: "D01.A.crusher" }] };
    expect(
      validIncidentAssociation(
        { moduleId: null, metric: null, affectedModuleIds: [] },
        catalog,
      ),
    ).toBe(true);
    expect(
      validIncidentAssociation(
        { moduleId: null, metric: "feed", affectedModuleIds: [] },
        catalog,
      ),
    ).toBe(false);
    expect(
      validIncidentAssociation(
        {
          moduleId: "D01.A.crusher",
          metric: null,
          affectedModuleIds: ["D01.A.crusher"],
        },
        catalog,
      ),
    ).toBe(true);
    expect(
      validIncidentAssociation(
        { moduleId: "D01.foreign.crusher", metric: "vibration", affectedModuleIds: [] },
        catalog,
      ),
    ).toBe(false);
  });
  it("refreshes selected incident data and clears a selection no longer active", () => {
    const selected = {
      incidentId: "incident-1",
      holdWindowStart: "2026-01-01T00:00:00Z",
      holdWindowEnd: "2026-01-01T00:05:00Z",
    };
    const refreshed = {
      incidentId: "incident-1",
      holdWindowStart: null,
      holdWindowEnd: null,
    };
    expect(refreshedIncidentSelection(selected, [refreshed])).toBe(refreshed);
    expect(refreshedIncidentSelection(selected, [])).toBeNull();
    expect(refreshedIncidentSelection(null, [refreshed])).toBeNull();
  });
  it("preserves uncertain quality without exposing its value as usable or healthy", () => {
    const asOf = "2026-01-01T00:01:00Z";
    const reading = {
      moduleId: "D01.A.crusher",
      quality: "uncertain",
      value: 42,
      sampleTime: "2026-01-01T00:00:00Z",
      ageSeconds: 60,
    };
    const normalized = normalizeReading(reading, asOf);
    expect(normalized).toMatchObject({ quality: "uncertain", value: null });
    expect(usable(reading)).toBe(false);
    expect(readingAt(reading, asOf)).toBe(false);
    expect(unknownQuality(normalized.quality)).toBe("uncertain / unknown");
    expect(
      moduleStatus(
        {
          quality: "good",
          latest: {
            modules: [{ moduleId: reading.moduleId, status: "normal" }],
            readings: [normalized],
          },
        },
        reading.moduleId,
      ),
    ).toBe("unknown");
    expect(normalizeReading({ ...reading, quality: "unsupported" }, asOf).quality).toBe("missing");
  });
  it("keeps absent or invalid ingestion timestamps unknown", () => {
    expect(formatTimestamp(null)).toBe("unknown");
    expect(formatTimestamp(undefined)).toBe("unknown");
    expect(formatTimestamp("not-a-timestamp")).toBe("unknown");
    expect(formatTimestamp("2026-01-01T00:00:00Z")).toBe("2026-01-01T00:00:00.000Z");
  });
  it("rejects same-run replay details for another time, metric, module, unit or bin", () => {
    const params = {
      runId: "approved",
      moduleId: "D01.A.dms",
      metric: "density",
      start: "2026-01-01T00:00:00Z",
      end: "2026-01-01T00:30:00Z",
      binMinutes: "1",
      maxRows: "1000",
    };
    const row = { seriesId: "D01.A.dms.medium_density", unit: "SG", timestamp: params.start };
    const data = {
      plantId: "D01",
      runId: "approved",
      catalogVersion: "pinned",
      moduleId: params.moduleId,
      metric: "density",
      windowStart: params.start,
      windowEnd: params.end,
      binMinutes: 1,
      rows: [row],
    };
    const catalog = {
      telemetry_tags: [
        { id: row.seriesId, module_id: params.moduleId, metric: "medium_density", unit: "SG" },
      ],
    };
    expect(validSeries(data, params, "pinned", catalog)).toBe(true);
    for (const change of [
      { metric: "vibration" },
      { moduleId: "D01.B.dms" },
      { windowEnd: "2026-01-01T00:31:00Z" },
      { binMinutes: 5 },
      { rows: [{ ...row, unit: "kg" }] },
      { rows: [{ ...row, timestamp: "2025-12-31T23:59:00Z" }] },
    ])
      expect(validSeries({ ...data, ...change }, params, "pinned", catalog)).toBe(false);
    expect(validAsOf(params.start, params.start, true)).toBe(true);
    expect(validAsOf(params.start, params.end, true)).toBe(false);
  });
  it("does not treat missing, bad, stale or nonfinite readings as healthy zero", () => {
    for (const quality of ["missing", "bad", "stale"])
      expect(usable({ quality, value: 0 })).toBe(false);
    expect(usable({ quality: "good", value: null })).toBe(false);
    expect(usable({ quality: "good", value: NaN })).toBe(false);
    expect(usable({ quality: "good", value: 0 })).toBe(false);
    expect(usable({ quality: "good", value: 0, sampleTime: "2026-01-01T00:00:00Z" })).toBe(true);
    expect(
      readingAt(
        { quality: "good", value: 0, sampleTime: "2026-01-01T00:00:00Z", ageSeconds: 60 },
        "2026-01-01T00:01:00Z",
      ),
    ).toBe(true);
    expect(
      readingAt(
        { quality: "good", value: 0, sampleTime: "2026-01-01T00:00:00Z", ageSeconds: 60 },
        "2026-11-01T00:01:00Z",
      ),
    ).toBe(false);
    expect(moduleStatus(null, "D01.A.crusher")).toBe("unknown");
    expect(
      moduleStatus(
        {
          quality: "good",
          latest: {
            modules: [{ moduleId: "D01.A.crusher", status: "normal" }],
            readings: [{ moduleId: "D01.A.crusher", quality: "bad", value: 0 }],
          },
        },
        "D01.A.crusher",
      ),
    ).toBe("unknown");
  });
  it("evaluates replay at replay time and refuses incomplete/stale overviews", () => {
    const data = {
      plantId: "D01",
      runId: "approved",
      catalogVersion: "pinned",
      run: { plantId: "D01", runId: "approved", catalogVersion: "pinned" },
      asOf: "2026-01-01T00:00:00Z",
      latest: { modules: Array(24).fill({}), readings: Array(56).fill({}) },
    };
    expect(validOverview(data, "approved", "pinned", "2026-01-01T00:00:00Z", true)).toBe(true);
    expect(validOverview(data, "approved", "pinned", "2026-11-01T00:00:00Z", false)).toBe(false);
    expect(validOverview(data, "foreign", "pinned", data.asOf, true)).toBe(false);
    expect(sameScope(data, "approved", "other-catalog")).toBe(false);
    expect(
      validOverview(
        { ...data, run: { ...data.run, catalogVersion: "foreign" } },
        "approved",
        "pinned",
        data.asOf,
        true,
      ),
    ).toBe(false);
    expect(
      validOverview(
        { ...data, latest: { modules: [], readings: [] } },
        "approved",
        "pinned",
        data.asOf,
        true,
      ),
    ).toBe(false);
  });
  it("selects only authored tags, links and visible modules; untagged equipment has none", () => {
    const catalog = {
      modules: [
        { id: "D01.A.dms", kind: "dms", line: "A" },
        { id: "D01.shared.lab", kind: "lab", line: "shared" },
      ],
      telemetry_tags: [
        { id: "D01.A.dms.motor_current", module_id: "D01.A.dms", metric: "motor_current" },
        { id: "D01.A.dms.feed_pressure", module_id: "D01.A.dms", metric: "feed_pressure" },
        { id: "D01.A.dms.medium_density", module_id: "D01.A.dms", metric: "medium_density" },
      ],
      streams: [{ source: { module_id: "D01.A.dms" }, target: { module_id: "D01.shared.lab" } }],
    };
    expect(relevantTags(catalog, "D01.A.dms").map((tag: { metric: string }) => tag.metric)).toEqual(
      ["medium_density", "feed_pressure"],
    );
    expect(relevantTags(catalog, "D01.shared.lab")).toEqual([]);
    expect(connections(catalog, "D01.shared.lab", "upstream")).toEqual(["D01.A.dms"]);
    expect(visibleModules(catalog, new Set(["shared"]))).toEqual([catalog.modules[1]]);
  });
});
