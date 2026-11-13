import { describe, expect, it } from "vitest";
import { mapSummaryRows } from "../src/mining/read/summary-dto.js";

const request = {
  runId: "11111111-1111-4111-8111-111111111111",
  start: "2026-01-01T11:00:00.000Z",
  end: "2026-01-01T11:10:00.000Z",
};
function row(): Record<string, unknown> {
  return {
    status: "OK",
    plant_id: "D01",
    run_id: request.runId,
    window_start_utc: request.start,
    window_end_utc: request.end,
    line_a_feed_tph: 40,
    line_b_feed_tph: 40,
    line_c_feed_tph: 40,
    plant_feed_tph: 120,
    processed_tonnes: 20,
    running_lines: 3,
    good_sample_count: 100,
    non_good_sample_count: 0,
    uncertain_sample_count: 0,
    bad_sample_count: 0,
    late_sample_count: 0,
    conflicting_event_count: 0,
    gross_process_water_m3_per_t: 0.5,
    whole_plant_energy_kwh_per_t: 2,
    feed_coverage: 1,
    water_coverage: 1,
    power_coverage: 1,
    common_coverage: 1,
    first_event_time: "2026-01-01T11:00:30.0000000Z",
    last_event_time: "2026-01-01T11:09:30.0000000Z",
    first_received_at: "2026-01-01T11:00:31.0000000Z",
    last_received_at: "2026-01-01T11:09:31.0000000Z",
  };
}

describe("mining summary source mapping", () => {
  it("maps pinned KPI units, coverage and line-feed sum", () => {
    expect(mapSummaryRows(request, [row()])).toMatchObject({
      throughput: { value: 120, unit: "t/h", coverage: 1, quality: "good" },
      runningLines: { value: 3, unit: "lines", quality: "good" },
      grossProcessWaterIntensity: { value: 0.5, unit: "m\u00b3/t", quality: "good" },
      energyIntensity: { value: 2, unit: "kWh/t", quality: "good" },
    });
  });

  it("does not promote mixed quality or insufficient common coverage to healthy ratios", () => {
    const mixed = { ...row(), non_good_sample_count: 1, uncertain_sample_count: 1 };
    expect(mapSummaryRows(request, [mixed]).throughput).toMatchObject({
      quality: "uncertain",
      value: null,
    });
    const bad = { ...row(), non_good_sample_count: 1, bad_sample_count: 1 };
    expect(mapSummaryRows(request, [bad]).energyIntensity).toMatchObject({
      quality: "bad",
      value: null,
    });
    const gap = {
      ...row(),
      status: "INSUFFICIENT_COMMON_COVERAGE",
      common_coverage: 0.5,
      gross_process_water_m3_per_t: null,
      whole_plant_energy_kwh_per_t: null,
    };
    expect(mapSummaryRows(request, [gap]).grossProcessWaterIntensity).toMatchObject({
      quality: "missing",
      coverage: 0.5,
      value: null,
    });
  });

  it("keeps unavailable controls distinct and never fabricates zero data", () => {
    expect(mapSummaryRows(request, [{ ...row(), status: "NO_DATA" }]).throughput).toMatchObject({
      value: null,
      coverage: null,
      quality: "missing",
    });
    expect(() =>
      mapSummaryRows(request, [{ ...row(), status: "DUPLICATE_CONFLICT" }]),
    ).toThrowError(expect.objectContaining({ code: "upstream" }));
    expect(() =>
      mapSummaryRows(request, [{ ...row(), status: "BLOCKED_WRITER_APPROVAL" }]),
    ).toThrow("BLOCKED_WRITER_APPROVAL");
  });

  it("rejects malformed, inconsistent or out-of-scope source data", () => {
    const invalid = [
      { ...row(), plant_feed_tph: 119 },
      { ...row(), common_coverage: 1.1 },
      { ...row(), running_lines: 4 },
      { ...row(), status: "STATE_COVERAGE_INCOMPLETE", running_lines: 3 },
      { ...row(), processed_tonnes: null },
      { ...row(), status: "NO_DATA", conflicting_event_count: 1 },
      { ...row(), non_good_sample_count: 1 },
      { ...row(), first_event_time: "2026-01-01T10:59:59Z" },
      { ...row(), window_end_utc: "2026-01-01T11:10:00.0000001Z" },
      { ...row(), energy: Number.NaN, whole_plant_energy_kwh_per_t: Number.NaN },
    ];
    for (const candidate of invalid) {
      expect(() => mapSummaryRows(request, [candidate])).toThrowError(
        expect.objectContaining({ code: "malformed" }),
      );
    }
  });
});
