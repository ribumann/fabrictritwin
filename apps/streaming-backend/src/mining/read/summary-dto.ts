import { MiningQueryError } from "./bounded-query.js";

type Quality = "good" | "uncertain" | "bad" | "missing";
const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const blocked = new Set([
  "INVALID_REQUEST",
  "INVALID_WINDOW",
  "BLOCKED_SOURCE_CONTRACT",
  "BLOCKED_RAW_TIMESTAMP_PROOF",
  "BLOCKED_WRITER_APPROVAL",
  "BLOCKED_CATALOG",
  "BLOCKED_PROFILE",
  "DUPLICATE_CONFLICT",
  "INVALID_COVERAGE",
]);
const dataStatuses = new Set([
  "OK",
  "NO_DATA",
  "STATE_COVERAGE_INCOMPLETE",
  "INSUFFICIENT_COMMON_COVERAGE",
  "FEED_BELOW_10_TPH",
]);

function fail(message: string): never {
  throw new MiningQueryError("malformed", message);
}

function timestamp(value: unknown): { millis: number; key: string } {
  if (typeof value !== "string" || !utc.test(value))
    return fail("Invalid mining summary timestamp.");
  const millis = Date.parse(value);
  const key = value.replace(
    /(?:\.(\d{1,7}))?Z$/,
    (_, fraction: string | undefined) => `.${(fraction ?? "").padEnd(7, "0")}Z`,
  );
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== `${key.slice(0, 23)}Z`) {
    return fail("Invalid mining summary timestamp.");
  }
  return { millis, key };
}

function numberOrNull(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fail("Invalid mining summary number.");
  }
  return value;
}

function countOrNull(value: unknown): number | null {
  const number = numberOrNull(value);
  if (number !== null && !Number.isSafeInteger(number))
    return fail("Invalid mining summary count.");
  return number;
}

function coverage(value: unknown): number | null {
  const number = numberOrNull(value);
  if (number !== null && number > 1) return fail("Invalid mining summary coverage.");
  return number;
}

/** Source-only mapping. Never mount until the reviewed summary state-conflict fix and readiness are proven. */
export function mapSummaryRows(
  input: { runId: string; start: string; end: string },
  rows: Record<string, unknown>[],
) {
  if (!uuid.test(input.runId)) throw new MiningQueryError("invalid", "Invalid mining run.");
  const start = timestamp(input.start);
  const end = timestamp(input.end);
  if (end.millis - start.millis < 60_000 || end.millis - start.millis > 86_400_000) {
    throw new MiningQueryError("invalid", "Invalid mining summary window.");
  }
  if (rows.length !== 1) return fail("Expected one mining summary row.");
  const row = rows[0];
  if (
    row.plant_id !== "D01" ||
    row.run_id !== input.runId ||
    timestamp(row.window_start_utc).key !== start.key ||
    timestamp(row.window_end_utc).key !== end.key
  )
    return fail("Mining summary scope does not match.");
  if (typeof row.status !== "string") return fail("Invalid mining summary status.");
  if (blocked.has(row.status)) {
    throw new MiningQueryError("upstream", `Mining summary unavailable: ${row.status}.`);
  }
  if (!dataStatuses.has(row.status)) return fail("Unknown mining summary status.");
  const window = { windowStart: input.start, windowEnd: input.end };
  const missing = (unit: string) => ({
    value: null,
    unit,
    coverage: null,
    quality: "missing" as const,
    ...window,
  });
  const good = countOrNull(row.good_sample_count);
  const nonGood = countOrNull(row.non_good_sample_count);
  const uncertain = countOrNull(row.uncertain_sample_count);
  const bad = countOrNull(row.bad_sample_count);
  const late = countOrNull(row.late_sample_count);
  const conflicts = countOrNull(row.conflicting_event_count);
  const feedCoverage = coverage(row.feed_coverage);
  const waterCoverage = coverage(row.water_coverage);
  const powerCoverage = coverage(row.power_coverage);
  const commonCoverage = coverage(row.common_coverage);
  const feedA = numberOrNull(row.line_a_feed_tph);
  const feedB = numberOrNull(row.line_b_feed_tph);
  const feedC = numberOrNull(row.line_c_feed_tph);
  const plantFeed = numberOrNull(row.plant_feed_tph);
  const processed = numberOrNull(row.processed_tonnes);
  const water = numberOrNull(row.gross_process_water_m3_per_t);
  const energy = numberOrNull(row.whole_plant_energy_kwh_per_t);
  const running = countOrNull(row.running_lines);
  if (running !== null && running > 3) return fail("Invalid running-line count.");
  if (row.status === "STATE_COVERAGE_INCOMPLETE" && running !== null) {
    return fail("Inconsistent running-line coverage.");
  }
  for (const value of [
    row.first_event_time,
    row.last_event_time,
    row.first_received_at,
    row.last_received_at,
  ]) {
    if (value !== null) timestamp(value);
  }
  if (conflicts !== 0) return fail("Invalid mining summary conflict count.");
  if (row.status === "NO_DATA") {
    return {
      throughput: missing("t/h"),
      runningLines: missing("lines"),
      grossProcessWaterIntensity: missing("m\u00b3/t"),
      energyIntensity: missing("kWh/t"),
    };
  }
  if (
    good === null ||
    nonGood === null ||
    uncertain === null ||
    bad === null ||
    late === null ||
    conflicts === null ||
    nonGood !== uncertain + bad ||
    late > good + nonGood
  ) {
    return fail("Invalid mining summary quality counts.");
  }
  if (
    feedA !== null &&
    feedB !== null &&
    feedC !== null &&
    plantFeed !== null &&
    Math.abs(plantFeed - (feedA + feedB + feedC)) > Math.max(1, plantFeed) * 1e-9
  ) {
    return fail("Inconsistent mining throughput.");
  }
  if (
    row.status === "OK" &&
    (good === 0 ||
      running === null ||
      feedCoverage === null ||
      waterCoverage === null ||
      powerCoverage === null ||
      commonCoverage === null ||
      commonCoverage < 0.9 ||
      feedA === null ||
      feedB === null ||
      feedC === null ||
      plantFeed === null ||
      processed === null ||
      water === null ||
      energy === null)
  )
    return fail("Incomplete healthy mining summary.");
  if (good + nonGood > 0) {
    const first = timestamp(row.first_event_time).millis;
    const last = timestamp(row.last_event_time).millis;
    const receivedFirst = timestamp(row.first_received_at).millis;
    const receivedLast = timestamp(row.last_received_at).millis;
    if (
      first < start.millis ||
      last >= end.millis ||
      last < first ||
      receivedLast < receivedFirst
    ) {
      return fail("Invalid mining summary provenance.");
    }
  } else if (
    [row.first_event_time, row.last_event_time, row.first_received_at, row.last_received_at].some(
      (value) => value !== null,
    )
  )
    return fail("Invalid empty mining summary provenance.");
  const quality: Quality =
    bad > 0 ? "bad" : uncertain > 0 ? "uncertain" : good > 0 ? "good" : "missing";
  const kpi = (
    value: number | null,
    unit: string,
    valueCoverage: number | null,
    eligible: boolean,
  ) => {
    const resultQuality =
      quality === "good" &&
      (!eligible || value === null || valueCoverage === null || valueCoverage < 0.9)
        ? "missing"
        : quality;
    return {
      value: resultQuality === "good" ? value : null,
      unit,
      coverage: valueCoverage,
      quality: resultQuality,
      ...window,
    };
  };
  return {
    throughput: kpi(plantFeed, "t/h", feedCoverage, true),
    runningLines: {
      value: running,
      unit: "lines",
      coverage: running === null ? null : 1,
      quality: running === null ? ("missing" as const) : ("good" as const),
      ...window,
    },
    grossProcessWaterIntensity: kpi(water, "m\u00b3/t", commonCoverage, row.status === "OK"),
    energyIntensity: kpi(energy, "kWh/t", commonCoverage, row.status === "OK"),
  };
}
