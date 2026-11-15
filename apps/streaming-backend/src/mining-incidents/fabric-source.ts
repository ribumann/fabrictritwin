import { createHash } from "node:crypto";
import {
  D01_CATALOG_VERSION,
  D01_PLANT_CATALOG,
  D01_PUBLISH_PROFILE_VERSION,
  getD01TagIntervalSeconds,
} from "@triathlon-twin/simulator/mining";
import type { MiningReadingObservation, MiningStateObservation } from "./evaluator.js";
import type { MiningIncidentRun, MiningIncidentSource } from "./runtime.js";
import { createBoundedMiningQuery, MiningQueryError } from "../mining/read/bounded-query.js";
import { expectedMiningEventIds } from "../mining/read/ingestion-dto.js";
import type { MiningRunRecord } from "../mining/run-coordinator.js";

type Observation = MiningReadingObservation | MiningStateObservation;
type Query = ReturnType<typeof createBoundedMiningQuery>;

function invalid(message: string): never {
  throw new MiningQueryError("malformed", message);
}

function instant(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(value)) {
    return invalid("Invalid incident source timestamp.");
  }
  const parsed = Date.parse(value);
  const normalized = value.replace(
    /(?:\.(\d{1,7}))?Z$/,
    (_, fraction: string | undefined) => `.${(fraction ?? "").padEnd(3, "0").slice(0, 3)}Z`,
  );
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== normalized) {
    return invalid("Invalid incident source timestamp.");
  }
  return parsed;
}

function subMillisecond(value: string): boolean {
  const fraction = /\.(\d+)Z$/.exec(value)?.[1] ?? "";
  return /[1-9]/.test(fraction.slice(3));
}

function fingerprint(observation: Observation): string {
  const common = [
    observation.runId,
    observation.eventId,
    observation.timestamp,
    observation.kind,
    observation.ingestionTime ?? null,
  ];
  return JSON.stringify(
    observation.kind === "reading"
      ? [
          ...common,
          observation.tagId,
          observation.value,
          observation.unit,
          observation.quality,
          observation.intervalSeconds,
        ]
      : [
          ...common,
          observation.scopeId,
          observation.state,
          observation.scheduledRunning,
          observation.sequence,
        ],
  );
}

export function assertReconciledIncidentObservations(
  run: MiningRunRecord,
  observations: readonly Observation[],
  committed: readonly Observation[] = [],
): void {
  const expected = expectedMiningEventIds(run);
  for (const [kind, family] of [
    ["reading", "telemetry"],
    ["state", "state"],
  ] as const) {
    const ids = observations.filter((row) => row.kind === kind).map((row) => row.eventId);
    const hash = createHash("sha256")
      .update([...ids].sort().join("\n"))
      .digest("hex");
    if (ids.length !== expected[family].count || hash !== expected[family].hash) {
      invalid("The captured incident source does not match the complete run.");
    }
  }
  const current = new Map(observations.map((row) => [row.eventId, fingerprint(row)]));
  if (committed.some((row) => current.get(row.eventId) !== fingerprint(row))) {
    invalid("The captured incident source conflicts with the durable journal.");
  }
}

function mapRow(
  row: Record<string, unknown>,
  run: MiningIncidentRun,
  asOf: number,
  receivedAt: number,
): Observation {
  if (typeof row.timestamp !== "string" || typeof row.received_at !== "string") {
    return invalid("Invalid incident source timestamp.");
  }
  const timestamp = instant(row.timestamp);
  const ingested = instant(row.received_at);
  if (
    row.plant_id !== "D01" ||
    row.run_id !== run.runId ||
    row.catalog_version !== D01_CATALOG_VERSION ||
    row.source_contract_version !== "d01-validated-source-v1" ||
    typeof row.sequence !== "number" ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 1 ||
    row.event_id !== createHash("sha256").update(`${run.runId}:${row.sequence}`).digest("hex") ||
    subMillisecond(row.timestamp) ||
    timestamp < instant(run.startedAt) ||
    timestamp > instant(run.endsAt) ||
    timestamp > asOf ||
    ingested > receivedAt ||
    (ingested === receivedAt && subMillisecond(row.received_at))
  ) {
    return invalid("Incident observation does not match the approved run or source.");
  }
  const common = {
    runId: run.runId,
    eventId: row.event_id as string,
    timestamp: new Date(timestamp).toISOString(),
    ingestionTime: null,
  };
  if (row.source === "mining_ValidatedTelemetry") {
    const tag = D01_PLANT_CATALOG.telemetry_tags.find((candidate) => candidate.id === row.tag_id);
    if (
      !tag ||
      row.profile_version !== D01_PUBLISH_PROFILE_VERSION ||
      row.module_id !== tag.module_id ||
      row.equipment_id !== tag.equipment_id ||
      row.unit !== tag.unit ||
      row.interval_seconds !== getD01TagIntervalSeconds(tag) ||
      typeof row.value !== "number" ||
      !Number.isFinite(row.value) ||
      (row.quality !== "good" && row.quality !== "uncertain" && row.quality !== "bad")
    ) {
      return invalid("Incident telemetry does not match the pinned catalog or profile.");
    }
    return {
      ...common,
      kind: "reading",
      tagId: tag.id,
      value: row.value,
      unit: tag.unit,
      quality: row.quality,
      intervalSeconds: getD01TagIntervalSeconds(tag),
    };
  }
  if (
    row.source !== "mining_ValidatedState" ||
    (row.scope_id !== "A" &&
      row.scope_id !== "B" &&
      row.scope_id !== "C" &&
      row.scope_id !== "shared") ||
    (row.state !== "starting" &&
      row.state !== "running" &&
      row.state !== "idle" &&
      row.state !== "stopped" &&
      row.state !== "fault") ||
    typeof row.scheduled_running !== "boolean"
  ) {
    return invalid("Invalid incident state observation.");
  }
  return {
    ...common,
    kind: "state",
    scopeId: row.scope_id,
    state: row.state,
    scheduledRunning: row.scheduled_running,
    sequence: row.sequence,
  };
}

export function assertFabricIncidentSourceReady(readiness: Record<string, unknown>[]): void {
  const status = readiness[0];
  if (
    readiness.length !== 1 ||
    status?.status !== "READY" ||
    status.catalog_version !== D01_CATALOG_VERSION ||
    status.profile_version !== D01_PUBLISH_PROFILE_VERSION ||
    status.contract_version !== "d01-validated-source-v1"
  ) {
    throw new MiningQueryError("upstream", "The incident observation source is not ready.");
  }
}

/**
 * Visibility at query time is not a completeness watermark, and raw ingestion
 * time is not used as curated receipt provenance.
 */
export function createFabricIncidentSource(
  run: MiningIncidentRun,
  query: Query,
  now: () => number = Date.now,
): MiningIncidentSource {
  const definition = structuredClone(run);
  return {
    async read({ runId, asOf, committed, signal }) {
      if (runId !== definition.runId) invalid("Incident source run does not match.");
      const asOfMs = instant(asOf);
      if (asOfMs < instant(definition.startedAt) || asOfMs > instant(definition.endsAt)) {
        invalid("Incident source time is outside the approved run.");
      }
      const readiness = await query({ kind: "source-readiness", runId, maxRows: 1 }, signal);
      assertFabricIncidentSourceReady(readiness);
      const rows = await query(
        { kind: "incident-observations", runId, asOf, maxRows: 1000 },
        signal,
      );
      signal.throwIfAborted();
      const receivedMs = now();
      if (!Number.isFinite(receivedMs) || receivedMs < asOfMs) {
        invalid("Invalid incident source receipt time.");
      }
      const known = new Map(committed.map((item) => [item.eventId, fingerprint(item)]));
      const observations: Observation[] = [];
      for (const row of rows) {
        const observation = mapRow(row, definition, asOfMs, receivedMs);
        const body = fingerprint(observation);
        const prior = known.get(observation.eventId);
        if (prior !== undefined && prior !== body) invalid("Conflicting incident source event.");
        if (prior === undefined) {
          known.set(observation.eventId, body);
          observations.push(observation);
        }
      }
      return { observations, receivedAt: new Date(receivedMs).toISOString() };
    },
  };
}
