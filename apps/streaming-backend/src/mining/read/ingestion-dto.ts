import { createHash } from "node:crypto";
import { createD01Simulation, D01_EVENT_ENTITY_TYPES } from "@triathlon-twin/simulator/mining";
import { assertD01RunContract } from "../../mining-incidents/catalog.js";
import type { MiningRunRecord } from "../run-coordinator.js";
import { MiningQueryError } from "./bounded-query.js";

const families = [
  "raw_telemetry",
  "raw_state",
  "validated_telemetry",
  "validated_state",
  "quarantine",
] as const;
type Family = (typeof families)[number];

export function expectedMiningEventIds(run: MiningRunRecord) {
  assertD01RunContract(run.contract);
  const start = Date.parse(run.startedAt);
  if (
    !Number.isFinite(start) ||
    run.durationSeconds % 5 !== 0 ||
    run.durationSeconds < 5 ||
    run.durationSeconds > 1800 ||
    Date.parse(run.stopAt) !== start + run.durationSeconds * 1000
  ) {
    throw new MiningQueryError("invalid", "Invalid persisted ingestion run window.");
  }
  const simulation = createD01Simulation({ ...run, startedAt: new Date(start) });
  const ids = { telemetry: new Set<string>(), state: new Set<string>() };
  for (let seconds = 5; seconds <= run.durationSeconds; seconds += 5) {
    simulation.step(new Date(start + seconds * 1000));
    const batch = simulation.getPendingBatch();
    if (batch) {
      for (const event of batch.events) {
        ids[event.entityType === D01_EVENT_ENTITY_TYPES.telemetry ? "telemetry" : "state"].add(
          event.event_id,
        );
      }
      simulation.acknowledgeBatch(batch.batch_id);
    }
  }
  const summarize = (values: Set<string>) => ({
    count: values.size,
    hash: createHash("sha256")
      .update([...values].sort().join("\n"))
      .digest("hex"),
  });
  return { telemetry: summarize(ids.telemetry), state: summarize(ids.state) };
}

export function mapMiningIngestion(
  run: MiningRunRecord,
  asOf: string,
  rows: Record<string, unknown>[],
) {
  if (!Number.isFinite(Date.parse(asOf))) {
    throw new MiningQueryError("invalid", "Invalid ingestion reconciliation timestamp.");
  }
  const observed = new Map<
    Family,
    { count: number; copies: number; conflicts: number; hash: string }
  >();
  let ready = true;
  for (const row of rows) {
    const family = families.find((item) => item === row.family);
    if (
      !family ||
      observed.has(family) ||
      typeof row.source_status !== "string" ||
      typeof row.event_ids_hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.event_ids_hash) ||
      [row.event_count, row.copies, row.conflicting_ids].some(
        (value) => typeof value !== "number" || !Number.isSafeInteger(value) || value < 0,
      ) ||
      Number(row.copies) < Number(row.event_count) ||
      Number(row.conflicting_ids) > Number(row.event_count) ||
      Number(row.event_count) >= 50000
    ) {
      throw new MiningQueryError("malformed", "Invalid or unbounded ingestion reconciliation.");
    }
    ready &&= row.source_status === "READY";
    observed.set(family, {
      count: Number(row.event_count),
      copies: Number(row.copies),
      conflicts: Number(row.conflicting_ids),
      hash: row.event_ids_hash,
    });
  }
  if (observed.size !== families.length) {
    throw new MiningQueryError("malformed", "Missing ingestion reconciliation family.");
  }
  const expected = expectedMiningEventIds(run);
  const matches = (family: Family, expectation: { count: number; hash: string }) => {
    const actual = observed.get(family)!;
    return (
      actual.count === expectation.count &&
      actual.hash === expectation.hash &&
      actual.conflicts === 0
    );
  };
  const complete =
    ready &&
    run.phase === "publisher_complete" &&
    Date.parse(asOf) >= Date.parse(run.stopAt) &&
    matches("raw_telemetry", expected.telemetry) &&
    matches("validated_telemetry", expected.telemetry) &&
    matches("raw_state", expected.state) &&
    matches("validated_state", expected.state) &&
    observed.get("quarantine")!.count === 0;
  const any = [...observed.values()].some((row) => row.count > 0);
  const status: "complete" | "partial" | "pending" | "unknown" = !ready
    ? "unknown"
    : complete
      ? "complete"
      : any
        ? "partial"
        : "pending";
  return {
    status,
    asOf,
    expected,
    observed: Object.fromEntries(
      [...observed].map(([family, value]) => [
        family,
        { events: value.count, copies: value.copies, conflicts: value.conflicts },
      ]),
    ),
    provenance: "fabric-event-id-reconciliation-v1" as const,
  };
}
