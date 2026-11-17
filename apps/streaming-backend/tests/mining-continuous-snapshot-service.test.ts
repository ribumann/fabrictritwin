import { describe, expect, it, vi } from "vitest";
import { createContinuousSnapshotService } from "../src/mining-incidents/continuous-snapshot-service.js";
import { createD01RunContract } from "../src/mining-incidents/catalog.js";
import type { ContinuousIncidentSnapshot } from "../src/mining-incidents/continuous-replay.js";

const start = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (milliseconds: number) => new Date(start + milliseconds).toISOString();
const owner = {
  runId: "owner",
  startedAt: iso(0),
  authorityUntil: iso(60 * 60_000),
  phase: "running" as const,
  lifetime: { kind: "continuous" as const, generation: "generation" },
  contract: createD01RunContract(),
};

function snapshot(asOf: string, capturedAt: number): ContinuousIncidentSnapshot {
  return {
    assessmentKind: "rolling-event-time-advisory",
    runId: owner.runId,
    asOf,
    sourceObservedAt: iso(capturedAt),
    windowStart: owner.startedAt,
    advisories: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("continuous incident snapshot service", () => {
  it("coalesces reads but rechecks ownership even on cache hits", async () => {
    const time = 11 * 60_000 + 5_000;
    const pending = deferred<ContinuousIncidentSnapshot>();
    const load = vi.fn(() => pending.promise);
    const isCurrentOwner = vi.fn().mockResolvedValue(true);
    const service = createContinuousSnapshotService({
      load,
      isCurrentOwner,
      now: () => start + time,
    });
    const first = service(owner, new AbortController().signal);
    const second = service(owner, new AbortController().signal);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    pending.resolve(snapshot(iso(10 * 60_000), time));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    isCurrentOwner.mockResolvedValueOnce(false);
    await expect(service(owner, new AbortController().signal)).rejects.toThrow(/owner changed/);
    expect(load).toHaveBeenCalledTimes(1);
    expect(isCurrentOwner).toHaveBeenCalledTimes(3);
  });

  it("cancels the shared source only after the last waiting caller cancels", async () => {
    const time = 11 * 60_000 + 5_000;
    const pending = deferred<ContinuousIncidentSnapshot>();
    let sourceSignal: AbortSignal | undefined;
    const load = vi.fn((_owner, _asOf, signal: AbortSignal) => {
      sourceSignal = signal;
      return pending.promise;
    });
    const service = createContinuousSnapshotService({
      load,
      isCurrentOwner: async () => true,
      now: () => start + time,
    });
    const first = new AbortController();
    const second = new AbortController();
    const a = service(owner, first.signal);
    const b = service(owner, second.signal);
    await Promise.resolve();
    first.abort();
    await expect(a).rejects.toMatchObject({ code: "cancelled" });
    expect(sourceSignal?.aborted).toBe(false);
    second.abort();
    await expect(b).rejects.toMatchObject({ code: "cancelled" });
    expect(sourceSignal?.aborted).toBe(true);
    pending.reject(new Error("source cancelled"));
  });

  it("rejects data that becomes stale while loading", async () => {
    let time = 11 * 60_000 + 5_000;
    const pending = deferred<ContinuousIncidentSnapshot>();
    const service = createContinuousSnapshotService({
      load: () => pending.promise,
      isCurrentOwner: async () => true,
      now: () => start + time,
    });
    const result = service(owner, new AbortController().signal);
    await Promise.resolve();
    time += 180_000;
    pending.resolve(snapshot(iso(10 * 60_000), 11 * 60_000 + 5_000));
    await expect(result).rejects.toThrow(/stale or invalid/);
  });

  it("does not cache failed reads and bounds concurrent work across owners", async () => {
    const time = 11 * 60_000 + 5_000;
    const pending = deferred<ContinuousIncidentSnapshot>();
    const load = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(snapshot(iso(10 * 60_000), time));
    const service = createContinuousSnapshotService({
      load,
      isCurrentOwner: async () => true,
      now: () => start + time,
    });
    const first = service(owner, new AbortController().signal);
    await expect(
      service({ ...owner, runId: "new-owner" }, new AbortController().signal),
    ).rejects.toThrow(/being refreshed/);
    pending.reject(new Error("source unavailable"));
    await expect(first).rejects.toThrow(/source unavailable/);
    await expect(service(owner, new AbortController().signal)).resolves.toMatchObject({
      runId: owner.runId,
    });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
