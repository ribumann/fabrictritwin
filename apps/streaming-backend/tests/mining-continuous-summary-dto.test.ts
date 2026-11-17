import { describe, expect, it } from "vitest";
import { createD01RunContract } from "../src/mining-incidents/catalog.js";
import type { ContinuousMiningRunRecord } from "../src/mining/run-coordinator.js";
import { mapContinuousSummaryRows } from "../src/mining/read/continuous-summary-dto.js";

const asOf = "2026-01-01T12:00:00.000Z";
const runId = "11111111-1111-4111-8111-111111111111";
const run: ContinuousMiningRunRecord = {
  plantId: "D01",
  runId,
  scenario: "normal",
  seed: 1,
  lifetime: { kind: "continuous", generation: "release-1" },
  contract: createD01RunContract(),
  phase: "running",
  startedAt: "2026-01-01T07:00:00.000Z",
  authorityUntil: "2026-01-01T12:00:40.000Z",
};
const durations = { "30m": 30 * 60_000, "2h": 2 * 60 * 60_000, "24h": 24 * 60 * 60_000 } as const;

function row(windowId: keyof typeof durations, overrides: Record<string, unknown> = {}) {
  const end = Date.parse(asOf);
  const start = new Date(end - durations[windowId]).toISOString();
  const first = new Date(Date.parse(start) + 30_000).toISOString();
  const last = new Date(end - 30_000).toISOString();
  return {
    window_id: windowId,
    status: "OK",
    plant_id: "D01",
    run_id: runId,
    window_start_utc: start,
    window_end_utc: asOf,
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
    common_coverage: 0.96,
    first_event_time: first,
    last_event_time: last,
    first_received_at: new Date(Date.parse(first) + 1_000).toISOString(),
    last_received_at: new Date(Date.parse(last) + 1_000).toISOString(),
    ...overrides,
  };
}

describe("continuous PlantSummary mapping", () => {
  it("maps only the three exact run-scoped windows and preserves common coverage", () => {
    const result = mapContinuousSummaryRows(run, asOf, [
      row("30m", { common_coverage: 0.966667, gross_process_water_m3_per_t: 2.1502 }),
      row("2h", { common_coverage: 0.991667, whole_plant_energy_kwh_per_t: 1.7066 }),
      row("24h", {
        status: "INSUFFICIENT_COMMON_COVERAGE",
        common_coverage: 0.127083,
        gross_process_water_m3_per_t: null,
        whole_plant_energy_kwh_per_t: null,
      }),
    ]);

    expect(result.windows[0]).toMatchObject({
      window: "30m",
      status: "OK",
      grossProcessWaterIntensity: {
        value: 2.1502,
        unit: "m\u00b3/t",
        coverage: 0.966667,
        quality: "good",
      },
    });
    expect(result.windows[1]).toMatchObject({
      window: "2h",
      energyIntensity: { value: 1.7066, unit: "kWh/t", coverage: 0.991667, quality: "good" },
    });
    expect(result.windows[2]).toMatchObject({
      window: "24h",
      status: "INSUFFICIENT_COMMON_COVERAGE",
      grossProcessWaterIntensity: { value: null, coverage: 0.127083, quality: "missing" },
      energyIntensity: { value: null, coverage: 0.127083, quality: "missing" },
    });
    expect(result).toMatchObject({
      plantId: "D01",
      runId,
      generation: "release-1",
      asOf,
    });
  });

  it("keeps a rejected source window unavailable without discarding other windows", () => {
    const result = mapContinuousSummaryRows(run, asOf, [
      row("30m", { status: "DUPLICATE_CONFLICT" }),
      row("2h"),
      row("24h"),
    ]);

    expect(result.windows[0]).toMatchObject({
      status: "SOURCE_REJECTED",
      grossProcessWaterIntensity: { value: null, quality: "unavailable", coverage: null },
    });
    expect(result.windows[1].grossProcessWaterIntensity.quality).toBe("good");
  });

  it("returns explicit unavailable windows when the bounded summary query fails", () => {
    const result = mapContinuousSummaryRows(run, asOf, null);
    expect(result.windows).toHaveLength(3);
    expect(result.windows.every((window) => window.status === "QUERY_UNAVAILABLE")).toBe(true);
    expect(
      result.windows.every((window) => window.energyIntensity.value === null),
    ).toBe(true);
  });

  it("rejects duplicate, missing, foreign-run and misaligned window rows", () => {
    for (const candidate of [
      [row("30m"), row("30m"), row("24h")],
      [row("30m"), row("2h")],
      [row("30m"), row("2h", { run_id: "22222222-2222-4222-8222-222222222222" }), row("24h")],
      [row("30m"), row("2h", { window_end_utc: "2026-01-01T11:59:59.000Z" }), row("24h")],
    ]) {
      expect(() => mapContinuousSummaryRows(run, asOf, candidate)).toThrow(
        "Invalid continuous Mining summary evidence",
      );
    }
  });
});
