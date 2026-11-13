import { D01_CATALOG_VERSION, D01_PLANT_CATALOG } from "@triathlon-twin/simulator/mining";
import { MiningQueryError } from "./bounded-query.js";

type Family = "feed" | "density" | "vibration";
type Quality = "good" | "bad" | "uncertain" | "missing";
interface Request {
  runId: string;
  start: string;
  end: string;
  metric: Family;
  binMinutes: 1 | 5;
  maxRows: number;
}

const families = {
  feed: { module: "crusher", metric: "ore_flow", unit: "t/h" },
  density: { module: "dms", metric: "medium_density", unit: "kg/m3" },
  vibration: { module: "crusher", metric: "vibration_rms", unit: "mm/s" },
} as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/;
const unavailable = new Set([
  "INVALID_REQUEST",
  "INVALID_WINDOW",
  "INVALID_BIN",
  "BLOCKED_SOURCE_CONTRACT",
  "BLOCKED_RAW_TIMESTAMP_PROOF",
  "BLOCKED_WRITER_APPROVAL",
  "BLOCKED_CATALOG",
  "BLOCKED_PROFILE",
  "UNSUPPORTED_METRIC",
  "DUPLICATE_CONFLICT",
  "NO_DATA",
  "TOO_MANY_ROWS",
]);

function instant(value: unknown): number {
  if (typeof value !== "string" || !utc.test(value)) {
    throw new MiningQueryError("malformed", "Invalid mining series timestamp.");
  }
  const millis = Date.parse(value);
  const normalized = value.replace(
    /(?:\.(\d{1,7}))?Z$/,
    (_, fraction: string | undefined) => `.${(fraction ?? "").padEnd(3, "0").slice(0, 3)}Z`,
  );
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== normalized) {
    throw new MiningQueryError("malformed", "Invalid mining series timestamp.");
  }
  return millis;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new MiningQueryError("malformed", "Invalid mining series count.");
  }
  return value;
}

function qualities(value: unknown): Set<string> {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch (cause) {
      throw new MiningQueryError("malformed", "Invalid mining series qualities.", { cause });
    }
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => !["good", "uncertain", "bad"].includes(item)) ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new MiningQueryError("malformed", "Invalid mining series qualities.");
  }
  return new Set(parsed);
}

/** Source-only mapping; callers must separately enforce run authorization and source readiness. */
export function mapComparisonRows(input: Request, rows: Record<string, unknown>[]) {
  const start = instant(input.start);
  const end = instant(input.end);
  if (
    !uuid.test(input.runId) ||
    !Object.hasOwn(families, input.metric) ||
    ![1, 5].includes(input.binMinutes) ||
    !Number.isInteger(input.maxRows) ||
    input.maxRows < 1 ||
    input.maxRows > 1000 ||
    end <= start ||
    end - start > 86_400_000
  ) {
    throw new MiningQueryError("invalid", "Invalid mining comparison scope.");
  }
  if (rows.length === 0) throw new MiningQueryError("malformed", "Missing mining comparison rows.");
  if (rows.length > input.maxRows)
    throw new MiningQueryError("overflow", "Mining comparison exceeded the row limit.");
  const family = families[input.metric];
  const binMs = input.binMinutes * 60_000;
  const firstBin = Math.floor(start / binMs) * binMs;
  const expectedRows = Math.ceil((end - firstBin) / binMs) * 3;
  const keys = new Set<string>();
  let samples = 0;
  const mapped: Array<{
    timestamp: string;
    seriesId: string;
    value: number | null;
    unit: string;
    quality: Quality;
    coverage: number;
  }> = [];
  for (const row of rows) {
    if (
      row.plant_id !== "D01" ||
      row.run_id !== input.runId ||
      row.metric_family !== input.metric
    ) {
      throw new MiningQueryError(
        "malformed",
        "Mining comparison scope does not match the request.",
      );
    }
    if (typeof row.tag_id !== "string" || !row.tag_id) {
      if (rows.length === 1 && typeof row.status === "string" && unavailable.has(row.status)) {
        throw new MiningQueryError("upstream", `Mining comparison unavailable: ${row.status}.`);
      }
      throw new MiningQueryError("malformed", "Invalid mining comparison control row.");
    }
    if (row.line_id !== "A" && row.line_id !== "B" && row.line_id !== "C") {
      throw new MiningQueryError("malformed", "Invalid mining comparison line.");
    }
    const tagId = `D01.${row.line_id}.${family.module}.${family.metric}`;
    const catalogTag = D01_PLANT_CATALOG.telemetry_tags.find((tag) => tag.id === tagId);
    if (
      !catalogTag ||
      row.tag_id !== tagId ||
      row.module_id !== catalogTag.module_id ||
      row.metric !== family.metric ||
      row.unit !== family.unit ||
      catalogTag.unit !== family.unit
    ) {
      throw new MiningQueryError(
        "malformed",
        "Mining comparison identity does not match the catalog.",
      );
    }
    const time = instant(row.bin_start_utc);
    if (time < firstBin || time >= end || time % binMs !== 0) {
      throw new MiningQueryError("malformed", "Mining comparison bin is outside the request.");
    }
    const key = `${tagId}:${time}`;
    if (keys.has(key)) throw new MiningQueryError("malformed", "Duplicate mining comparison bin.");
    keys.add(key);
    const good = count(row.good_count);
    const nonGood = count(row.non_good_count);
    const uncertain = count(row.uncertain_count);
    const bad = count(row.bad_count);
    const late = count(row.late_count);
    const expected = count(row.expected_samples);
    const conflicts = count(row.conflict_count);
    samples += good + nonGood;
    const source = qualities(row.source_qualities);
    if (
      nonGood !== uncertain + bad ||
      late > good + nonGood ||
      expected === 0 ||
      conflicts !== 0 ||
      source.has("good") !== good > 0 ||
      source.has("uncertain") !== uncertain > 0 ||
      source.has("bad") !== bad > 0 ||
      typeof row.coverage !== "number" ||
      !Number.isFinite(row.coverage) ||
      row.coverage < 0 ||
      row.coverage > 1 ||
      Math.abs(row.coverage - good / expected) > 1e-9
    ) {
      throw new MiningQueryError(
        "malformed",
        "Inconsistent mining comparison quality or coverage.",
      );
    }
    const expectedStatus =
      good === 0 && uncertain && bad
        ? "MIXED_NON_GOOD_QUALITY"
        : good === 0 && bad
          ? "BAD_QUALITY"
          : good === 0 && uncertain
            ? "UNCERTAIN_QUALITY"
            : good > 0 && nonGood
              ? "MIXED_QUALITY"
              : good === 0
                ? "GAP"
                : "OK";
    if (
      row.status !== expectedStatus ||
      (good > 0 && (typeof row.value !== "number" || !Number.isFinite(row.value))) ||
      (good === 0 && row.value !== null)
    ) {
      throw new MiningQueryError("malformed", "Invalid mining comparison value or status.");
    }
    if (good + nonGood === 0) {
      if (
        [
          row.first_event_time,
          row.last_event_time,
          row.first_received_at,
          row.last_received_at,
        ].some((value) => value !== null)
      ) {
        throw new MiningQueryError("malformed", "Invalid mining comparison provenance.");
      }
    } else {
      const firstEvent = instant(row.first_event_time);
      const lastEvent = instant(row.last_event_time);
      const firstReceived = instant(row.first_received_at);
      const lastReceived = instant(row.last_received_at);
      if (
        firstEvent < start ||
        lastEvent >= end ||
        firstEvent <= time ||
        lastEvent > time + binMs ||
        lastEvent < firstEvent ||
        lastReceived < firstReceived
      ) {
        throw new MiningQueryError("malformed", "Invalid mining comparison provenance.");
      }
    }
    const quality: Quality =
      bad > 0 ? "bad" : uncertain > 0 ? "uncertain" : good > 0 ? "good" : "missing";
    mapped.push({
      timestamp: new Date(time).toISOString(),
      seriesId: tagId,
      value: quality === "good" && typeof row.value === "number" ? row.value : null,
      unit: family.unit,
      quality,
      coverage: row.coverage,
    });
  }
  if (mapped.length !== expectedRows || samples === 0) {
    throw new MiningQueryError("malformed", "Incomplete mining comparison grid.");
  }
  mapped.sort(
    (a, b) => a.timestamp.localeCompare(b.timestamp) || a.seriesId.localeCompare(b.seriesId),
  );
  return {
    plantId: "D01" as const,
    runId: input.runId,
    catalogVersion: D01_CATALOG_VERSION,
    moduleId: null,
    metric: input.metric,
    windowStart: input.start,
    windowEnd: input.end,
    binMinutes: input.binMinutes,
    rows: mapped,
  };
}
