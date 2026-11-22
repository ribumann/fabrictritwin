import { describe, expect, it, vi } from "vitest";
import {
  D01_CONNECTION_PROFILE_VERSION,
  createD01SharedFlowSimulation,
} from "@triathlon-twin/simulator/mining";
import { createD01SharedFlowRunContract } from "../src/mining-incidents/catalog.js";
import type { MiningRunStatus } from "../src/mining/run-coordinator.js";
import {
  readConnectionRunEvidence,
  readExpectedConnectionRunEvidence,
} from "../src/mining/read/connection-run-evidence.js";

const status: MiningRunStatus = {
  runId: "11111111-1111-4111-8111-111111111111",
  admission: "accepted",
  phase: "publisher_complete",
  stopRequested: false,
  run: {
    plantId: "D01",
    runId: "11111111-1111-4111-8111-111111111111",
    profileVersion: D01_CONNECTION_PROFILE_VERSION,
    scenario: "normal",
    seed: 1,
    durationSeconds: 190,
    shutdownAtSeconds: 10,
    drainDownSeconds: 180,
    startedAt: "2026-01-01T12:00:07.000Z",
    stopAt: "2026-01-01T12:03:17.000Z",
    authorityUntil: "2026-01-01T12:00:52.000Z",
    phase: "publisher_complete",
    connectionProfileContract: createD01SharedFlowRunContract(),
  },
};
const asOf = "2026-01-01T12:04:00.000Z";

function fixture() {
  const expectedSet = vi.fn(async (input: { expectedEventIds: readonly string[] }) => ({
    evidenceScope: "explicit_expected_ids_only" as const,
    evidence: input.expectedEventIds.map((eventId) => ({
      eventId,
      status: "OBSERVED_MATCH" as const,
      rawCopies: 1,
      validatedCopies: 1,
      rawEvent: null,
      rawSampleTime: null,
      validatedEvent: null,
    })),
  }));
  const readStatus = vi.fn(async () => structuredClone(status));
  return { expectedSet, readStatus };
}

describe("bounded complete-run connection evidence", () => {
  it("checks every scheduled ID in bounded pages without claiming unexpected-event coverage", async () => {
    const f = fixture();
    const result = await readExpectedConnectionRunEvidence(
      status,
      asOf,
      { expectedSet: f.expectedSet },
      f.readStatus,
      new AbortController().signal,
    );
    expect(result.expectedCount).toBe(38 * 57);
    expect(result.statusCounts.OBSERVED_MATCH).toBe(38 * 57);
    expect(result.allExpectedIdsMatchedAtCutoff).toBe(true);
    expect(result.unexpectedEventsChecked).toBe(false);
    expect(f.expectedSet).toHaveBeenCalledTimes(11);
    expect(f.readStatus).toHaveBeenCalledTimes(12);
  });

  describe("full connection-run evidence", () => {
    function fullFixture() {
      const run = status.run!;
      if (!("stopAt" in run)) throw new Error("Expected bounded run.");
      const simulation = createD01SharedFlowSimulation(
        {
          runId: run.runId,
          startedAt: new Date(run.startedAt),
          durationSeconds: run.durationSeconds,
          shutdownAtSeconds: run.shutdownAtSeconds,
          drainDownSeconds: run.drainDownSeconds,
        },
        () => Date.parse(run.stopAt),
      );
      const events = new Map(
        Array.from(
          { length: run.durationSeconds / 5 },
          (_, i) =>
            simulation.step(new Date(Date.parse(run.startedAt) + (i + 1) * 5000)).observations,
        )
          .flat()
          .map((event) => [event.event_id, event]),
      );
      const expectedSet = vi.fn(async (input: { expectedEventIds: readonly string[] }) => ({
        evidenceScope: "explicit_expected_ids_only" as const,
        evidence: input.expectedEventIds.map((eventId) => {
          const event = events.get(eventId)!;
          return {
            eventId,
            status: "OBSERVED_MATCH" as const,
            rawCopies: 1,
            validatedCopies: 1,
            rawEvent: { ...event, sample_time: event.sample_time.replace("Z", "0000Z") },
            rawSampleTime: event.sample_time,
            validatedEvent: { ...event, sample_time: event.sample_time.replace("Z", "0000Z") },
          };
        }),
      }));
      const runRowTotals = vi.fn(async () => ({
        rawRows: events.size,
        validatedRows: events.size,
        rawReceiptTimeMissing: 0,
        validatedReceiptTimeMissing: 0,
      }));
      return { expectedSet, runRowTotals, readStatus: vi.fn(async () => structuredClone(status)) };
    }

    it("checks complete payloads and all run-associated rows at a shared cutoff", async () => {
      const f = fullFixture();
      const evidence = await readConnectionRunEvidence(
        status,
        asOf,
        f,
        f.readStatus,
        AbortSignal.timeout(30000),
      );
      expect(evidence.completeAtCutoff).toBe(true);
      expect(evidence.expectedCount).toBe(38 * 57);
      expect(evidence.unexpectedRawCopies).toBe(0);
      expect(f.runRowTotals).toHaveBeenCalledWith(
        { runId: status.runId, asOf },
        expect.any(AbortSignal),
      );
    });

    it("does not claim completeness for unexpected events, missing receipt time, or wrong payload", async () => {
      const f = fullFixture();
      f.runRowTotals.mockResolvedValueOnce({
        rawRows: 38 * 57 + 1,
        validatedRows: 38 * 57,
        rawReceiptTimeMissing: 0,
        validatedReceiptTimeMissing: 1,
      });
      const result = await readConnectionRunEvidence(
        status,
        asOf,
        f,
        f.readStatus,
        AbortSignal.timeout(30000),
      );
      expect(result.completeAtCutoff).toBe(false);
      expect(result.unexpectedRawCopies).toBe(1);
      expect(result.validatedReceiptTimeMissing).toBe(1);
      const g = fullFixture();
      const original = g.expectedSet.getMockImplementation()!;
      g.expectedSet.mockImplementationOnce(async (input) => {
        const page = await original(input);
        page.evidence[0].rawEvent.value += 1;
        return page;
      });
      const mismatch = await readConnectionRunEvidence(
        status,
        asOf,
        g,
        g.readStatus,
        AbortSignal.timeout(30000),
      );
      expect(mismatch.payloadMismatches).toBe(1);
      expect(mismatch.completeAtCutoff).toBe(false);
    });

    it("rejects totals smaller than the paged copies", async () => {
      const f = fullFixture();
      f.runRowTotals.mockResolvedValueOnce({
        rawRows: 1,
        validatedRows: 1,
        rawReceiptTimeMissing: 0,
        validatedReceiptTimeMissing: 0,
      });
      await expect(
        readConnectionRunEvidence(status, asOf, f, f.readStatus, AbortSignal.timeout(30000)),
      ).rejects.toThrow("totals disagree");
    });

    it("rejects altered validated values, tags and scheduled sample times", async () => {
      for (const field of ["value", "measurement_tag_id", "sample_time"] as const) {
        const f = fullFixture();
        const original = f.expectedSet.getMockImplementation()!;
        f.expectedSet.mockImplementationOnce(async (input) => {
          const page = await original(input);
          const event = page.evidence[0].validatedEvent;
          if (field === "value") event.value += 1;
          else if (field === "measurement_tag_id") event.measurement_tag_id = "unexpected";
          else event.sample_time = "2026-01-01T12:00:00.0000000Z";
          return page;
        });
        const result = await readConnectionRunEvidence(
          status,
          asOf,
          f,
          f.readStatus,
          AbortSignal.timeout(30000),
        );
        expect(result.payloadMismatches).toBe(1);
        expect(result.completeAtCutoff).toBe(false);
      }
    });
  });

  it("withdraws partial results if the run changes while querying", async () => {
    const f = fixture();
    f.readStatus.mockResolvedValueOnce(structuredClone(status));
    f.readStatus.mockResolvedValueOnce({ ...status, stopRequested: true });
    await expect(
      readExpectedConnectionRunEvidence(
        status,
        asOf,
        { expectedSet: f.expectedSet },
        f.readStatus,
        new AbortController().signal,
      ),
    ).rejects.toThrow("changed");
    expect(f.expectedSet).toHaveBeenCalledOnce();
  });

  it("rejects a cutoff before the completed run", async () => {
    const f = fixture();
    await expect(
      readExpectedConnectionRunEvidence(
        status,
        "2026-01-01T12:02:00.000Z",
        { expectedSet: f.expectedSet },
        f.readStatus,
        new AbortController().signal,
      ),
    ).rejects.toThrow("cutoff");
    expect(f.expectedSet).not.toHaveBeenCalled();
  });
});
