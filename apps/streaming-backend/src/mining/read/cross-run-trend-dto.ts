import {
  D01_CATALOG_VERSION,
  D01_PLANT_CATALOG,
  D01_PUBLISH_PROFILE_VERSION,
  getD01TagIntervalSeconds,
} from "@triathlon-twin/simulator/mining";
import { MiningQueryError } from "./bounded-query.js";
import {
  isMiningRunId,
  miningCrossRunTrendSourceContractVersion,
  prepareMiningCrossRunTrendQuery,
} from "./cross-run-trend-query.js";
import type { MiningCrossRunTrendRequest } from "./cross-run-trend-query.js";

type Quality = "good" | "uncertain" | "bad" | "mixed" | "conflict" | "missing";
type Status =
  | "OBSERVED"
  | "PARTIAL"
  | "NON_GOOD"
  | "CONFLICT"
  | "CADENCE_CONFLICT"
  | "AMBIGUOUS_OWNER"
  | "COVERAGE_UNKNOWN"
  | "GAP";

const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/;
const tagsById = new Map(
  D01_PLANT_CATALOG.telemetry_tags.flatMap((tag) => {
    const line = tag.module_id.split(".")[1];
    const family =
      tag.metric === "ore_flow" && line !== "shared" && tag.module_id.endsWith(".crusher")
        ? "feed"
        : tag.metric === "medium_density"
          ? "density"
          : tag.metric === "vibration_rms" && tag.module_id.endsWith(".crusher")
            ? "vibration"
            : line === "shared" &&
                tag.module_id === "D01.shared.water" &&
                ["level", "water_flow"].includes(tag.metric)
              ? "water-energy"
              : line === "shared" &&
                  tag.module_id === "D01.shared.control" &&
                  tag.metric === "power"
                ? "water-energy"
                : null;
    return family ? [[tag.id, { tag, family }] as const] : [];
  }),
);

function malformed(message = "Invalid Mining cross-run trend evidence."): never {
  throw new MiningQueryError("malformed", message);
}

function instant(value: unknown): number {
  if (typeof value !== "string" || !utc.test(value)) return malformed();
  const parsed = Date.parse(value);
  const normalized = value.replace(
    /(?:\.(\d{1,7}))?Z$/,
    (_, fraction: string | undefined) => `.${(fraction ?? "").padEnd(3, "0").slice(0, 3)}Z`,
  );
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== normalized) return malformed();
  return parsed;
}

function sameScopeInstant(value: unknown, expected: string): boolean {
  if (typeof value !== "string") return malformed();
  const parsed = instant(value);
  const fraction = value.match(/\.(\d+)Z$/)?.[1] ?? "";
  return parsed === instant(expected) && !/[1-9]/.test(fraction.slice(3));
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return malformed();
  return value;
}

function sampleTimes(value: unknown): string[] {
  let times = value;
  if (typeof times === "string") {
    try {
      times = JSON.parse(times) as unknown;
    } catch (cause) {
      throw new MiningQueryError("malformed", "Invalid Mining trend sample times.", { cause });
    }
  }
  if (!Array.isArray(times) || times.some((time) => typeof time !== "string")) {
    return malformed("Invalid Mining trend sample times.");
  }
  return times;
}

/** Maps actual per-run bins; absent bins remain absent and are never interpolated. */
export function mapMiningCrossRunTrendRows(
  input: MiningCrossRunTrendRequest,
  rows: Record<string, unknown>[],
  now: () => number = Date.now,
) {
  const prepared = prepareMiningCrossRunTrendQuery(input, now);
  if (
    !Array.isArray(rows) ||
    rows.some((row) => typeof row !== "object" || row === null || Array.isArray(row))
  ) {
    return malformed();
  }
  if (rows.length > prepared.maximumRows) {
    throw new MiningQueryError("overflow", "Mining cross-run trend exceeded 1000 rows.");
  }
  const controls = rows.filter((row) => row.row_kind === "control");
  if (controls.length > 0) {
    const control = controls[0]!;
    if (
      controls.length !== 1 ||
      rows.length !== 1 ||
      control.plant_id !== "D01" ||
      control.metric_family !== input.metric ||
      !sameScopeInstant(control.start_utc, input.start) ||
      !sameScopeInstant(control.end_utc, input.end) ||
      !sameScopeInstant(control.as_of_utc, input.asOf) ||
      typeof control.source_status !== "string" ||
      control.source_status === "READY"
    ) {
      return malformed("Invalid Mining cross-run trend control row.");
    }
    throw new MiningQueryError(
      "upstream",
      `Mining cross-run trend unavailable: ${control.source_status}.`,
    );
  }
  const start = instant(input.start);
  const end = instant(input.end);
  const asOf = instant(input.asOf);
  const binMs = input.binMinutes * 60_000;
  const keys = new Set<string>();
  const points = rows.map((row) => {
    if (
      row.row_kind !== "point" ||
      row.source_status !== "READY" ||
      row.plant_id !== "D01" ||
      row.metric_family !== input.metric ||
      !sameScopeInstant(row.start_utc, input.start) ||
      !sameScopeInstant(row.end_utc, input.end) ||
      !sameScopeInstant(row.as_of_utc, input.asOf) ||
      row.source_contract_version !== miningCrossRunTrendSourceContractVersion ||
      !isMiningRunId(row.run_id) ||
      typeof row.tag_id !== "string" ||
      !row.tag_id ||
      typeof row.ambiguous_owner !== "boolean" ||
      typeof row.cadence_conflict !== "boolean" ||
      typeof row.coverage_complete !== "boolean"
    ) {
      return malformed();
    }
    const catalog = tagsById.get(row.tag_id);
    if (
      !catalog ||
      catalog.family !== input.metric ||
      row.module_id !== catalog.tag.module_id ||
      row.equipment_id !== catalog.tag.equipment_id ||
      row.metric !== catalog.tag.metric ||
      row.unit !== catalog.tag.unit ||
      row.cadence_seconds !== getD01TagIntervalSeconds(catalog.tag) ||
      row.catalog_version !== D01_CATALOG_VERSION ||
      row.profile_version !== D01_PUBLISH_PROFILE_VERSION
    ) {
      return malformed("Mining cross-run trend identity does not match the fixed catalog.");
    }
    const binStart = instant(row.bin_start_utc);
    if (binStart < start || binStart >= end || (binStart - start) % binMs !== 0) {
      return malformed("Mining cross-run trend bin is outside the request.");
    }
    const key = `${row.run_id}:${row.tag_id}:${binStart}`;
    if (keys.has(key)) return malformed("Duplicate Mining cross-run trend bin.");
    keys.add(key);

    const actualTimes = sampleTimes(row.sample_times)
      .map(instant)
      .sort((a, b) => a - b);
    const sampleCount = count(row.sample_count);
    const goodCount = count(row.good_count);
    const uncertainCount = count(row.uncertain_count);
    const badCount = count(row.bad_count);
    const conflictCount = count(row.conflict_count);
    const expectedSamples = row.expected_samples === null ? null : count(row.expected_samples);
    if (
      sampleCount === 0 ||
      sampleCount !== actualTimes.length ||
      new Set(actualTimes).size !== actualTimes.length ||
      goodCount + uncertainCount + badCount + conflictCount !== sampleCount ||
      (expectedSamples !== null && expectedSamples === 0) ||
      (expectedSamples === null && !row.cadence_conflict)
    ) {
      return malformed("Inconsistent Mining cross-run trend coverage.");
    }

    const bucketEnd = Math.min(binStart + binMs, end);
    const firstSample = instant(row.first_sample_time);
    const lastSample = instant(row.last_sample_time);
    const firstReceivedAt = row.first_received_at;
    const lastReceivedAt = row.last_received_at;
    if (typeof firstReceivedAt !== "string" || typeof lastReceivedAt !== "string") {
      return malformed("Invalid Mining cross-run trend receipt timestamps.");
    }
    const firstReceived = instant(firstReceivedAt);
    const lastReceived = instant(lastReceivedAt);
    if (
      firstSample < binStart ||
      lastSample >= bucketEnd ||
      firstSample !== actualTimes[0] ||
      lastSample !== actualTimes.at(-1) ||
      firstReceived < firstSample ||
      lastReceived < lastSample ||
      lastReceived > asOf
    ) {
      return malformed("Invalid Mining cross-run trend sample provenance.");
    }
    const coverage =
      row.coverage === null
        ? null
        : typeof row.coverage === "number" &&
            Number.isFinite(row.coverage) &&
            row.coverage >= 0 &&
            row.coverage <= 1
          ? row.coverage
          : malformed("Invalid Mining cross-run trend coverage.");
    const coverageIsConsistent =
      expectedSamples === null
        ? coverage === null
        : sampleCount > expectedSamples || row.cadence_conflict
          ? coverage === null
          : coverage !== null && Math.abs(coverage - goodCount / expectedSamples) <= 1e-9;
    if (!coverageIsConsistent) {
      return malformed("Inconsistent Mining cross-run trend coverage.");
    }

    const expectedStatus: Status =
      conflictCount > 0
        ? "CONFLICT"
        : row.cadence_conflict
          ? "CADENCE_CONFLICT"
          : row.ambiguous_owner
            ? "AMBIGUOUS_OWNER"
            : expectedSamples === null || !row.coverage_complete
              ? "COVERAGE_UNKNOWN"
              : goodCount === expectedSamples && sampleCount === expectedSamples
                ? "OBSERVED"
                : goodCount > 0
                  ? "PARTIAL"
                  : badCount > 0 || uncertainCount > 0
                    ? "NON_GOOD"
                    : "GAP";
    const expectedQuality: Quality =
      conflictCount > 0
        ? "conflict"
        : goodCount > 0 && (badCount > 0 || uncertainCount > 0)
          ? "mixed"
          : badCount > 0 && uncertainCount > 0
            ? "mixed"
            : badCount > 0
              ? "bad"
              : uncertainCount > 0
                ? "uncertain"
                : goodCount > 0
                  ? "good"
                  : "missing";
    if (row.status !== expectedStatus || row.quality !== expectedQuality) {
      return malformed("Mining cross-run trend status disagrees with its evidence.");
    }
    if (
      (expectedStatus === "OBSERVED" &&
        (typeof row.value !== "number" || !Number.isFinite(row.value))) ||
      (expectedStatus !== "OBSERVED" && row.value !== null)
    ) {
      return malformed("Mining cross-run trend value is inconsistent with its quality.");
    }

    return {
      runId: row.run_id,
      seriesId: catalog.tag.id,
      moduleId: catalog.tag.module_id,
      equipmentId: catalog.tag.equipment_id,
      metric: catalog.tag.metric,
      binStart: new Date(binStart).toISOString(),
      firstSampleTime: new Date(firstSample).toISOString(),
      lastSampleTime: new Date(lastSample).toISOString(),
      firstReceivedAt,
      lastReceivedAt,
      sampleTimes: actualTimes.map((time) => new Date(time).toISOString()),
      value: expectedStatus === "OBSERVED" ? row.value : null,
      unit: catalog.tag.unit,
      quality: expectedQuality,
      status: expectedStatus,
      coverage,
      sampleCount,
      expectedSamples,
      goodCount,
      uncertainCount,
      badCount,
      conflictCount,
      ambiguousOwner: row.ambiguous_owner,
      cadenceConflict: row.cadence_conflict,
      coverageComplete: row.coverage_complete,
    } as const;
  });
  points.sort(
    (left, right) =>
      left.runId.localeCompare(right.runId) ||
      left.seriesId.localeCompare(right.seriesId) ||
      left.binStart.localeCompare(right.binStart),
  );
  const previous = new Map<string, { binStart: number; segmentId: string }>();
  const segmented = points.map((point) => {
    if (point.status !== "OBSERVED" || point.value === null) {
      previous.delete(`${point.runId}:${point.seriesId}`);
      return { ...point, segmentId: null };
    }
    const key = `${point.runId}:${point.seriesId}`;
    const time = Date.parse(point.binStart);
    const prior = previous.get(key);
    const segmentId =
      prior && time === prior.binStart + binMs
        ? prior.segmentId
        : `${point.runId}:${point.seriesId}:${point.binStart}`;
    previous.set(key, { binStart: time, segmentId });
    return { ...point, segmentId };
  });
  segmented.sort(
    (left, right) =>
      left.binStart.localeCompare(right.binStart) ||
      left.runId.localeCompare(right.runId) ||
      left.seriesId.localeCompare(right.seriesId),
  );
  return {
    metric: input.metric,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    asOf: new Date(asOf).toISOString(),
    binMinutes: input.binMinutes,
    catalogVersion: D01_CATALOG_VERSION,
    profileVersion: D01_PUBLISH_PROFILE_VERSION,
    points: segmented,
  };
}

export function getMiningCrossRunTrendTags(metric: MiningCrossRunTrendRequest["metric"]) {
  return [...tagsById.entries()]
    .filter(([, value]) => value.family === metric)
    .map(([, value]) => ({
      tagId: value.tag.id,
      moduleId: value.tag.module_id,
      equipmentId: value.tag.equipment_id,
      metric: value.tag.metric,
      unit: value.tag.unit,
      cadenceSeconds: getD01TagIntervalSeconds(value.tag),
    }));
}
