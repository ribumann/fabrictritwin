import { assertFabricIncidentSourceReady, mapFabricIncidentObservation } from "./fabric-source.js";
import type { MiningReadingObservation, MiningStateObservation } from "./evaluator.js";
import type { MiningIncidentRun } from "./runtime.js";
import { MiningQueryError } from "../mining/read/bounded-query.js";
import { continuousIncidentPartitionQuery } from "../mining/read/continuous-incident-query.js";

type Observation = MiningReadingObservation | MiningStateObservation;

export { continuousIncidentPartitionQuery };

export interface ContinuousIncidentPartition {
  runId: string;
  start: string;
  end: string;
  includeEnd: boolean;
  maxRows: 1000;
}

export interface ContinuousIncidentSourceDependencies {
  readiness(runId: string, signal: AbortSignal): Promise<Record<string, unknown>[]>;
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
  const start = end - 20 * 60_000;
  if (start < started) {
    throw new MiningQueryError("upstream", "Continuous incident evidence is warming up.");
  }
  assertFabricIncidentSourceReady(await dependencies.readiness(run.runId, signal));
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
  assertFabricIncidentSourceReady(await dependencies.readiness(run.runId, signal));
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
