import type { MiningRunStatus } from "../run-coordinator.js";
import { MiningQueryError } from "./bounded-query.js";
import {
  expectedConnectionEventBatches,
  expectedConnectionObservationBatches,
} from "./connection-expected-events.js";
import type { createMiningConnectionFlowProvider } from "./connection-flow-provider.js";
import {
  D01_CONNECTION_EVENT_FIELDS,
  type D01ConnectionMeasurementEvent,
} from "@triathlon-twin/simulator/mining";

type Provider = ReturnType<typeof createMiningConnectionFlowProvider>;
type StatusReader = (runId: string, signal: AbortSignal) => Promise<MiningRunStatus | undefined>;

export function connectionRunIdentity(status: MiningRunStatus | undefined): string {
  if (!status?.run || !("profileVersion" in status.run)) {
    throw new MiningQueryError("upstream", "The completed connection run is unavailable.");
  }
  const run = status.run;
  return JSON.stringify([
    status.runId,
    status.admission,
    status.phase,
    status.stopRequested,
    run.plantId,
    run.runId,
    run.profileVersion,
    run.phase,
    run.scenario,
    run.seed,
    run.durationSeconds,
    run.shutdownAtSeconds,
    run.drainDownSeconds,
    run.startedAt,
    run.stopAt,
    run.finalFlushUntil,
    run.connectionProfileContract?.catalogVersion,
    run.connectionProfileContract?.measurementCatalogVersion,
    run.connectionProfileContract?.profileVersion,
    run.connectionProfileContract?.legacyProjectionProfileVersion,
  ]);
}

/**
 * Reconciles only the expected IDs of one completed normal run at one cutoff.
 * Unexpected events and events arriving after the cutoff are not checked.
 */
export async function readExpectedConnectionRunEvidence(
  status: MiningRunStatus,
  asOf: string,
  provider: Pick<Provider, "expectedSet">,
  readStatus: StatusReader,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const initialIdentity = connectionRunIdentity(status);
  const run = status.run;
  if (
    !run ||
    !("stopAt" in run) ||
    !Number.isFinite(Date.parse(asOf)) ||
    Date.parse(asOf) < Date.parse(run.stopAt)
  ) {
    throw new MiningQueryError("invalid", "Connection evidence cutoff must follow the run.");
  }
  const assertCurrent = async () => {
    signal.throwIfAborted();
    const current = await readStatus(status.runId, signal);
    signal.throwIfAborted();
    if (connectionRunIdentity(current) !== initialIdentity) {
      throw new MiningQueryError("upstream", "Connection run changed during reconciliation.");
    }
  };
  const counts: Record<string, number> = Object.create(null);
  let total = 0;
  await assertCurrent();
  for (const expectedEventIds of expectedConnectionEventBatches(status)) {
    const result = await provider.expectedSet(
      { runId: status.runId, asOf, expectedEventIds },
      signal,
    );
    await assertCurrent();
    for (const item of result.evidence) {
      counts[item.status] = (counts[item.status] ?? 0) + 1;
      total++;
    }
  }
  return {
    evidenceScope: "expected_ids_only" as const,
    asOf,
    expectedCount: total,
    statusCounts: counts,
    allExpectedIdsMatchedAtCutoff:
      total > 0 && (counts.OBSERVED_MATCH ?? 0) + (counts.DUPLICATE_MATCH ?? 0) === total,
    unexpectedEventsChecked: false as const,
  };
}

function matchesExpectedObservation(
  expected: D01ConnectionMeasurementEvent,
  raw: Record<string, unknown> | null,
  sampleTime: string | null,
): boolean {
  if (!raw || sampleTime !== expected.sample_time) return false;
  const allowedEnvelope = new Set(["EventProcessedUtcTime", "PartitionId", "EventEnqueuedUtcTime"]);
  const allowedFields = new Set<string>(D01_CONNECTION_EVENT_FIELDS);
  if (Object.keys(raw).some((key) => !allowedFields.has(key) && !allowedEnvelope.has(key))) {
    return false;
  }
  return D01_CONNECTION_EVENT_FIELDS.every((field) => {
    if (!Object.hasOwn(raw, field)) return false;
    if (field === "sample_time") {
      return (
        typeof raw[field] === "string" &&
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(raw[field]) &&
        raw[field].replace(
          /(?:\.(\d{1,7}))?Z$/,
          (_, fraction: string | undefined) => `.${(fraction ?? "").padEnd(7, "0")}Z`,
        ) === expected.sample_time.replace("Z", "0000Z")
      );
    }
    return raw[field] === expected[field];
  });
}

function matchesValidatedObservation(
  expected: D01ConnectionMeasurementEvent,
  validated: Record<string, unknown> | null,
): boolean {
  if (!validated) return false;
  return D01_CONNECTION_EVENT_FIELDS.every((field) => {
    if (field === "entityType") return true;
    if (!Object.hasOwn(validated, field)) return false;
    if (field === "sample_time") {
      const value = validated[field];
      return (
        typeof value === "string" &&
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(value) &&
        value.replace(
          /(?:\.(\d{1,7}))?Z$/,
          (_, fraction: string | undefined) => `.${(fraction ?? "").padEnd(7, "0")}Z`,
        ) === expected.sample_time.replace("Z", "0000Z")
      );
    }
    return (
      validated[field] === expected[field] || (expected[field] === null && validated[field] === "")
    );
  });
}

/**
 * Compares every scheduled observation and all run-associated row counts at
 * one cutoff. This is a snapshot, not a guarantee against later arrivals.
 */
export async function readConnectionRunEvidence(
  status: MiningRunStatus,
  asOf: string,
  provider: Pick<Provider, "expectedSet" | "runRowTotals">,
  readStatus: StatusReader,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const identity = connectionRunIdentity(status);
  const run = status.run;
  if (
    !run ||
    !("stopAt" in run) ||
    !Number.isFinite(Date.parse(asOf)) ||
    Date.parse(asOf) < Date.parse(run.stopAt)
  ) {
    throw new MiningQueryError("invalid", "Connection evidence cutoff must follow the run.");
  }
  const assertCurrent = async () => {
    signal.throwIfAborted();
    const current = await readStatus(status.runId, signal);
    signal.throwIfAborted();
    if (connectionRunIdentity(current) !== identity) {
      throw new MiningQueryError("upstream", "Connection run changed during reconciliation.");
    }
  };
  await assertCurrent();
  let expectedCount = 0;
  let rawCopies = 0;
  let validatedCopies = 0;
  let payloadMismatches = 0;
  const statusCounts: Record<string, number> = Object.create(null);
  for (const page of expectedConnectionObservationBatches(status)) {
    const result = await provider.expectedSet(
      { runId: status.runId, asOf, expectedEventIds: page.map((event) => event.event_id) },
      signal,
    );
    await assertCurrent();
    const expected = new Map(page.map((event) => [event.event_id, event]));
    for (const item of result.evidence) {
      const observation = expected.get(item.eventId);
      if (!observation) throw new MiningQueryError("malformed", "Unexpected evidence identity.");
      expected.delete(item.eventId);
      statusCounts[item.status] = (statusCounts[item.status] ?? 0) + 1;
      rawCopies += item.rawCopies;
      validatedCopies += item.validatedCopies;
      if (
        (item.status === "OBSERVED_MATCH" || item.status === "DUPLICATE_MATCH") &&
        (!matchesExpectedObservation(observation, item.rawEvent, item.rawSampleTime) ||
          !matchesValidatedObservation(observation, item.validatedEvent))
      )
        payloadMismatches++;
      expectedCount++;
    }
    if (expected.size) throw new MiningQueryError("malformed", "Incomplete evidence page.");
  }
  const totals = await provider.runRowTotals({ runId: status.runId, asOf }, signal);
  await assertCurrent();
  if (totals.rawRows < rawCopies || totals.validatedRows < validatedCopies) {
    throw new MiningQueryError("malformed", "Connection row totals disagree with paged evidence.");
  }
  const unexpectedRawCopies = totals.rawRows - rawCopies;
  const unexpectedValidatedCopies = totals.validatedRows - validatedCopies;
  return {
    asOf,
    expectedCount,
    rawRows: totals.rawRows,
    validatedRows: totals.validatedRows,
    statusCounts,
    payloadMismatches,
    unexpectedRawCopies,
    unexpectedValidatedCopies,
    rawReceiptTimeMissing: totals.rawReceiptTimeMissing,
    validatedReceiptTimeMissing: totals.validatedReceiptTimeMissing,
    completeAtCutoff:
      expectedCount > 0 &&
      (statusCounts.OBSERVED_MATCH ?? 0) + (statusCounts.DUPLICATE_MATCH ?? 0) === expectedCount &&
      payloadMismatches === 0 &&
      unexpectedRawCopies === 0 &&
      unexpectedValidatedCopies === 0 &&
      totals.rawReceiptTimeMissing === 0 &&
      totals.validatedReceiptTimeMissing === 0,
  };
}
