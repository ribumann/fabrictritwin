import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  D01_CATALOG_VERSION,
  D01_PLANT_CATALOG,
  D01_PUBLISH_PROFILE_VERSION,
  getD01TagIntervalSeconds,
} from "@triathlon-twin/simulator/mining";
import { createD01IncidentRun } from "../src/mining-incidents/catalog.js";
import { createFabricIncidentSource } from "../src/mining-incidents/fabric-source.js";
import type { createBoundedMiningQuery } from "../src/mining/read/bounded-query.js";

const runId = "11111111-1111-4111-8111-111111111111";
const start = "2026-01-01T12:00:00.000Z";
const asOf = "2026-01-01T12:01:00.000Z";
const receivedAt = "2026-01-01T12:01:03.000Z";
const run = createD01IncidentRun({ runId, startedAt: start, stopAt: "2026-01-01T12:05:00.000Z" });
const tag = D01_PLANT_CATALOG.telemetry_tags[0]!;
const eventId = (sequence: number) => createHash("sha256").update(`${runId}:${sequence}`).digest("hex");
const readiness = {
  status: "READY",
  catalog_version: D01_CATALOG_VERSION,
  profile_version: D01_PUBLISH_PROFILE_VERSION,
  contract_version: "d01-validated-source-v1",
};
const reading = {
  source: "mining_ValidatedTelemetry",
  plant_id: "D01",
  run_id: runId,
  event_id: eventId(1),
  sequence: 1,
  timestamp: "2026-01-01T12:00:30.000Z",
  received_at: "2026-01-01T12:01:02.1234567Z",
  catalog_version: D01_CATALOG_VERSION,
  profile_version: D01_PUBLISH_PROFILE_VERSION,
  source_contract_version: "d01-validated-source-v1",
  tag_id: tag.id,
  module_id: tag.module_id,
  equipment_id: tag.equipment_id,
  unit: tag.unit,
  interval_seconds: getD01TagIntervalSeconds(tag),
  value: 42,
  quality: "good",
};
const state = {
  source: "mining_ValidatedState",
  plant_id: "D01",
  run_id: runId,
  event_id: eventId(2),
  sequence: 2,
  timestamp: "2026-01-01T12:00:30.000Z",
  received_at: "2026-01-01T12:01:02.000Z",
  catalog_version: D01_CATALOG_VERSION,
  source_contract_version: "d01-validated-source-v1",
  scope_id: "A",
  state: "running",
  scheduled_running: true,
};

function fixture(rows: Record<string, unknown>[] = [reading, state], sourceStatus = readiness) {
  const query: ReturnType<typeof createBoundedMiningQuery> = vi.fn(async (input) =>
    input.kind === "source-readiness" ? [sourceStatus] : rows,
  );
  const source = createFabricIncidentSource(run, query, () => Date.parse(receivedAt));
  const signal = new AbortController().signal;
  return { query, source, signal };
}

describe("unmounted Fabric incident observations", () => {
  it("maps validated run-scoped rows once, preserving actual receipt separately from ingestion", async () => {
    const { source, signal, query } = fixture([reading, state, reading]);
    const first = await source.read({ runId, asOf, committed: [], signal });
    expect(first.receivedAt).toBe(receivedAt);
    expect(first.observations).toMatchObject([
      { kind: "reading", eventId: eventId(1), ingestionTime: null, value: 42 },
      { kind: "state", eventId: eventId(2), ingestionTime: null, state: "running" },
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(await source.read({ runId, asOf, committed: first.observations, signal })).toEqual({
      observations: [],
      receivedAt,
    });
  });

  it("returns late arrivals not present in the committed journal", async () => {
    const first = fixture([reading]);
    const saved = await first.source.read({ runId, asOf, committed: [], signal: first.signal });
    const next = fixture([reading, state]);
    const result = await next.source.read({ runId, asOf, committed: saved.observations, signal: next.signal });
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({ eventId: eventId(2), kind: "state" });
  });

  it("rejects source drift, altered identities, timestamps and conflicting duplicates", async () => {
    for (const bad of [
      { ...reading, run_id: "foreign" },
      { ...reading, event_id: eventId(2) },
      { ...reading, equipment_id: "foreign" },
      { ...reading, quality: "bad-data" },
      { ...reading, timestamp: "2026-01-01T12:02:00.000Z" },
      { ...reading, timestamp: "2026-01-01T12:00:30.0000001Z" },
      { ...reading, received_at: "2026-01-01T12:01:04.000Z" },
      { ...reading, received_at: "2026-01-01T12:01:03.0000001Z" },
      { ...state, scheduled_running: "true" },
    ]) {
      const { source, signal } = fixture([bad]);
      await expect(source.read({ runId, asOf, committed: [], signal })).rejects.toThrow();
    }
    const { source, signal } = fixture([reading, { ...reading, value: 43 }]);
    await expect(source.read({ runId, asOf, committed: [], signal })).rejects.toThrow(/Conflicting/);
    const blocked = fixture([], { ...readiness, status: "BLOCKED_SOURCE_CONTRACT" });
    await expect(blocked.source.read({ runId, asOf, committed: [], signal: blocked.signal })).rejects.toThrow(/not ready/);
    expect(blocked.query).toHaveBeenCalledTimes(1);
  });

  it("rejects a changed previously committed event and a foreign run", async () => {
    const original = fixture([reading]);
    const saved = await original.source.read({ runId, asOf, committed: [], signal: original.signal });
    const altered = fixture([{ ...reading, value: 43 }]);
    await expect(altered.source.read({ runId, asOf, committed: saved.observations, signal: altered.signal })).rejects.toThrow(/Conflicting/);
    await expect(altered.source.read({ runId: "foreign", asOf, committed: [], signal: altered.signal })).rejects.toThrow(/run/);
    expect(altered.query).toHaveBeenCalledTimes(2);
  });

  it("compares committed events by value regardless of object key order", async () => {
    const f = fixture([reading]);
    const saved = await f.source.read({ runId, asOf, committed: [], signal: f.signal });
    const reordered = Object.fromEntries(Object.entries(saved.observations[0]!).reverse());
    const observation = { ...reordered, ...saved.observations[0]! };
    expect(await f.source.read({ runId, asOf, committed: [observation], signal: f.signal }))
      .toEqual({ observations: [], receivedAt });
  });
});
