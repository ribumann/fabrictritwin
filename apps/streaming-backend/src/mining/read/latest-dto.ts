import { D01_PLANT_CATALOG, getD01TagIntervalSeconds } from "@triathlon-twin/simulator/mining";
import { MiningQueryError } from "./bounded-query.js";

type Quality = "good" | "uncertain" | "bad" | "stale" | "missing";
type State = "running" | "starting" | "idle" | "stopped" | "fault";
const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const blocked = new Set([
  "INVALID_REQUEST",
  "BLOCKED_SOURCE_CONTRACT",
  "BLOCKED_RAW_TIMESTAMP_PROOF",
  "BLOCKED_WRITER_APPROVAL",
  "BLOCKED_CATALOG",
  "BLOCKED_PROFILE",
]);
const scopes = ["A", "B", "C", "shared"] as const;

function fail(message: string): never {
  throw new MiningQueryError("malformed", message);
}

function instant(value: unknown): number {
  if (typeof value !== "string" || !utc.test(value)) return fail("Invalid latest timestamp.");
  const millis = Date.parse(value);
  const normalized = value.replace(
    /(?:\.(\d{1,7}))?Z$/,
    (_, fraction: string | undefined) => `.${(fraction ?? "").padEnd(3, "0").slice(0, 3)}Z`,
  );
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== normalized) {
    return fail("Invalid latest timestamp.");
  }
  return millis;
}

/** Source mapping only: the caller must separately prove readiness and incident availability. */
export function mapLatestRows(
  input: { runId: string; asOf: string },
  rows: Record<string, unknown>[],
) {
  if (!uuid.test(input.runId)) throw new MiningQueryError("invalid", "Invalid mining run.");
  const asOf = instant(input.asOf);
  if (
    rows.length === 1 &&
    rows[0].row_kind === "contract" &&
    typeof rows[0].status === "string" &&
    blocked.has(rows[0].status)
  ) {
    if (
      rows[0].plant_id !== "D01" ||
      rows[0].run_id !== input.runId ||
      instant(rows[0].as_of_utc) !== asOf
    )
      return fail("Invalid latest control scope.");
    throw new MiningQueryError("upstream", `Mining latest unavailable: ${rows[0].status}.`);
  }
  const tags = new Map(D01_PLANT_CATALOG.telemetry_tags.map((tag) => [tag.id, tag]));
  const readings = new Map<
    string,
    {
      tagId: string;
      equipmentId: string;
      moduleId: string;
      value: number | null;
      unit: string;
      sampleTime: string | null;
      ingestionTime: string | null;
      quality: Quality;
      ageSeconds: number | null;
      normalBand: null;
    }
  >();
  const states = new Map<
    string,
    { status: "running" | "stopped" | "fault" | "unknown"; state: State | null }
  >();
  for (const row of rows) {
    if (row.plant_id !== "D01" || row.run_id !== input.runId || instant(row.as_of_utc) !== asOf) {
      return fail("Mining latest scope does not match.");
    }
    if (row.row_kind === "tag") {
      if (typeof row.tagId !== "string") return fail("Invalid latest tag.");
      const tag = tags.get(row.tagId);
      if (
        !tag ||
        readings.has(tag.id) ||
        row.seriesId !== tag.id ||
        row.module_id !== tag.module_id ||
        row.equipment_id !== tag.equipment_id ||
        row.metric !== tag.metric ||
        row.unit !== tag.unit
      ) {
        return fail("Latest tag identity does not match catalog.");
      }
      if (row.status === "DUPLICATE_CONFLICT") {
        throw new MiningQueryError("upstream", "Mining latest contains conflicting events.");
      }
      let quality: Quality;
      let age: number | null = null;
      let sampleTime: string | null = null;
      let ingestionTime: string | null = null;
      let value: number | null = null;
      if (row.status === "UNKNOWN_NO_OBSERVATION") {
        if (
          row.value !== null ||
          row.event_time !== null ||
          row.received_at !== null ||
          row.age_seconds !== null ||
          row.quality !== ""
        )
          return fail("Invalid missing latest reading.");
        quality = "missing";
      } else {
        if (
          typeof row.event_time !== "string" ||
          typeof row.received_at !== "string" ||
          typeof row.age_seconds !== "number" ||
          !Number.isSafeInteger(row.age_seconds) ||
          row.age_seconds < 0 ||
          typeof row.value !== "number" ||
          !Number.isFinite(row.value)
        ) {
          return fail("Invalid latest reading.");
        }
        const eventTime = instant(row.event_time);
        instant(row.received_at);
        if (
          eventTime > asOf ||
          row.age_seconds !== Math.floor(asOf / 1000) - Math.floor(eventTime / 1000)
        ) {
          return fail("Invalid latest reading age.");
        }
        const expected =
          row.quality === "bad"
            ? "BAD_QUALITY"
            : row.quality === "uncertain"
              ? "UNCERTAIN_QUALITY"
              : row.quality === "good"
                ? row.age_seconds > getD01TagIntervalSeconds(tag) * 3 + 15
                  ? "STALE"
                  : "OK"
                : "";
        if (row.status !== expected) return fail("Inconsistent latest reading quality.");
        quality =
          row.status === "BAD_QUALITY"
            ? "bad"
            : row.status === "UNCERTAIN_QUALITY"
              ? "uncertain"
              : row.status === "STALE"
                ? "stale"
                : "good";
        sampleTime = row.event_time;
        ingestionTime = row.received_at;
        age = row.age_seconds;
        value = row.value;
      }
      readings.set(tag.id, {
        tagId: tag.id,
        equipmentId: tag.equipment_id,
        moduleId: tag.module_id,
        value,
        unit: tag.unit,
        sampleTime,
        ingestionTime,
        quality,
        ageSeconds: age,
        normalBand: null,
      });
    } else if (row.row_kind === "state") {
      if (
        typeof row.scope_id !== "string" ||
        !scopes.some((scope) => scope === row.scope_id) ||
        states.has(row.scope_id)
      )
        return fail("Invalid latest state scope.");
      if (row.status === "DUPLICATE_CONFLICT") {
        throw new MiningQueryError("upstream", "Mining latest contains conflicting states.");
      }
      if (row.status === "UNKNOWN_NO_STATE") {
        if (
          row.event_time !== null ||
          row.received_at !== null ||
          row.age_seconds !== null ||
          row.state !== "" ||
          row.scheduled_running !== null
        )
          return fail("Invalid missing state.");
        states.set(row.scope_id, { status: "unknown", state: null });
        continue;
      }
      if (
        typeof row.event_time !== "string" ||
        typeof row.received_at !== "string" ||
        typeof row.age_seconds !== "number" ||
        !Number.isSafeInteger(row.age_seconds) ||
        row.age_seconds < 0 ||
        typeof row.scheduled_running !== "boolean" ||
        typeof row.state !== "string" ||
        !["running", "starting", "idle", "stopped", "fault"].includes(row.state)
      ) {
        return fail("Invalid latest state.");
      }
      const eventTime = instant(row.event_time);
      instant(row.received_at);
      if (
        eventTime > asOf ||
        row.age_seconds !== Math.floor(asOf / 1000) - Math.floor(eventTime / 1000)
      ) {
        return fail("Invalid latest state age.");
      }
      const expected =
        row.age_seconds > 195
          ? "STALE_STATE"
          : row.state === "fault"
            ? "FAULT"
            : row.state !== "running" || !row.scheduled_running
              ? "NOT_RUNNING"
              : "OK";
      if (row.status !== expected) return fail("Inconsistent latest state.");
      states.set(row.scope_id, {
        status:
          expected === "STALE_STATE"
            ? "unknown"
            : expected === "FAULT"
              ? "fault"
              : expected === "NOT_RUNNING"
                ? "stopped"
                : "running",
        state: row.state as State,
      });
    } else return fail("Invalid latest row kind.");
  }
  if (readings.size !== tags.size || states.size !== scopes.length)
    return fail("Incomplete latest grid.");
  return {
    readings: D01_PLANT_CATALOG.telemetry_tags.map((tag) => readings.get(tag.id)!),
    states: Object.fromEntries(states),
  };
}
