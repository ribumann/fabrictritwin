import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { D01PlantSimulator, type D01TransportBody } from "@triathlon-twin/simulator/mining";
import {
  configuredMiningPublisherRuntime,
  MiningPublisherRuntime,
  type MiningScheduler,
} from "../src/mining/publisher-runtime.js";
import { MiningRunCoordinator } from "../src/mining/run-coordinator.js";
import {
  MiningCoordinationError,
  type MiningStore,
  type StoredDocument,
} from "../src/mining/store.js";

const requestId = "11111111-1111-4111-8111-111111111111";
const input = { plantId: "D01" as const, requestId, durationSeconds: 65 };
const clock = { now: () => Date.now(), monotonic: () => performance.now() };
const scheduler: MiningScheduler = {
  wait: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, ms);
      signal.addEventListener("abort", abort, { once: true });
    }),
};

class Store implements MiningStore {
  documents = new Map<string, StoredDocument>();
  lease?: string;
  revision = 0;
  async read(path: string) {
    const doc = this.documents.get(path);
    return doc ? { ...structuredClone(doc), leased: Boolean(this.lease) } : undefined;
  }
  async create(path: string, value: unknown) {
    if (this.documents.has(path)) return false;
    this.documents.set(path, {
      value: structuredClone(value),
      etag: String(++this.revision),
      leased: false,
    });
    return true;
  }
  async write(path: string, value: unknown, etag: string, lease?: string) {
    if (this.documents.get(path)?.etag !== etag || (lease && lease !== this.lease)) {
      throw new MiningCoordinationError("lease_lost", "Fence rejected.");
    }
    const next = String(++this.revision);
    this.documents.set(path, {
      value: structuredClone(value),
      etag: next,
      leased: Boolean(this.lease),
    });
    return next;
  }
  async acquire(_path: string, lease: string) {
    if (this.lease) return false;
    this.lease = lease;
    return true;
  }
  async renew(_path: string, lease: string) {
    if (lease !== this.lease) throw new MiningCoordinationError("lease_lost", "Lease revoked.");
  }
  async release(path: string, lease: string) {
    await this.renew(path, lease);
    this.lease = undefined;
  }
}

describe("D01 real-clock publisher", () => {
  let store: Store;
  let coordinator: MiningRunCoordinator;
  let publish: ReturnType<
    typeof vi.fn<(events: readonly D01TransportBody[], signal: AbortSignal) => Promise<void>>
  >;
  let close: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let factory: ReturnType<typeof vi.fn>;
  let runtime: MiningPublisherRuntime;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    store = new Store();
    coordinator = new MiningRunCoordinator(store, clock, { finalFlushMilliseconds: 5_000 });
    publish = vi.fn(async () => {});
    close = vi.fn(async () => {});
    factory = vi.fn(() => ({ publish, close }));
    runtime = new MiningPublisherRuntime(coordinator, factory, clock, scheduler);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  const settle = async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve();
  };

  it("does no work on construction, status or default-off configuration", async () => {
    expect(configuredMiningPublisherRuntime({})).toBeUndefined();
    expect(configuredMiningPublisherRuntime({ MINING_PUBLISHER_ENABLED: "false" })).toBeUndefined();
    expect(() => configuredMiningPublisherRuntime({ MINING_PUBLISHER_ENABLED: "yes" })).toThrow();
    expect(() => configuredMiningPublisherRuntime({ MINING_PUBLISHER_ENABLED: "true" })).toThrow(
      /own/,
    );
    expect(() =>
      configuredMiningPublisherRuntime({
        MINING_PUBLISHER_ENABLED: "true",
        MINING_EVENTSTREAM_EVENTHUB_CONNECTION_STRING: "not-a-credential",
      }),
    ).toThrow();
    expect(await runtime.status(requestId)).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("opt-in waits real 5s steps and 30s sends, then flushes the final partial batch", async () => {
    const acknowledged = vi.spyOn(D01PlantSimulator.prototype, "acknowledgeBatch");
    const sentAt: number[] = [];
    publish.mockImplementation(async (events) => {
      sentAt.push(Date.now());
      expect(events.every((event) => Date.parse(event.timestamp) <= Date.now())).toBe(true);
      expect(
        events.every((event) => ["PlantTelemetry", "PlantStateEvent"].includes(event.entityType)),
      ).toBe(true);
      expect(acknowledged).toHaveBeenCalledTimes(sentAt.length - 1);
    });
    const start = Date.now();
    const execution = runtime.run(input);
    await settle();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(publish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(await execution).toMatchObject({ phase: "publisher_complete" });
    expect(sentAt).toEqual([start + 30_000, start + 60_000, start + 65_000]);
    expect(acknowledged).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledOnce();
  });

  it("never launches from a duplicate admission even while the owner is running", async () => {
    const execution = runtime.run(input);
    await settle();
    expect(await runtime.run(input)).toMatchObject({ phase: "running" });
    expect(factory).toHaveBeenCalledOnce();
    await runtime.requestStop(requestId);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await execution).toMatchObject({ phase: "stopped" });
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not acknowledge or retry uncertain delivery", async () => {
    const acknowledged = vi.spyOn(D01PlantSimulator.prototype, "acknowledgeBatch");
    publish.mockRejectedValue(new Error("delivery uncertain"));
    const execution = runtime.run(input);
    const rejected = expect(execution).rejects.toThrow("delivery uncertain");
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(acknowledged).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledOnce();
    expect(await runtime.status(requestId)).toMatchObject({ phase: "failed" });
  });

  it("refuses a missed scheduler deadline without catch-up sends", async () => {
    const late: MiningScheduler = {
      wait: async (ms) => {
        await new Promise((resolve) => setTimeout(resolve, ms + 1_001));
      },
    };
    runtime = new MiningPublisherRuntime(coordinator, factory, clock, late);
    const rejected = expect(runtime.run(input)).rejects.toThrow(/missed/);
    await vi.advanceTimersByTimeAsync(6_001);
    await rejected;
    expect(publish).not.toHaveBeenCalled();
    expect(await runtime.status(requestId)).toMatchObject({ phase: "failed" });
  });

  it("cannot publish after a revoked lease", async () => {
    const rejected = expect(runtime.run(input)).rejects.toThrow();
    await settle();
    store.lease = undefined;
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(publish).not.toHaveBeenCalled();
    expect(await runtime.status(requestId)).toMatchObject({ phase: "interrupted" });
  });

  it("waits for aborted I/O to settle before close, failure persistence and no acknowledgement", async () => {
    const acknowledged = vi.spyOn(D01PlantSimulator.prototype, "acknowledgeBatch");
    let settleSend!: () => void;
    let networkSignal!: AbortSignal;
    publish.mockImplementation(async (_events, signal) => {
      networkSignal = signal;
      await new Promise<void>((resolve) => {
        settleSend = resolve;
      });
    });
    const rejected = expect(runtime.run(input)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(32_001);
    expect(networkSignal.aborted).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(acknowledged).not.toHaveBeenCalled();
    settleSend();
    await rejected;
    expect(close).toHaveBeenCalledOnce();
    expect(await runtime.status(requestId)).toMatchObject({ phase: "failed" });
  });

  it("drains only an admitted batch during a stop race", async () => {
    let settleSend!: () => void;
    publish.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        settleSend = resolve;
      });
    });
    const execution = runtime.run(input);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await runtime.requestStop(requestId)).toMatchObject({
      accepted: true,
      status: { phase: "running" },
    });
    expect(close).not.toHaveBeenCalled();
    settleSend();
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await execution).toMatchObject({ phase: "stopped" });
    expect(publish).toHaveBeenCalledOnce();
  });

  it("fails an explicit caller abort without claiming stopped or completing the run", async () => {
    const abort = new AbortController();
    const rejected = expect(runtime.run(input, abort.signal)).rejects.toThrow();
    await settle();
    abort.abort(new Error("host shutting down"));
    await rejected;
    expect(publish).not.toHaveBeenCalled();
    expect(await runtime.status(requestId)).toMatchObject({ phase: "failed" });
  });

  it("keeps the default strict deadline and never claims an undelivered final batch completed", async () => {
    coordinator = new MiningRunCoordinator(store, clock);
    runtime = new MiningPublisherRuntime(coordinator, factory, clock, scheduler);
    const acknowledged = vi.spyOn(D01PlantSimulator.prototype, "acknowledgeBatch");
    const rejected = expect(runtime.run({ ...input, durationSeconds: 35 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(35_000);
    await rejected;
    expect(publish).toHaveBeenCalledOnce();
    expect(acknowledged).toHaveBeenCalledOnce();
    expect(await runtime.status(requestId)).toMatchObject({ phase: "failed" });
  });

  it("never extends the full 1800-second publisher lifetime even with opt-in flush", async () => {
    const rejected = expect(runtime.run({ ...input, durationSeconds: 1800 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1_800_000);
    await rejected;
    expect(publish).toHaveBeenCalledTimes(59);
    expect(await runtime.status(requestId)).toMatchObject({ phase: "failed" });
    expect((await runtime.status(requestId))?.run).not.toHaveProperty("finalFlushUntil");
    await vi.advanceTimersByTimeAsync(5_001);
    expect(publish).toHaveBeenCalledTimes(59);
  });

  it("does not acknowledge a failed opted-in final partial batch", async () => {
    const acknowledged = vi.spyOn(D01PlantSimulator.prototype, "acknowledgeBatch");
    publish.mockRejectedValue(new Error("final delivery uncertain"));
    const rejected = expect(runtime.run({ ...input, durationSeconds: 5 })).rejects.toThrow(
      /uncertain/,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(acknowledged).not.toHaveBeenCalled();
    expect(await runtime.status(requestId)).toMatchObject({ phase: "failed" });
  });

  it("honors stop before the final batch deadline without sending it", async () => {
    const execution = runtime.run({ ...input, durationSeconds: 5 });
    await settle();
    await runtime.requestStop(requestId);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await execution).toMatchObject({ phase: "stopped" });
    expect(publish).not.toHaveBeenCalled();
  });

  it("observes a stop racing between final-step heartbeat and final batch admission", async () => {
    const read = store.read.bind(store);
    let stopReads = 0;
    vi.spyOn(store, "read").mockImplementation(async (path) => {
      if (path === `stops/${requestId}.json` && ++stopReads === 2) {
        await store.create(path, { runId: requestId });
      }
      return read(path);
    });
    const execution = runtime.run({ ...input, durationSeconds: 5 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await execution).toMatchObject({ phase: "stopped" });
    expect(publish).not.toHaveBeenCalled();
  });

  it("rejects late successful final I/O without acknowledging it", async () => {
    const acknowledged = vi.spyOn(D01PlantSimulator.prototype, "acknowledgeBatch");
    publish.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_001));
    });
    const rejected = expect(runtime.run({ ...input, durationSeconds: 5 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(7_001);
    await rejected;
    expect(acknowledged).not.toHaveBeenCalled();
    expect(await runtime.status(requestId)).toMatchObject({ phase: "failed" });
  });

  it("does not mistake an undefined transport rejection for success", async () => {
    publish.mockRejectedValue(undefined);
    const rejected = expect(runtime.run({ ...input, durationSeconds: 5 })).rejects.toThrow(
      /failed/,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(await runtime.status(requestId)).toMatchObject({ phase: "failed" });
  });

  it("refuses final-batch admission after lease revocation", async () => {
    const rejected = expect(runtime.run({ ...input, durationSeconds: 5 })).rejects.toThrow();
    await settle();
    store.lease = undefined;
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(publish).not.toHaveBeenCalled();
    expect(await runtime.status(requestId)).toMatchObject({ phase: "interrupted" });
  });

  it("detects a wall-clock jump instead of producing future events or a catch-up burst", async () => {
    const rejected = expect(runtime.run(input)).rejects.toThrow(/missed/);
    await settle();
    vi.setSystemTime(Date.now() - 3_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(publish).not.toHaveBeenCalled();
  });

  it("bounds final-flush admission and rejects nonterminal or duplicate capability use", async () => {
    const admission = await coordinator.start({ ...input, durationSeconds: 5 });
    if (admission.kind !== "started") throw new Error("Missing fresh owner");
    const { owner, run } = admission;
    const send = vi.fn(async () => {});
    await expect(
      owner.runFinalBatch({ runId: run.runId, timestamp: run.stopAt }, send),
    ).rejects.toMatchObject({ code: "invalid" });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(
      owner.runFinalBatch({ runId: run.runId, timestamp: run.startedAt }, send),
    ).rejects.toMatchObject({ code: "invalid" });
    await owner.runFinalBatch({ runId: run.runId, timestamp: run.stopAt }, send);
    await expect(
      owner.runFinalBatch({ runId: run.runId, timestamp: run.stopAt }, send),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(send).toHaveBeenCalledOnce();
    await owner.finish();
  });

  it("does not resurrect a final capability when its absolute drain deadline expires", async () => {
    const admission = await coordinator.start({ ...input, durationSeconds: 5 });
    if (admission.kind !== "started") throw new Error("Missing fresh owner");
    const { owner, run } = admission;
    await vi.advanceTimersByTimeAsync(10_000);
    const send = vi.fn(async () => {});
    await expect(
      owner.runFinalBatch({ runId: run.runId, timestamp: run.stopAt }, send),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(owner.signal.aborted).toBe(true);
    expect(await coordinator.status(requestId)).toMatchObject({ phase: "failed" });
  });

  it("reserves final admission before refresh so concurrent attempts reject invalid without a second send", async () => {
    const admission = await coordinator.start({ ...input, durationSeconds: 5 });
    if (admission.kind !== "started") throw new Error("Missing fresh owner");
    const { owner, run } = admission;
    await vi.advanceTimersByTimeAsync(5_000);
    let release!: () => void;
    const refresh = new Promise<void>((resolve) => {
      release = resolve;
    });
    const renew = store.renew.bind(store);
    vi.spyOn(store, "renew").mockImplementationOnce(async (path, lease) => {
      await refresh;
      await renew(path, lease);
    });
    const send = vi.fn(async () => {});
    const final = { runId: run.runId, timestamp: run.stopAt };
    const first = owner.runFinalBatch(final, send);
    const second = owner.runFinalBatch(final, send);
    release();
    const results = await Promise.allSettled([first, second]);
    expect(results[0]).toMatchObject({ status: "fulfilled" });
    expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "invalid" } });
    expect(send).toHaveBeenCalledOnce();
    await owner.finish();
  });
});
