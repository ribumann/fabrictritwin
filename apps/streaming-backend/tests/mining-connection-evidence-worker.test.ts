import { describe, expect, it, vi } from "vitest";
import {
  D01_CONNECTION_PROFILE_VERSION,
  createD01SharedFlowSimulation,
} from "@triathlon-twin/simulator/mining";
import { createD01SharedFlowRunContract } from "../src/mining-incidents/catalog.js";
import type { MiningRunStatus } from "../src/mining/run-coordinator.js";
import {
  MiningConnectionEvidenceWorker,
  readConnectionEvidenceSnapshot,
} from "../src/mining/read/connection-evidence-worker.js";
import { MiningQueryError } from "../src/mining/read/bounded-query.js";

const start = "2026-01-01T12:00:00.000Z";
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
    durationSeconds: 185,
    shutdownAtSeconds: 5,
    drainDownSeconds: 180,
    startedAt: start,
    stopAt: "2026-01-01T12:03:05.000Z",
    authorityUntil: "2026-01-01T12:00:45.000Z",
    phase: "publisher_complete",
    connectionProfileContract: createD01SharedFlowRunContract(),
  },
};

function fixture() {
  const simulator = createD01SharedFlowSimulation(
    {
      runId: status.runId,
      startedAt: new Date(start),
      durationSeconds: 185,
      shutdownAtSeconds: 5,
      drainDownSeconds: 180,
    },
    () => Date.parse("2026-01-01T12:03:05.000Z"),
  );
  const events = new Map(
    Array.from(
      { length: 37 },
      (_, i) => simulator.step(new Date(Date.parse(start) + (i + 1) * 5000)).observations,
    )
      .flat()
      .map((event) => [event.event_id, event]),
  );
  const provider = {
    expectedSet: vi.fn(async (input: { expectedEventIds: readonly string[] }) => ({
      evidenceScope: "explicit_expected_ids_only" as const,
      evidence: input.expectedEventIds.map((id) => {
        const event = events.get(id)!;
        return {
          eventId: id,
          status: "OBSERVED_MATCH" as const,
          rawCopies: 1,
          validatedCopies: 1,
          rawEvent: { ...event },
          rawSampleTime: event.sample_time,
          validatedEvent: { ...event },
        };
      }),
    })),
    runRowTotals: vi.fn(async () => ({
      rawRows: events.size,
      validatedRows: events.size,
      rawReceiptTimeMissing: 0,
      validatedReceiptTimeMissing: 0,
    })),
  };
  const docs = new Map<string, unknown>();
  const store = {
    read: vi.fn(async (path: string) =>
      docs.has(path) ? { value: docs.get(path), etag: "1", leased: false } : undefined,
    ),
    create: vi.fn(async (path: string, value: unknown) => {
      if (docs.has(path)) return false;
      docs.set(path, structuredClone(value));
      return true;
    }),
  };
  const approvedStatus = vi.fn(async () => structuredClone(status));
  const now = () => Date.parse("2026-01-01T12:05:00.000Z");
  return { provider, store, approvedStatus, now, docs };
}

describe("connection evidence worker", () => {
  it("retries transient query failures and rechecks authority before capturing evidence", async () => {
    const f = fixture();
    f.provider.expectedSet.mockRejectedValueOnce(
      new MiningQueryError("timeout", "Query timed out"),
    );
    const wait = vi.fn(async () => {});
    const worker = new MiningConnectionEvidenceWorker({ ...f, wait });
    await worker.start(status.runId);
    expect(wait).toHaveBeenCalledWith(5_000, expect.any(AbortSignal));
    expect(f.approvedStatus.mock.calls.length).toBeGreaterThan(2);
    expect(f.store.create).toHaveBeenCalledOnce();
    await worker.close();
  });

  it("bounds transient retries and does not create evidence after failure", async () => {
    const f = fixture();
    f.provider.expectedSet.mockRejectedValue(new MiningQueryError("upstream", "Unavailable"));
    const wait = vi.fn(async () => {});
    const worker = new MiningConnectionEvidenceWorker({ ...f, wait });
    await expect(worker.start(status.runId)).rejects.toThrow("Unavailable");
    expect(f.provider.expectedSet).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls.map(([ms]) => ms)).toEqual([5_000, 30_000]);
    expect(f.store.create).not.toHaveBeenCalled();
    await worker.close();
  });

  it("stops a retry when the approved run changes", async () => {
    const f = fixture();
    f.provider.expectedSet.mockRejectedValueOnce(
      new MiningQueryError("timeout", "Query timed out"),
    );
    const wait = vi.fn(async () => {
      f.approvedStatus.mockResolvedValue({
        ...status,
        runId: "22222222-2222-4222-8222-222222222222",
      });
    });
    const worker = new MiningConnectionEvidenceWorker({ ...f, wait });
    await expect(worker.start(status.runId)).rejects.toThrow("no longer the approved demo");
    expect(f.provider.expectedSet).toHaveBeenCalledOnce();
    expect(f.store.create).not.toHaveBeenCalled();
    await worker.close();
  });

  it("does not switch to a changed contract for the same run during retry", async () => {
    const f = fixture();
    f.provider.expectedSet.mockRejectedValueOnce(
      new MiningQueryError("timeout", "Query timed out"),
    );
    const wait = vi.fn(async () => {
      f.approvedStatus.mockResolvedValue({
        ...status,
        run: { ...status.run!, seed: 2 },
      } as MiningRunStatus);
    });
    const worker = new MiningConnectionEvidenceWorker({ ...f, wait });
    await expect(worker.start(status.runId)).rejects.toThrow("no longer the approved demo");
    expect(f.provider.expectedSet).toHaveBeenCalledOnce();
    expect(f.store.create).not.toHaveBeenCalled();
    await worker.close();
  });

  it("cancels a retry delay when the service closes", async () => {
    const f = fixture();
    f.provider.expectedSet.mockRejectedValueOnce(
      new MiningQueryError("timeout", "Query timed out"),
    );
    let waiting!: () => void;
    const ready = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const wait = vi.fn(
      (_ms: number, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          waiting();
        }),
    );
    const worker = new MiningConnectionEvidenceWorker({ ...f, wait });
    const work = worker.start(status.runId);
    const rejected = expect(work).rejects.toMatchObject({ code: "cancelled" });
    await ready;
    await worker.close();
    await rejected;
    expect(f.store.create).not.toHaveBeenCalled();
  });

  it("reports an overdue missing snapshot as unknown rather than waiting indefinitely", async () => {
    const f = fixture();
    const signal = AbortSignal.timeout(30_000);
    expect(
      await readConnectionEvidenceSnapshot(
        status,
        f.store,
        f.provider,
        f.approvedStatus,
        signal,
        f.now,
      ),
    ).toEqual({ status: "pending" });
    expect(
      await readConnectionEvidenceSnapshot(
        status,
        f.store,
        f.provider,
        f.approvedStatus,
        signal,
        () => Date.parse("2026-01-01T12:11:06.000Z"),
      ),
    ).toEqual({ status: "unknown" });
  });

  it("persists only verified evidence and flags later row arrivals", async () => {
    const f = fixture();
    const worker = new MiningConnectionEvidenceWorker(f);
    await worker.start(status.runId);
    const signal = AbortSignal.timeout(30000);
    expect(
      await readConnectionEvidenceSnapshot(
        status,
        f.store,
        f.provider,
        f.approvedStatus,
        signal,
        f.now,
      ),
    ).toMatchObject({
      status: "complete",
      asOf: "2026-01-01T12:04:55.000Z",
      checkedAt: "2026-01-01T12:04:55.000Z",
      provenance: "fabric-connection-reconciliation-v1",
    });
    f.provider.runRowTotals.mockResolvedValueOnce({
      rawRows: 2110,
      validatedRows: 2109,
      rawReceiptTimeMissing: 0,
      validatedReceiptTimeMissing: 0,
    });

    expect(
      await readConnectionEvidenceSnapshot(
        status,
        f.store,
        f.provider,
        f.approvedStatus,
        signal,
        f.now,
      ),
    ).toMatchObject({ status: "changed" });
    await worker.close();
  });

  it("waits until its clock-skew margin falls after the end of the run", async () => {
    const f = fixture();
    let now = Date.parse("2026-01-01T12:03:05.000Z");
    const wait = vi.fn(async () => {
      now += 5_000;
    });
    const worker = new MiningConnectionEvidenceWorker({ ...f, wait, now: () => now });
    await worker.start(status.runId);
    expect(wait).toHaveBeenCalledOnce();
    expect(f.provider.runRowTotals).toHaveBeenCalledWith(
      { runId: status.runId, asOf: "2026-01-01T12:03:05.000Z" },
      expect.any(AbortSignal),
    );
    await worker.close();
  });

  it("rejects a changed run and does not create an incomplete snapshot", async () => {
    const f = fixture();
    f.provider.runRowTotals.mockResolvedValueOnce({
      rawRows: 2110,
      validatedRows: 2109,
      rawReceiptTimeMissing: 0,
      validatedReceiptTimeMissing: 0,
    });
    const wait = vi.fn(async () => {
      throw new Error("stop after incomplete snapshot");
    });
    const worker = new MiningConnectionEvidenceWorker({ ...f, wait });
    await expect(worker.start(status.runId)).rejects.toThrow("stop after incomplete snapshot");
    expect(f.store.create).not.toHaveBeenCalled();
    expect(wait).toHaveBeenCalledOnce();
    await worker.close();
  });

  it("fails closed if a snapshot is malformed or the current run changes", async () => {
    const f = fixture();
    const worker = new MiningConnectionEvidenceWorker(f);
    await worker.start(status.runId);
    f.approvedStatus.mockResolvedValueOnce({ ...status, stopRequested: true });
    await expect(
      readConnectionEvidenceSnapshot(
        status,
        f.store,
        f.provider,
        f.approvedStatus,
        AbortSignal.timeout(30000),
        f.now,
      ),
    ).rejects.toThrow("run changed");
    f.docs.set(`public-demo-connection-evidence/${status.runId}.json`, { version: 1 });
    await expect(
      readConnectionEvidenceSnapshot(
        status,
        f.store,
        f.provider,
        f.approvedStatus,
        AbortSignal.timeout(30000),
        f.now,
      ),
    ).rejects.toThrow("Invalid connection evidence snapshot");
    await worker.close();
  });

  it("joins duplicate starts, rejects concurrent runs and cancels pending work on close", async () => {
    const f = fixture();
    const approvedStatus = vi.fn(
      (signal: AbortSignal) =>
        new Promise<MiningRunStatus>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const worker = new MiningConnectionEvidenceWorker({ ...f, approvedStatus });
    const work = worker.start(status.runId);
    expect(worker.start(status.runId)).toBe(work);
    expect(() => worker.start("22222222-2222-4222-8222-222222222222")).toThrow("already active");
    const rejected = expect(work).rejects.toMatchObject({ code: "cancelled" });
    await worker.close();
    await rejected;
    expect(f.store.create).not.toHaveBeenCalled();
  });
});
