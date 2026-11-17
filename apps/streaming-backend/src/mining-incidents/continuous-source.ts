import { D01_CATALOG_VERSION, D01_PUBLISH_PROFILE_VERSION } from "@triathlon-twin/simulator/mining";
import { assertFabricIncidentSourceReady, mapFabricIncidentObservation } from "./fabric-source.js";
import type { MiningReadingObservation, MiningStateObservation } from "./evaluator.js";
import type { MiningIncidentRun } from "./runtime.js";
import { MiningQueryError } from "../mining/read/bounded-query.js";

type Observation = MiningReadingObservation | MiningStateObservation;

/** Fixed query with bound parameters; callers must enforce the normal row, byte and time limits. */
export const continuousIncidentPartitionQuery = `declare query_parameters(
  plant:string, run:string, start:datetime, end:datetime, include_end:bool);
let candidates = materialize(union
(mining_DeduplicatedTelemetry(plant, run, start, end)
 | where timestamp < end or (include_end and timestamp == end)
 | project source = "mining_ValidatedTelemetry", plant_id, run_id, event_id,
     sequence, timestamp, received_at, tag_id, value, unit, quality,
     interval_seconds = tolong(interval_seconds),
     scope_id = "", scheduled_running = bool(null), state = "",
     catalog_version = "${D01_CATALOG_VERSION}",
     profile_version = "${D01_PUBLISH_PROFILE_VERSION}",
     source_contract_version = "d01-validated-source-v1", module_id, equipment_id,
     event_conflict),
(mining_DeduplicatedState(plant, run, start, end)
 | where timestamp < end or (include_end and timestamp == end)
 | project source = "mining_ValidatedState", plant_id, run_id, event_id,
     sequence, timestamp, received_at, tag_id = "", value = real(null), unit = "",
     quality = "", interval_seconds = long(null), scope_id, scheduled_running, state,
     catalog_version = "${D01_CATALOG_VERSION}", profile_version = "",
     source_contract_version = "d01-validated-source-v1", module_id = "", equipment_id = "",
     event_conflict));
let identities = union
  (mining_ValidatedTelemetry
   | where plant_id == plant and run_id == run
   | project event_id, payload_fingerprint,
       identity = tostring(pack_array("telemetry", sequence, timestamp, module_id,
         equipment_id, tag_id, value, unit, quality, interval_seconds,
         catalog_version, profile_version, source_contract_version))),
  (mining_ValidatedState
   | where plant_id == plant and run_id == run
   | project event_id, payload_fingerprint,
       identity = tostring(pack_array("state", sequence, timestamp, scope_id,
         scheduled_running, state, catalog_version, source_contract_version)))
  | join kind=leftsemi (candidates | distinct event_id) on event_id
  | summarize fingerprints = make_set(payload_fingerprint, 2),
      identities = make_set(identity, 2),
      missing_fingerprints = countif(isempty(payload_fingerprint)) by event_id;
candidates
| join kind=inner identities on event_id
| extend event_conflict = event_conflict or array_length(fingerprints) != 1
    or array_length(identities) != 1 or missing_fingerprints > 0
| project source, plant_id, run_id, event_id, sequence, timestamp, received_at,
    tag_id, value, unit, quality, interval_seconds, scope_id, scheduled_running, state,
    catalog_version, profile_version, source_contract_version, module_id, equipment_id,
    event_conflict
| order by timestamp asc, sequence asc`;

export interface ContinuousIncidentPartition {
  runId: string;
  start: string;
  end: string;
  includeEnd: boolean;
  maxRows: 1000;
}

export interface ContinuousIncidentSourceDependencies {
  readiness(signal: AbortSignal): Promise<Record<string, unknown>[]>;
  query(
    input: ContinuousIncidentPartition,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>[]>;
  now(): number;
}

function instant(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new MiningQueryError("invalid", "Continuous incident times must be canonical UTC.");
  }
  return parsed;
}

/**
 * Reads a bounded 20-minute event-time slice; source visibility is not an
 * ingestion-completeness watermark, nor authorization to use an owner.
 */
export async function readContinuousIncidentWindow(
  run: MiningIncidentRun,
  asOf: string,
  dependencies: ContinuousIncidentSourceDependencies,
  signal: AbortSignal,
): Promise<{ sourceObservedAt: string; observations: Observation[] }> {
  const started = instant(run.startedAt);
  const end = instant(asOf);
  if (end <= started || end > instant(run.endsAt) || (end - started) % 60_000 !== 0) {
    throw new MiningQueryError("invalid", "Invalid continuous incident window.");
  }
  signal.throwIfAborted();
  assertFabricIncidentSourceReady(await dependencies.readiness(signal));
  const start = Math.max(started, end - 20 * 60_000);
  const partitions: Array<{ start: number; end: number; last: boolean }> = [];
  for (let from = start; from < end; from += 5 * 60_000) {
    const to = Math.min(end, from + 5 * 60_000);
    partitions.push({ start: from, end: to, last: to === end });
  }
  const results = await Promise.all(
    partitions.map(async (partition) => {
      const rows = await dependencies.query(
        {
          runId: run.runId,
          start: new Date(partition.start).toISOString(),
          end: new Date(partition.end).toISOString(),
          includeEnd: partition.last,
          maxRows: 1000,
        },
        signal,
      );
      if (rows.length > 1000) {
        throw new MiningQueryError("overflow", "Continuous incident partition exceeds its budget.");
      }
      return rows.map((row) => ({ row, ...partition }));
    }),
  );
  signal.throwIfAborted();
  const captured = results.flat();
  if (captured.length > 4096) {
    throw new MiningQueryError("overflow", "Continuous incident evidence exceeds its budget.");
  }
  assertFabricIncidentSourceReady(await dependencies.readiness(signal));
  signal.throwIfAborted();
  const observed = dependencies.now();
  if (!Number.isFinite(observed) || observed < end) {
    throw new MiningQueryError("invalid", "Invalid continuous incident source observation time.");
  }
  const observations: Observation[] = [];
  const ids = new Set<string>();
  for (const partition of captured) {
    if (partition.row.event_conflict !== false) {
      throw new MiningQueryError("malformed", "Continuous incident evidence contains a conflict.");
    }
    const observation = mapFabricIncidentObservation(partition.row, run, end, observed);
    const timestamp = instant(observation.timestamp);
    if (
      timestamp < partition.start ||
      timestamp > partition.end ||
      (!partition.last && timestamp === partition.end) ||
      ids.has(observation.eventId)
    ) {
      throw new MiningQueryError("malformed", "Continuous incident partition evidence overlaps.");
    }
    ids.add(observation.eventId);
    observations.push(observation);
  }
  return { sourceObservedAt: new Date(observed).toISOString(), observations };
}
