import { D01_CATALOG_VERSION, D01_PLANT_CATALOG } from "@triathlon-twin/simulator/mining";
import type { ContinuousMiningRunRecord } from "../run-coordinator.js";
import { MiningQueryError } from "./bounded-query.js";

const WINDOW_MS = 300_000;
const MAX_AGE_MS = 105_000; // Existing 30-second source cadence * 3 + 15 seconds.
const tags = ["A", "B", "C"].map((line) => `D01.${line}.crusher.ore_flow`);
const malformed = (): never => {
  throw new MiningQueryError("malformed", "Invalid continuous throughput evidence.");
};
function time(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !value.endsWith("Z") || !Number.isFinite(Date.parse(value)))
    return malformed();
  return Date.parse(value);
}
const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString());
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Request UTC is never replaced with the ingestion watermark for freshness. */
export function mapContinuousThroughput(
  run: ContinuousMiningRunRecord,
  asOf: string,
  rows: Record<string, unknown>[],
) {
  const request = time(asOf);
  if (request === null || rows.length !== 3 || new Set(rows.map((row) => row.tag_id)).size !== 3)
    return malformed();
  const start = time(run.startedAt)!;
  let watermark: number | null | undefined;
  const readings = tags.map((tagId) => {
    const row = rows.find((item) => item.tag_id === tagId);
    if (
      !row ||
      row.plant_id !== "D01" ||
      row.run_id !== run.runId ||
      time(row.as_of_utc) !== request ||
      typeof row.source_status !== "string"
    )
      return malformed();
    const cutoff = time(row.watermark);
    if (watermark !== undefined && cutoff !== watermark) return malformed();
    watermark = cutoff;
    if (
      (cutoff !== null && (cutoff < start || cutoff > request)) ||
      time(row.window_start) !== (cutoff === null ? null : cutoff - WINDOW_MS)
    )
      return malformed();
    const latest = time(row.latest_timestamp);
    const latestReceipt = time(row.latest_received_at);
    const sample = time(row.sample_time);
    const receipt = time(row.received_at);
    const first = time(row.first_sample);
    const last = time(row.last_sample);
    const windowReceipt = time(row.window_received_at);
    if (
      (latest !== null &&
        (typeof row.latest_conflict !== "boolean" ||
          !["good", "bad", "uncertain", ""].includes(String(row.latest_quality)))) ||
      (sample !== null &&
        (typeof row.event_conflict !== "boolean" ||
          !["good", "bad", "uncertain", ""].includes(String(row.quality)) ||
          typeof row.event_id !== "string" ||
          !/^[0-9a-f]{64}$/.test(row.event_id)))
    )
      return malformed();
    for (const [measurement, received] of [
      [latest, latestReceipt],
      [sample, receipt],
      [last, windowReceipt],
    ]) {
      if (
        measurement !== null &&
        (measurement < Math.max(start, request - 600_000) ||
          measurement > request ||
          received === null ||
          received < measurement ||
          received > request)
      )
        return malformed();
    }
    if (
      sample !== null &&
      (cutoff === null || sample > cutoff || latest === null || sample > latest)
    )
      return malformed();
    const count = row.sample_count;
    const distinct = row.distinct_timestamps;
    const good = row.usable_samples;
    if (
      !Number.isSafeInteger(count) ||
      !Number.isSafeInteger(distinct) ||
      !Number.isSafeInteger(good) ||
      typeof count !== "number" ||
      count < 0 ||
      count > 10 ||
      distinct !== count ||
      typeof good !== "number" ||
      good < 0 ||
      good > count
    )
      return malformed();
    if (
      count &&
      (first === null ||
        last === null ||
        cutoff === null ||
        first <= cutoff - WINDOW_MS ||
        first > last ||
        last > cutoff)
    )
      return malformed();
    const tag = D01_PLANT_CATALOG.telemetry_tags.find((item) => item.id === tagId)!;
    if (
      (sample !== null &&
        (row.unit !== tag.unit ||
          row.interval_seconds !== 30 ||
          !finite(row.value) ||
          row.value < tag.simulation_envelope[0] ||
          row.value > tag.simulation_envelope[1])) ||
      (count &&
        (!finite(row.average_value) ||
          row.average_value < tag.simulation_envelope[0] ||
          row.average_value > tag.simulation_envelope[1]))
    ) {
      // Conflicting/bad rows can legitimately contain a null value, but never become usable.
      if (row.event_conflict !== true && row.quality === "good") return malformed();
    }
    const ageSeconds = latest === null ? null : (request - latest) / 1000;
    const alignedAge = sample === null ? Infinity : request - sample;
    const quality =
      row.source_status !== "READY"
        ? "unavailable"
        : latest === null || sample === null
          ? "missing"
          : row.latest_conflict === true ||
              row.event_conflict === true ||
              row.latest_quality !== "good" ||
              row.quality !== "good" ||
              good !== count
            ? "bad"
            : alignedAge > MAX_AGE_MS || request - latest > MAX_AGE_MS
              ? "stale"
              : cutoff === null || cutoff - start < WINDOW_MS || count < 9 || sample !== cutoff
                ? "warming_up"
                : "good";
    return {
      tagId,
      moduleId: tag.module_id,
      unit: tag.unit,
      quality,
      sourceStatus: row.source_status,
      latestSampleTime: iso(latest),
      latestReceivedAt: iso(latestReceipt),
      ageSeconds,
      sampleTime: iso(sample),
      receivedAt: iso(receipt),
      eventId: sample !== null && typeof row.event_id === "string" ? row.event_id : null,
      value: sample !== null && finite(row.value) ? row.value : null,
      average: count > 0 && finite(row.average_value) ? row.average_value : null,
      coverage: good / 10,
      observationCoverage: count / 10,
      sampleCount: count,
      usableSamples: good,
      lastWindowReceipt: iso(windowReceipt),
    };
  });
  const cutoff = watermark ?? null;
  const latestTimes = readings.map((reading) => time(reading.latestSampleTime));
  const expectedCutoff = latestTimes.every((value): value is number => value !== null)
    ? Math.min(...latestTimes)
    : null;
  if (cutoff !== expectedCutoff) return malformed();
  const quality = readings.every((reading) => reading.quality === "good") ? "good" : "unavailable";
  return {
    mode: "continuous" as const,
    plantId: "D01",
    runId: run.runId,
    generation: run.lifetime.generation,
    catalogVersion: D01_CATALOG_VERSION,
    asOf,
    quality,
    watermark: iso(cutoff),
    watermarkLagSeconds: cutoff === null ? null : (request - cutoff) / 1000,
    windowStart: iso(cutoff === null ? null : cutoff - WINDOW_MS),
    windowEnd: iso(cutoff),
    throughput: {
      value: quality === "good" ? readings.reduce((sum, item) => sum + item.average!, 0) : null,
      unit: "t/h",
      quality,
      coverage: Math.min(...readings.map((item) => item.coverage)),
    },
    readings,
    capabilities: { incidents: false, trends: false, assistant: false, replay: false },
  };
}
