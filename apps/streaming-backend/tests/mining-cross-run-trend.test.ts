import { describe, expect, it } from "vitest";
import {
  D01_CATALOG_VERSION,
  D01_PLANT_CATALOG,
  D01_PUBLISH_PROFILE_VERSION,
  getD01TagIntervalSeconds,
} from "@triathlon-twin/simulator/mining";
import {
  getMiningCrossRunTrendTags,
  mapMiningCrossRunTrendRows,
} from "../src/mining/read/cross-run-trend-dto.js";
import {
  miningCrossRunTrendQuery,
  prepareMiningCrossRunTrendQuery,
} from "../src/mining/read/cross-run-trend-query.js";

const start = "2026-01-01T12:00:00.000Z";
const end = "2026-01-01T12:05:00.000Z";
const asOf = "2026-01-01T12:06:00.000Z";
const request = {
  start,
  end,
  asOf,
  metric: "feed" as const,
  binMinutes: 5 as const,
};
const fixedNow = () => Date.parse("2026-01-02T00:00:00.000Z");
const tags = new Map(D01_PLANT_CATALOG.telemetry_tags.map((tag) => [tag.id, tag]));

function trendRow(
  tagId = "D01.A.crusher.ore_flow",
  runId = "11111111-1111-4111-8111-111111111111",
  binStart = start,
  override: Record<string, unknown> = {},
): Record<string, unknown> {
  const tag = tags.get(tagId)!;
  const cadence = getD01TagIntervalSeconds(tag);
  const binStartMs = Date.parse(binStart);
  const expected = (5 * 60) / cadence;
  const times = Array.from({ length: expected }, (_, index) =>
    new Date(binStartMs + index * cadence * 1000).toISOString(),
  );
  return {
    row_kind: "point",
    source_status: "READY",
    plant_id: "D01",
    run_id: runId,
    metric_family: "feed",
    start_utc: request.start,
    end_utc: request.end,
    as_of_utc: request.asOf,
    source_contract_version: "d01-validated-source-v1",
    metric: tag.metric,
    tag_id: tag.id,
    module_id: tag.module_id,
    equipment_id: tag.equipment_id,
    unit: tag.unit,
    cadence_seconds: cadence,
    catalog_version: D01_CATALOG_VERSION,
    profile_version: D01_PUBLISH_PROFILE_VERSION,
    bin_start_utc: binStart,
    first_sample_time: times[0],
    last_sample_time: times.at(-1),
    first_received_at: new Date(Date.parse(times[0]!) + 1000).toISOString(),
    last_received_at: new Date(Date.parse(times.at(-1)!) + 1000).toISOString(),
    sample_times: times,
    sample_count: expected,
    expected_samples: expected,
    good_count: expected,
    uncertain_count: 0,
    bad_count: 0,
    conflict_count: 0,
    coverage: 1,
    quality: "good",
    status: "OBSERVED",
    ambiguous_owner: false,
    cadence_conflict: false,
    coverage_complete: true,
    value: 42,
    ...override,
  };
}

describe("bounded cross-run Mining trends", () => {
  it("uses fixed parameterized read-only KQL and pins the reviewed metric catalog", () => {
    const prepared = prepareMiningCrossRunTrendQuery(request, fixedNow);
    expect(prepared.csl).toBe(miningCrossRunTrendQuery);
    expect(prepared.parameters).toEqual({
      plant: "'D01'",
      start: `datetime(${start})`,
      end: `datetime(${end})`,
      asof: `datetime(${asOf})`,
      metric: "'feed'",
      bin_minutes: "5",
    });
    expect(prepared.maximumRows).toBe(1000);
    expect(prepared.responseLimit).toBe(1001);
    expect(prepared.csl).toContain("mining_ValidatedTelemetry");
    expect(prepared.csl).toContain("mining_SourceReadiness()");
    expect(prepared.csl).toContain("received_at <= asof");
    expect(prepared.csl).toContain("timestamp >= start and timestamp < end");
    expect(prepared.csl).toContain("payload_fingerprint");
    expect(prepared.csl).toContain(
      "| join kind=leftsemi (raw | distinct run_id, event_id) on run_id, event_id",
    );
    const identitySource = prepared.csl.split("let identities =")[1]!.split("| summarize")[0]!;
    expect(identitySource).toContain("mining_ValidatedTelemetry");
    expect(identitySource).not.toContain("timestamp >= start");
    expect(identitySource).not.toContain("tag_id in");
    expect(prepared.csl).toContain("make_set(timestamp, 32)");
    expect(prepared.csl).toContain("overlapping_owners");
    expect(prepared.csl).toContain("| take 1001");
    expect(prepared.csl).not.toMatch(/\.(?:set|append|alter|drop)\b/i);
    expect(prepared.csl).not.toMatch(/\b(?:run_id|run)\s*==\s*["']/i);
    expect(prepared.csl).not.toContain("mining_DeduplicatedTelemetry");
    expect(prepared.csl).not.toContain(request.start);
    expect(prepared.csl).not.toContain(request.end);
    for (const tag of getMiningCrossRunTrendTags("feed")) {
      expect(prepared.csl).toContain(`"${tag.tagId}"`);
      expect(prepared.csl).toContain(`"${tag.unit}"`);
    }
    expect(getMiningCrossRunTrendTags("feed").map((tag) => tag.tagId)).toEqual([
      "D01.A.crusher.ore_flow",
      "D01.B.crusher.ore_flow",
      "D01.C.crusher.ore_flow",
    ]);
    expect(getMiningCrossRunTrendTags("density").map((tag) => tag.unit)).toEqual([
      "kg/m3",
      "kg/m3",
      "kg/m3",
    ]);
    expect(getMiningCrossRunTrendTags("vibration").map((tag) => tag.unit)).toEqual([
      "mm/s",
      "mm/s",
      "mm/s",
    ]);
    expect(getMiningCrossRunTrendTags("water-energy").map((tag) => [tag.tagId, tag.unit])).toEqual([
      ["D01.shared.water.level", "%"],
      ["D01.shared.water.water_flow", "m3/h"],
      ["D01.shared.control.power", "kW"],
    ]);
    expect(prepared.csl).toContain(D01_CATALOG_VERSION);
  });

  it("accepts equivalent Eventhouse datetime encodings without accepting a different scope", () => {
    const row = trendRow(undefined, undefined, undefined, {
      start_utc: "2026-01-01T12:00:00Z",
      end_utc: "2026-01-01T12:05:00.0000000Z",
      as_of_utc: "2026-01-01T12:06:00Z",
    });
    expect(mapMiningCrossRunTrendRows(request, [row], fixedNow).points).toHaveLength(1);
    expect(() =>
      mapMiningCrossRunTrendRows(request, [{ ...row, end_utc: "2026-01-01T12:05:01Z" }], fixedNow),
    ).toThrow(/evidence/);
    expect(() =>
      mapMiningCrossRunTrendRows(
        request,
        [{ ...row, end_utc: "2026-01-01T12:05:00.0000001Z" }],
        fixedNow,
      ),
    ).toThrow(/evidence/);
    const preciseReceipt = "2026-01-01T12:00:01.1234567Z";
    expect(
      mapMiningCrossRunTrendRows(request, [{ ...row, first_received_at: preciseReceipt }], fixedNow)
        .points[0]?.firstReceivedAt,
    ).toBe(preciseReceipt);
  });

  it("keeps run ownership distinct and returns actual sample times without gap interpolation", () => {
    const rows = [
      trendRow("D01.A.crusher.ore_flow", "11111111-1111-4111-8111-111111111111", start, {
        ambiguous_owner: true,
        status: "AMBIGUOUS_OWNER",
        value: null,
      }),
      trendRow("D01.A.crusher.ore_flow", "22222222-2222-4222-8222-222222222222", start, {
        ambiguous_owner: true,
        status: "AMBIGUOUS_OWNER",
        value: null,
      }),
    ];
    const mapped = mapMiningCrossRunTrendRows(request, rows, fixedNow);
    expect(mapped.points).toHaveLength(2);
    expect(new Set(mapped.points.map((point) => point.runId)).size).toBe(2);
    expect(mapped.points.every((point) => point.status === "AMBIGUOUS_OWNER")).toBe(true);

    const longWindow = {
      ...request,
      end: "2026-01-01T12:15:00.000Z",
      asOf: "2026-01-01T12:16:00.000Z",
    };
    const gapPoints = mapMiningCrossRunTrendRows(
      longWindow,
      [
        trendRow("D01.A.crusher.ore_flow", undefined, start, {
          end_utc: longWindow.end,
          as_of_utc: longWindow.asOf,
        }),
        trendRow("D01.A.crusher.ore_flow", undefined, "2026-01-01T12:10:00.000Z", {
          end_utc: longWindow.end,
          as_of_utc: longWindow.asOf,
          first_sample_time: "2026-01-01T12:10:00.000Z",
          last_sample_time: "2026-01-01T12:14:30.000Z",
          first_received_at: "2026-01-01T12:10:01.000Z",
          last_received_at: "2026-01-01T12:14:31.000Z",
          sample_times: Array.from({ length: 10 }, (_, index) =>
            new Date(Date.parse("2026-01-01T12:10:00.000Z") + index * 30_000).toISOString(),
          ),
        }),
      ],
      fixedNow,
    );
    expect(gapPoints.points).toHaveLength(2);
    expect(gapPoints.points[0]?.sampleTimes).toHaveLength(10);
    expect(gapPoints.points[0]?.sampleTimes[0]).toBe(start);
    expect(gapPoints.points[0]?.segmentId).not.toBeNull();
    expect(gapPoints.points[1]?.segmentId).not.toBe(gapPoints.points[0]?.segmentId);
  });

  it("preserves a conflicting-only bin outside its non-conflicting schedule as unavailable", () => {
    const row = trendRow(undefined, undefined, start, {
      first_sample_time: start,
      last_sample_time: start,
      first_received_at: "2026-01-01T12:00:01.000Z",
      last_received_at: "2026-01-01T12:00:01.000Z",
      sample_times: [start],
      sample_count: 1,
      expected_samples: null,
      good_count: 0,
      conflict_count: 1,
      coverage: null,
      quality: "conflict",
      status: "CONFLICT",
      cadence_conflict: false,
      coverage_complete: false,
      value: null,
    });
    expect(mapMiningCrossRunTrendRows(request, [row], fixedNow).points[0]).toMatchObject({
      status: "CONFLICT",
      value: null,
      coverage: null,
      expectedSamples: null,
      segmentId: null,
    });
    expect(() =>
      mapMiningCrossRunTrendRows(
        request,
        [
          {
            ...row,
            conflict_count: 0,
            good_count: 1,
            status: "COVERAGE_UNKNOWN",
            quality: "unknown",
          },
        ],
        fixedNow,
      ),
    ).toThrow(/coverage/);
  });

  it("never exposes partial, bad, conflicting or ambiguously owned aggregates as healthy values", () => {
    const partial = trendRow(undefined, undefined, undefined, {
      sample_count: 10,
      good_count: 8,
      uncertain_count: 1,
      bad_count: 1,
      coverage: 0.8,
      quality: "mixed",
      status: "PARTIAL",
      value: null,
    });
    const conflict = trendRow(
      "D01.B.crusher.ore_flow",
      "22222222-2222-4222-8222-222222222222",
      start,
      {
        good_count: 9,
        conflict_count: 1,
        coverage: 0.9,
        quality: "conflict",
        status: "CONFLICT",
        value: null,
      },
    );
    const ambiguous = trendRow(
      "D01.C.crusher.ore_flow",
      "33333333-3333-4333-8333-333333333333",
      start,
      {
        ambiguous_owner: true,
        status: "AMBIGUOUS_OWNER",
        value: null,
      },
    );
    const edge = trendRow("D01.A.crusher.ore_flow", "44444444-4444-4444-8444-444444444444", start, {
      coverage_complete: false,
      status: "COVERAGE_UNKNOWN",
      value: null,
    });
    const badOnly = trendRow(
      "D01.B.crusher.ore_flow",
      "55555555-5555-4555-8555-555555555555",
      start,
      {
        good_count: 0,
        bad_count: 10,
        coverage: 0,
        quality: "bad",
        status: "NON_GOOD",
        value: null,
      },
    );
    const uncertainOnly = trendRow(
      "D01.C.crusher.ore_flow",
      "66666666-6666-4666-8666-666666666666",
      start,
      {
        good_count: 0,
        uncertain_count: 10,
        coverage: 0,
        quality: "uncertain",
        status: "NON_GOOD",
        value: null,
      },
    );
    const mapped = mapMiningCrossRunTrendRows(
      request,
      [partial, conflict, ambiguous, edge, badOnly, uncertainOnly],
      fixedNow,
    );
    expect(mapped.points.map((point) => [point.quality, point.status, point.value])).toEqual([
      ["mixed", "PARTIAL", null],
      ["conflict", "CONFLICT", null],
      ["good", "AMBIGUOUS_OWNER", null],
      ["good", "COVERAGE_UNKNOWN", null],
      ["bad", "NON_GOOD", null],
      ["uncertain", "NON_GOOD", null],
    ]);

    const overfullTimes = Array.from({ length: 11 }, (_, index) =>
      new Date(Date.parse(start) + index * 27_000).toISOString(),
    );
    const cadenceConflict = trendRow(undefined, undefined, undefined, {
      sample_times: overfullTimes,
      sample_count: 11,
      expected_samples: 10,
      good_count: 11,
      first_sample_time: overfullTimes[0],
      last_sample_time: overfullTimes.at(-1),
      first_received_at: new Date(Date.parse(overfullTimes[0]!) + 1000).toISOString(),
      last_received_at: new Date(Date.parse(overfullTimes.at(-1)!) + 1000).toISOString(),
      coverage: null,
      cadence_conflict: true,
      status: "CADENCE_CONFLICT",
      value: null,
    });
    const checkedCadence = mapMiningCrossRunTrendRows(request, [cadenceConflict], fixedNow)
      .points[0];
    expect(checkedCadence).toMatchObject({
      status: "CADENCE_CONFLICT",
      coverage: null,
      value: null,
    });
  });

  it("rejects malformed, duplicate, mismatched and overflow rows and propagates blocked readiness", () => {
    const mismatched = trendRow();
    mismatched.unit = "kg/m3";
    expect(() => mapMiningCrossRunTrendRows(request, [mismatched], fixedNow)).toThrow(/catalog/);
    expect(() => mapMiningCrossRunTrendRows(request, [trendRow(), trendRow()], fixedNow)).toThrow(
      /Duplicate/,
    );
    expect(() =>
      mapMiningCrossRunTrendRows(
        request,
        [
          trendRow(undefined, undefined, undefined, {
            good_count: 8,
            uncertain_count: 1,
            bad_count: 1,
            coverage: 0.8,
            quality: "mixed",
            value: 42,
            status: "PARTIAL",
          }),
        ],
        fixedNow,
      ),
    ).toThrow(/value/);
    expect(() =>
      mapMiningCrossRunTrendRows(
        request,
        Array.from({ length: 1001 }, () => trendRow()),
        fixedNow,
      ),
    ).toThrow(/1000 rows/);
    expect(() =>
      mapMiningCrossRunTrendRows(
        request,
        [
          {
            row_kind: "control",
            source_status: "BLOCKED_CATALOG",
            plant_id: "D01",
            metric_family: "feed",
            start_utc: start,
            end_utc: end,
            as_of_utc: asOf,
          },
        ],
        fixedNow,
      ),
    ).toThrow(/BLOCKED_CATALOG/);
    expect(mapMiningCrossRunTrendRows(request, [], fixedNow).points).toEqual([]);
  });

  it("bounds windows, bin choices and catalog output", () => {
    for (const candidate of [
      { ...request, end: "2026-01-03T12:00:00.000Z", asOf: "2026-01-03T12:01:00.000Z" },
      { ...request, binMinutes: 2 },
      { ...request, metric: "unknown" },
      { ...request, asOf: "2026-01-01T12:04:59.000Z" },
      {
        ...request,
        binMinutes: 1,
        start: "2026-01-01T00:00:00.000Z",
        end: "2026-01-01T06:00:00.000Z",
        asOf: "2026-01-01T06:01:00.000Z",
      },
    ]) {
      expect(() =>
        prepareMiningCrossRunTrendQuery(
          // @ts-expect-error Runtime callers can submit malformed choices.
          candidate,
          fixedNow,
        ),
      ).toThrow(/valid|Invalid/);
    }
    expect(tagsByMetric("water-energy")).toHaveLength(3);
    expect(D01_PUBLISH_PROFILE_VERSION).toBe("d01-publish-profile-v1");
  });
});

function tagsByMetric(metric: "water-energy") {
  return getMiningCrossRunTrendTags(metric);
}
