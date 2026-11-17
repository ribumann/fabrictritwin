import {
  D01_CATALOG_VERSION,
  D01_PLANT_CATALOG,
  D01_PUBLISH_PROFILE_VERSION,
  getD01TagIntervalSeconds,
} from "@triathlon-twin/simulator/mining";
import type { ContinuousMiningRunRecord } from "../run-coordinator.js";
import { MiningQueryError } from "./bounded-query.js";

const WINDOW_MS = 300_000;
const LOOKBACK_MS = 600_000;
const SOURCE_CONTRACT_VERSION = "d01-validated-source-v1";
const feedTagIds = ["D01.A.crusher.ore_flow", "D01.B.crusher.ore_flow", "D01.C.crusher.ore_flow"];
const feedTagSet = new Set(feedTagIds);
const lineScopes = ["A", "B", "C"] as const;
const malformed = (): never => {
  throw new MiningQueryError("malformed", "Invalid continuous Mining evidence.");
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
const eventId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const empty = (value: unknown) => value === null || value === undefined || value === "";
const telemetryQuality = (value: unknown): value is "good" | "bad" | "uncertain" =>
  value === "good" || value === "bad" || value === "uncertain";

function assertObservationIdentity(
  row: Record<string, unknown>,
  run: ContinuousMiningRunRecord,
  request: number,
  sourceStatus: string,
): void {
  if (
    row.plant_id !== "D01" ||
    row.run_id !== run.runId ||
    time(row.as_of_utc) !== request ||
    row.source_status !== sourceStatus ||
    row.source_contract_version !== SOURCE_CONTRACT_VERSION
  )
    return malformed();
}

function mapTagObservation(
  row: Record<string, unknown>,
  tag: (typeof D01_PLANT_CATALOG.telemetry_tags)[number],
  sourceStatus: string,
  request: number,
) {
  const cadence = getD01TagIntervalSeconds(tag);
  const latest = time(row.latest_timestamp);
  const received = time(row.latest_received_at);
  const conflict = row.latest_conflict;
  if (typeof conflict !== "boolean") return malformed();
  if (latest === null) {
    if (
      !empty(received) ||
      !empty(row.latest_sequence) ||
      !empty(row.latest_event_id) ||
      !empty(row.latest_module_id) ||
      !empty(row.latest_equipment_id) ||
      !empty(row.latest_value) ||
      !empty(row.latest_quality) ||
      !empty(row.latest_unit) ||
      !empty(row.latest_interval_seconds)
    )
      return malformed();
    return {
      quality: sourceStatus === "READY" ? (conflict ? "bad" : "missing") : "unavailable",
      sampleTime: null,
      receivedAt: null,
      ageSeconds: null,
      eventId: null,
      sequence: null,
      value: null,
    } as const;
  }
  const sequence = row.latest_sequence;
  const value = row.latest_value;
  const age = (request - latest) / 1000;
  const maxAge = cadence * 3_000 + 15_000;
  if (
    conflict ||
    received === null ||
    received < latest ||
    received > request ||
    latest > request ||
    request - latest > LOOKBACK_MS ||
    !Number.isSafeInteger(sequence) ||
    typeof sequence !== "number" ||
    sequence < 1 ||
    !eventId(row.latest_event_id) ||
    row.latest_module_id !== tag.module_id ||
    row.latest_equipment_id !== tag.equipment_id ||
    row.latest_unit !== tag.unit ||
    row.latest_interval_seconds !== cadence ||
    !telemetryQuality(row.latest_quality) ||
    !finite(value) ||
    value < tag.simulation_envelope[0] ||
    value > tag.simulation_envelope[1]
  )
    return malformed();
  const quality =
    sourceStatus !== "READY"
      ? "unavailable"
      : row.latest_quality !== "good"
        ? "bad"
        : request - latest > maxAge
          ? "stale"
          : "good";
  return {
    quality,
    sampleTime: iso(latest),
    receivedAt: iso(received),
    ageSeconds: age,
    eventId: row.latest_event_id,
    sequence,
    value: quality === "good" ? value : null,
  } as const;
}

function assertMissingAligned(row: Record<string, unknown>): void {
  if (
    !empty(row.received_at) ||
    !empty(row.sequence) ||
    !empty(row.event_id) ||
    !empty(row.value) ||
    !empty(row.quality) ||
    !empty(row.interval_seconds)
  )
    return malformed();
}

function assertFeedWindow(
  row: Record<string, unknown>,
  cutoff: number | null,
  tag: (typeof D01_PLANT_CATALOG.telemetry_tags)[number],
) {
  const count = row.sample_count;
  const distinct = row.distinct_timestamps;
  const good = row.usable_samples;
  const first = time(row.first_sample);
  const last = time(row.last_sample);
  const windowReceipt = time(row.window_received_at);
  if (
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > 10 ||
    typeof distinct !== "number" ||
    !Number.isSafeInteger(distinct) ||
    distinct !== count ||
    typeof good !== "number" ||
    !Number.isSafeInteger(good) ||
    good < 0 ||
    good > count
  )
    return malformed();
  if (count === 0) {
    if (first !== null || last !== null || windowReceipt !== null || !empty(row.average_value))
      return malformed();
  } else if (
    first === null ||
    last === null ||
    cutoff === null ||
    first <= cutoff - WINDOW_MS ||
    first > last ||
    last > cutoff ||
    windowReceipt === null ||
    windowReceipt < last ||
    windowReceipt > Date.parse(String(row.as_of_utc))
  ) {
    return malformed();
  }
  if (count > 0 && good > 0) {
    if (
      !finite(row.average_value) ||
      row.average_value < tag.simulation_envelope[0] ||
      row.average_value > tag.simulation_envelope[1]
    )
      return malformed();
  } else if (!empty(row.average_value)) {
    return malformed();
  }
  return { count, good, first, last, windowReceipt };
}

function mapStateObservation(
  row: Record<string, unknown>,
  scopeId: (typeof lineScopes)[number],
  sourceStatus: string,
  request: number,
) {
  if (row.scope_id !== scopeId || typeof row.state_conflict !== "boolean") return malformed();
  const sample = time(row.state_timestamp);
  const received = time(row.state_received_at);
  if (sample === null) {
    if (
      !empty(received) ||
      !empty(row.state_sequence) ||
      !empty(row.state_event_id) ||
      !empty(row.state) ||
      !empty(row.scheduled_running)
    )
      return malformed();
    return {
      scopeId,
      state: null,
      scheduledRunning: null,
      quality: sourceStatus === "READY" ? (row.state_conflict ? "bad" : "missing") : "unavailable",
      sampleTime: null,
      receivedAt: null,
      ageSeconds: null,
      eventId: null,
      sequence: null,
    } as const;
  }
  const sequence = row.state_sequence;
  if (
    row.state_conflict ||
    received === null ||
    sample > request ||
    received < sample ||
    received > request ||
    request - sample > LOOKBACK_MS ||
    !Number.isSafeInteger(sequence) ||
    typeof sequence !== "number" ||
    sequence < 1 ||
    !eventId(row.state_event_id) ||
    typeof row.scheduled_running !== "boolean" ||
    !["starting", "running", "idle", "stopped", "fault"].includes(String(row.state))
  )
    return malformed();
  const quality =
    sourceStatus !== "READY" ? "unavailable" : request - sample > 195_000 ? "stale" : "good";
  return {
    scopeId,
    state: row.state,
    scheduledRunning: row.scheduled_running,
    quality,
    sampleTime: iso(sample),
    receivedAt: iso(received),
    ageSeconds: (request - sample) / 1000,
    eventId: row.state_event_id,
    sequence,
  } as const;
}

/** Request UTC is never replaced with the ingestion watermark for freshness. */
export function mapContinuousThroughput(
  run: ContinuousMiningRunRecord,
  asOf: string,
  rows: Record<string, unknown>[],
) {
  const request = time(asOf);
  const start = time(run.startedAt);
  if (request === null || start === null || rows.length !== 59) return malformed();
  const sourceStatus = rows[0]?.source_status;
  if (typeof sourceStatus !== "string" || sourceStatus.length === 0) return malformed();
  const tags = new Map(D01_PLANT_CATALOG.telemetry_tags.map((tag) => [tag.id, tag]));
  const tagRows = new Map<string, Record<string, unknown>>();
  const stateRows = new Map<string, Record<string, unknown>>();
  let watermark: number | null | undefined;
  for (const row of rows) {
    assertObservationIdentity(row, run, request, sourceStatus);
    const cutoff = time(row.watermark);
    if (watermark !== undefined && cutoff !== watermark) return malformed();
    watermark = cutoff;
    if (
      (cutoff !== null && (cutoff < start || cutoff > request)) ||
      time(row.window_start) !== (cutoff === null ? null : cutoff - WINDOW_MS)
    )
      return malformed();
    if (row.row_kind === "tag") {
      if (typeof row.tag_id !== "string" || tagRows.has(row.tag_id)) return malformed();
      const tag = tags.get(row.tag_id);
      if (
        !tag ||
        row.catalog_version !== D01_CATALOG_VERSION ||
        row.profile_version !== D01_PUBLISH_PROFILE_VERSION ||
        row.module_id !== tag.module_id ||
        row.equipment_id !== tag.equipment_id ||
        row.unit !== tag.unit ||
        row.cadence_seconds !== getD01TagIntervalSeconds(tag)
      )
        return malformed();
      tagRows.set(tag.id, row);
    } else if (row.row_kind === "state") {
      if (
        typeof row.scope_id !== "string" ||
        !lineScopes.includes(row.scope_id as (typeof lineScopes)[number]) ||
        stateRows.has(row.scope_id) ||
        row.catalog_version !== D01_CATALOG_VERSION ||
        row.profile_version !== ""
      )
        return malformed();
      stateRows.set(row.scope_id, row);
    } else return malformed();
  }
  if (tagRows.size !== tags.size || stateRows.size !== lineScopes.length) return malformed();
  const cutoff = watermark ?? null;
  const latest = new Map(
    D01_PLANT_CATALOG.telemetry_tags.map((tag) => [
      tag.id,
      mapTagObservation(tagRows.get(tag.id)!, tag, sourceStatus, request),
    ]),
  );
  const readings = feedTagIds.map((tagId) => {
    const tag = tags.get(tagId)!;
    const row = tagRows.get(tagId)!;
    const direct = latest.get(tagId)!;
    const sample = time(row.sample_time);
    const received = time(row.received_at);
    const conflict = row.event_conflict;
    if (typeof conflict !== "boolean") return malformed();
    if (conflict) {
      if (sample !== null) return malformed();
      assertMissingAligned(row);
    } else if (sample === null) {
      assertMissingAligned(row);
    } else if (
      received === null ||
      sample > request ||
      received < sample ||
      received > request ||
      sample < Math.max(start, request - LOOKBACK_MS) ||
      cutoff === null ||
      sample > cutoff ||
      direct.sampleTime === null ||
      sample > Date.parse(direct.sampleTime) ||
      !Number.isSafeInteger(row.sequence) ||
      typeof row.sequence !== "number" ||
      row.sequence < 1 ||
      !eventId(row.event_id) ||
      !telemetryQuality(row.quality) ||
      row.unit !== tag.unit ||
      row.interval_seconds !== getD01TagIntervalSeconds(tag) ||
      !finite(row.value) ||
      row.value < tag.simulation_envelope[0] ||
      row.value > tag.simulation_envelope[1]
    ) {
      return malformed();
    }
    const window = assertFeedWindow(row, cutoff, tag);
    const alignedAge = sample === null ? Infinity : request - sample;
    const quality =
      sourceStatus !== "READY"
        ? "unavailable"
        : direct.quality === "bad" || conflict
          ? "bad"
          : direct.quality === "missing" || sample === null
            ? "missing"
            : row.latest_quality !== "good" ||
                row.quality !== "good" ||
                window.good !== window.count
              ? "bad"
              : direct.quality === "stale" || alignedAge > 105_000
                ? "stale"
                : cutoff === null ||
                    cutoff - start < WINDOW_MS ||
                    window.count < 9 ||
                    sample !== cutoff
                  ? "warming_up"
                  : "good";
    const ageSeconds = direct.ageSeconds;
    return {
      tagId,
      moduleId: tag.module_id,
      unit: tag.unit,
      quality,
      sourceStatus,
      latestSampleTime: direct.sampleTime,
      latestReceivedAt: direct.receivedAt,
      ageSeconds,
      sampleTime: iso(sample),
      receivedAt: iso(received),
      eventId: sample !== null && eventId(row.event_id) ? row.event_id : null,
      value: sample !== null && finite(row.value) ? row.value : null,
      average: window.count > 0 && finite(row.average_value) ? row.average_value : null,
      coverage: window.good / 10,
      observationCoverage: window.count / 10,
      sampleCount: window.count,
      usableSamples: window.good,
      lastWindowReceipt: iso(window.windowReceipt),
      latestValue: direct.value,
      latestQuality: direct.quality,
      latestEventId: direct.eventId,
      latestSequence: direct.sequence,
    };
  });
  const expectedCutoff = readings.every((reading) => reading.latestSampleTime !== null)
    ? Math.min(...readings.map((reading) => Date.parse(reading.latestSampleTime!)))
    : null;
  if (cutoff !== expectedCutoff) return malformed();
  const states = lineScopes.map((scopeId) =>
    mapStateObservation(stateRows.get(scopeId)!, scopeId, sourceStatus, request),
  );
  const allStatesCurrent = states.every((state) => state.quality === "good");
  const lineCount = allStatesCurrent
    ? states.filter((state) => state.state === "running" && state.scheduledRunning === true).length
    : null;
  const quality = readings.every((reading) => reading.quality === "good") ? "good" : "unavailable";
  const nonFeedReadings = D01_PLANT_CATALOG.telemetry_tags
    .filter((tag) => !feedTagSet.has(tag.id))
    .map((tag) => {
      const observation = latest.get(tag.id)!;
      return {
        tagId: tag.id,
        moduleId: tag.module_id,
        equipmentId: tag.equipment_id,
        unit: tag.unit,
        cadenceSeconds: getD01TagIntervalSeconds(tag),
        quality: observation.quality,
        value: observation.value,
        sampleTime: observation.sampleTime,
        receivedAt: observation.receivedAt,
        ageSeconds: observation.ageSeconds,
        eventId: observation.eventId,
        sequence: observation.sequence,
      };
    });
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
    detail: {
      plantId: "D01",
      runId: run.runId,
      generation: run.lifetime.generation,
      asOf,
      catalogVersion: D01_CATALOG_VERSION,
      profileVersion: D01_PUBLISH_PROFILE_VERSION,
      sourceContractVersion: SOURCE_CONTRACT_VERSION,
      sourceStatus,
      readings: nonFeedReadings,
      lineStates: states,
      runningLines: {
        value: lineCount,
        unit: "lines",
        quality: lineCount === null ? "unavailable" : "good",
      },
    },
    capabilities: { incidents: false, trends: false, assistant: false, replay: false },
  };
}
