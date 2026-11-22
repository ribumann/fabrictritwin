import { describe, expect, it } from "vitest";
import {
  D01_CONNECTION_PROFILE_VERSION,
  createD01SharedFlowSimulation,
} from "@triathlon-twin/simulator/mining";
import { createD01SharedFlowRunContract } from "../src/mining-incidents/catalog.js";
import type { BoundedMiningRunRecord } from "../src/mining/run-coordinator.js";
import { expectedConnectionEventBatches } from "../src/mining/read/connection-expected-events.js";

const startedAt = "2026-01-01T12:00:07.000Z";
const run: BoundedMiningRunRecord = {
  plantId: "D01",
  runId: "11111111-1111-4111-8111-111111111111",
  profileVersion: D01_CONNECTION_PROFILE_VERSION,
  scenario: "normal",
  seed: 1,
  durationSeconds: 190,
  shutdownAtSeconds: 10,
  drainDownSeconds: 180,
  startedAt,
  stopAt: "2026-01-01T12:03:17.000Z",
  authorityUntil: "2026-01-01T12:00:52.000Z",
  phase: "publisher_complete",
  connectionProfileContract: createD01SharedFlowRunContract(),
};
const status = {
  runId: run.runId,
  admission: "accepted" as const,
  phase: "publisher_complete" as const,
  stopRequested: false,
  run,
};

describe("expected connection identities", () => {
  it("matches every event in a completed normal simulator run and batches at 200", () => {
    const simulation = createD01SharedFlowSimulation(
      {
        runId: run.runId,
        startedAt: new Date(startedAt),
        durationSeconds: 190,
        shutdownAtSeconds: 10,
        drainDownSeconds: 180,
      },
      () => Date.parse(startedAt) + 190_000,
    );
    const actual: string[] = [];
    for (let elapsed = 5; elapsed <= 190; elapsed += 5) {
      actual.push(
        ...simulation
          .step(new Date(Date.parse(startedAt) + elapsed * 1000))
          .observations.map((event) => event.event_id),
      );
    }
    const batches = [...expectedConnectionEventBatches(status)];
    expect(batches.every((batch) => batch.length > 0 && batch.length <= 200)).toBe(true);
    expect(batches.flat()).toEqual(actual);
    expect(actual).toHaveLength(38 * 57);
  });

  it("refuses incomplete, non-normal or unpinned runs", () => {
    for (const invalid of [
      { ...run, phase: "running" as const },
      { ...run, scenario: "communication-gap" as const },
      { ...run, connectionProfileContract: undefined },
      { ...run, runId: "invalid" },
    ]) {
      expect(() => [...expectedConnectionEventBatches({ ...status, run: invalid })]).toThrow();
    }
    expect(() => [...expectedConnectionEventBatches({ ...status, stopRequested: true })]).toThrow();
    expect(() => [
      ...expectedConnectionEventBatches({ ...status, admission: "pending" }),
    ]).toThrow();
  });
});
