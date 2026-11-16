import { describe, expect, it, vi } from "vitest";
import { createD01RunContract } from "../src/mining-incidents/catalog.js";
import type { ContinuousMiningRunRecord } from "../src/mining/run-coordinator.js";
import { mapContinuousThroughput } from "../src/mining/read/continuous-dto.js";
import { createMiningContinuousProvider } from "../src/mining/read/continuous-provider.js";

const asOf = "2026-01-01T12:00:00.000Z";
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
function rows(): Record<string, unknown>[] {
  return ["A", "B", "C"].map((line, index) => ({
    source_status: "READY",
    plant_id: "D01",
    run_id: run.runId,
    as_of_utc: asOf,
    tag_id: `D01.${line}.crusher.ore_flow`,
    watermark: "2026-01-01T11:59:00Z",
    window_start: "2026-01-01T11:54:00Z",
    latest_timestamp: index === 0 ? "2026-01-01T11:59:00Z" : "2026-01-01T11:59:30Z",
    latest_received_at: "2026-01-01T11:59:55Z",
    latest_quality: "good",
    latest_conflict: false,
    sample_time: "2026-01-01T11:59:00Z",
    received_at: "2026-01-01T11:59:35Z",
    event_id: String(index + 1).repeat(64),
    value: 40 + index,
    quality: "good",
    event_conflict: false,
    unit: "t/h",
    interval_seconds: 30,
    sample_count: 10,
    distinct_timestamps: 10,
    usable_samples: 10,
    average_value: 40 + index * 2,
    first_sample: "2026-01-01T11:54:30Z",
    last_sample: "2026-01-01T11:59:00Z",
    window_received_at: "2026-01-01T11:59:35Z",
  }));
}
describe("continuous throughput evidence", () => {
  it("uses a common five-minute cutoff but request UTC for age and exposes real tag receipt/value identities", () => {
    const data = mapContinuousThroughput(run, asOf, rows());
    expect(data.throughput).toEqual({ value: 126, unit: "t/h", quality: "good", coverage: 1 });
    expect(data.watermarkLagSeconds).toBe(60);
    expect(data.readings[0]).toMatchObject({
      value: 40,
      ageSeconds: 60,
      receivedAt: "2026-01-01T11:59:35.000Z",
      sampleCount: 10,
    });
    expect(data.capabilities.incidents).toBe(false);
    expect(data).not.toHaveProperty("ingestion");
  });
  it("does not launder a stale request through an older common watermark", () => {
    const stale = rows().map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          typeof value === "string" && value.startsWith("2026-") && key !== "as_of_utc"
            ? new Date(Date.parse(value) - 120_000).toISOString()
            : value,
        ]),
      ),
    );
    const data = mapContinuousThroughput(run, asOf, stale);
    expect(data.throughput.value).toBeNull();
    expect(data.watermarkLagSeconds).toBe(180);
    expect(data.readings.every((reading) => reading.quality === "stale")).toBe(true);
  });
  it.each([
    { source_status: "NOT_READY" },
    { quality: "bad" },
    { latest_quality: "uncertain" },
    { event_conflict: true, value: null, quality: "", usable_samples: 9 },
    { sample_count: 8, distinct_timestamps: 8, usable_samples: 8 },
    { usable_samples: 9 },
  ])("returns unavailable rather than a partial or healthy sum for %j", (change) => {
    const evidence = rows();
    Object.assign(evidence[0], change);
    expect(mapContinuousThroughput(run, asOf, evidence).throughput.value).toBeNull();
  });
  it("reports usable coverage separately from observed coverage and fails closed on any bad window sample", () => {
    const evidence = rows();
    evidence[0].usable_samples = 9;
    const data = mapContinuousThroughput(run, asOf, evidence);
    expect(data.readings[0]).toMatchObject({
      quality: "bad",
      coverage: 0.9,
      observationCoverage: 1,
    });
    expect(data.throughput.value).toBeNull();
  });
  it("represents missing critical signals and new-run warmup without inventing evidence", () => {
    const missing = rows().map((row, i) => ({
      ...row,
      watermark: null,
      window_start: null,
      ...(i === 0 ? { latest_timestamp: null, latest_received_at: null } : {}),
      sample_time: null,
      received_at: null,
      sample_count: 0,
      distinct_timestamps: 0,
      usable_samples: 0,
      first_sample: null,
      last_sample: null,
      window_received_at: null,
    }));
    expect(mapContinuousThroughput(run, asOf, missing).throughput.value).toBeNull();
    const warmup = rows().map((row) => ({
      ...row,
      sample_count: 6,
      distinct_timestamps: 6,
      usable_samples: 6,
      first_sample: "2026-01-01T11:56:30Z",
    }));
    expect(
      mapContinuousThroughput({ ...run, startedAt: "2026-01-01T11:56:00Z" }, asOf, warmup)
        .readings[0].quality,
    ).toBe("warming_up");
  });
  it.each([
    { plant_id: "other" },
    { run_id: "foreign" },
    { unit: "kg" },
    { latest_received_at: "2026-01-01T12:00:01Z" },
    { latest_conflict: null },
    { distinct_timestamps: 9 },
    { sample_count: 11 },
    { watermark: "2026-01-01T11:58:30Z" },
    { value: Number.NaN },
  ])("rejects malformed or foreign evidence %j", (change) => {
    const evidence = rows();
    Object.assign(evidence[0], change);
    expect(() => mapContinuousThroughput(run, asOf, evidence)).toThrow("Invalid continuous");
  });
  it("queries only the bounded rolling kind, with independent default-off reads", async () => {
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
      { kind: "continuous-throughput", runId: run.runId, asOf, maxRows: 3 },
      signal,
    );
  });
});
