import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  D01PlantSimulator,
  D01_PLANT_CATALOG,
  toD01PublishProfileRecords,
  type D01TransportBody,
} from "@triathlon-twin/simulator/mining";
import { createD01IncidentRun } from "../src/mining-incidents/catalog.js";
import { MiningIncidentRuntime } from "../src/mining-incidents/runtime.js";
import {
  configuredMiningPublisherRuntime,
  MiningPublisherRuntime,
  type MiningPublisherIncidents,
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
  const blockedIncidents = () => {
    const incidentStore = new Store();
    let settleRead!: () => void;
    let readSignal!: AbortSignal;
    const incidents: MiningPublisherIncidents = {
      dependencies: {
        store: incidentStore,
        source: {
          read: async ({ signal }) => {
            readSignal = signal;
            await new Promise<void>((resolve) => {
              settleRead = resolve;
            });
            signal.throwIfAborted();
            return { observations: [], receivedAt: new Date().toISOString() };
          },
        },
        authority: { authorize: async () => {}, checkRun: async () => {} },
        now: clock.now,
        monotonic: clock.monotonic,
      },
    };
    return {
      incidents,
      incidentStore,
      signal: () => readSignal,
      settleRead: () => settleRead(),
    };
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

  it("aborts incidents on accepted stop and joins their actual read before owner release", async () => {
    const open = vi.spyOn(MiningIncidentRuntime, "open");
    const incidentStore = new Store();
    const releaseIncident = vi.spyOn(incidentStore, "release");
    const releaseOwner = vi.spyOn(store, "release");
    let settleRead!: () => void;
    let readSignal!: AbortSignal;
    const source = vi.fn(async ({ signal }: { signal: AbortSignal; asOf: string }) => {
      readSignal = signal;
      await new Promise<void>((resolve) => {
        settleRead = resolve;
      });
      signal.throwIfAborted();
      return { observations: [], receivedAt: new Date().toISOString() };
    });
    const incidents: MiningPublisherIncidents = {
      dependencies: {
        store: incidentStore,
        source: { read: source },
        authority: { authorize: async () => {}, checkRun: async () => {} },
        now: clock.now,
        monotonic: clock.monotonic,
      },
    };
    const execution = runtime.run({ ...input, durationSeconds: 60 }, undefined, incidents);
    await settle();
    expect(source).toHaveBeenCalledOnce();
    const run = (await runtime.status(requestId))?.run;
    if (!run) throw new Error("Missing admitted run.");
    expect(open).toHaveBeenCalledOnce();
    expect(open.mock.calls[0]?.[0]).toEqual(createD01IncidentRun(run));
    expect(
      await runtime.run({ ...input, durationSeconds: 60 }, undefined, incidents),
    ).toMatchObject({ phase: "running" });
    expect(source).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
    await runtime.requestStop(requestId);
    expect(readSignal.aborted).toBe(true);
    expect(releaseIncident).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(releaseOwner).not.toHaveBeenCalled();
    settleRead();
    expect(await execution).toMatchObject({ phase: "stopped" });
    expect(releaseOwner).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });

  it("aborts incidents before waiting for an already admitted send, then joins both", async () => {
    const fixture = blockedIncidents();
    const releaseOwner = vi.spyOn(store, "release");
    let settleSend!: () => void;
    publish.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settleSend = resolve;
        }),
    );
    const execution = runtime.run({ ...input, durationSeconds: 60 }, undefined, fixture.incidents);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(publish).toHaveBeenCalledOnce();
    await runtime.requestStop(requestId);
    expect(fixture.signal().aborted).toBe(true);
    expect(fixture.incidentStore.lease).toBeUndefined();
    expect(releaseOwner).not.toHaveBeenCalled();
    fixture.settleRead();
    await settle();
    expect(releaseOwner).not.toHaveBeenCalled();
    settleSend();
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await execution).toMatchObject({ phase: "stopped" });
    expect(releaseOwner).toHaveBeenCalledOnce();
  });

  it("reports a synchronous incident release failure after joining its pending work", async () => {
    const fixture = blockedIncidents();
    vi.spyOn(fixture.incidentStore, "release").mockImplementation(() => {
      throw new Error("Incident lease release failed.");
    });
    const releaseOwner = vi.spyOn(store, "release");
    const execution = runtime.run({ ...input, durationSeconds: 60 }, undefined, fixture.incidents);
    const rejected = expect(execution).rejects.toThrow();
    await settle();
    await runtime.requestStop(requestId);
    expect(fixture.signal().aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(releaseOwner).not.toHaveBeenCalled();
    fixture.settleRead();
    await rejected;
    expect(releaseOwner).toHaveBeenCalledOnce();
    expect(await runtime.status(requestId)).toMatchObject({ phase: "failed" });
  });

  it("aborts incident work when stop is persisted even if the status confirmation fails", async () => {
    const fixture = blockedIncidents();
    const execution = runtime.run({ ...input, durationSeconds: 60 }, undefined, fixture.incidents);
    await settle();
    const originalCreate = store.create.bind(store);
    const originalRead = store.read.bind(store);
    let stopPersisted = false;
    vi.spyOn(store, "create").mockImplementation(async (path, value) => {
      const result = await originalCreate(path, value);
      if (path === `stops/${requestId}.json`) stopPersisted = true;
      return result;
    });
    const read = vi.spyOn(store, "read").mockImplementation(async (path) => {
      if (stopPersisted && path === `requests/${requestId}.json`) {
        stopPersisted = false;
        throw new MiningCoordinationError("storage", "Stop status unavailable.");
      }
      return originalRead(path);
    });
    await expect(runtime.requestStop(requestId)).rejects.toThrow("Stop status unavailable.");
    expect(fixture.signal().aborted).toBe(true);
    expect(fixture.incidentStore.lease).toBeUndefined();
    read.mockRestore();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.lease).toBeDefined();
    fixture.settleRead();
    expect(await execution).toMatchObject({ phase: "stopped" });
  });

  it("fails closed and aborts incidents and sending when stop persistence is uncertain", async () => {
    const fixture = blockedIncidents();
    let settleSend!: () => void;
    let sendSignal!: AbortSignal;
    publish.mockImplementation(async (_events, signal) => {
      sendSignal = signal;
      await new Promise<void>((resolve) => {
        settleSend = resolve;
      });
    });
    const acknowledged = vi.spyOn(D01PlantSimulator.prototype, "acknowledgeBatch");
    const execution = runtime.run({ ...input, durationSeconds: 60 }, undefined, fixture.incidents);
    const rejected = expect(execution).rejects.toThrow("Stop write unconfirmed.");
    await vi.advanceTimersByTimeAsync(30_000);
    const originalCreate = store.create.bind(store);
    vi.spyOn(store, "create").mockImplementation(async (path, value) => {
      const created = await originalCreate(path, value);
      if (path === `stops/${requestId}.json`) {
        throw new MiningCoordinationError("uncertain", "Stop write unconfirmed.");
      }
      return created;
    });
    await expect(runtime.requestStop(requestId)).rejects.toMatchObject({ code: "uncertain" });
    expect(fixture.signal().aborted).toBe(true);
    expect(sendSignal.aborted).toBe(true);
    fixture.settleRead();
    settleSend();
    await rejected;
    expect(acknowledged).not.toHaveBeenCalled();
    expect(await runtime.status(requestId)).toMatchObject({ phase: "failed", stopRequested: true });
  });

  it("joins aborted incident work even when publisher lease authority is lost", async () => {
    const fixture = blockedIncidents();
    const execution = runtime.run({ ...input, durationSeconds: 60 }, undefined, fixture.incidents);
    let settled = false;
    const rejected = expect(execution).rejects.toThrow();
    void execution.catch(() => {
      settled = true;
    });
    await settle();
    store.lease = undefined;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fixture.signal().aborted).toBe(true);
    expect(fixture.incidentStore.lease).toBeUndefined();
    expect(settled).toBe(false);
    fixture.settleRead();
    await rejected;
    expect(await runtime.status(requestId)).toMatchObject({ phase: "interrupted" });
  });

  it("aborts an in-flight send on incident failure and awaits its settlement without acknowledging", async () => {
    const fixture = blockedIncidents();
    let failRead!: () => void;
    fixture.incidents.dependencies.source.read = async () => {
      await new Promise<void>((resolve) => {
        failRead = resolve;
      });
      throw new MiningCoordinationError("uncertain", "Incident source outcome unknown.");
    };
    let settleSend!: () => void;
    let sendSignal!: AbortSignal;
    publish.mockImplementation(async (_events, signal) => {
      sendSignal = signal;
      await new Promise<void>((resolve) => {
        settleSend = resolve;
      });
    });
    const acknowledged = vi.spyOn(D01PlantSimulator.prototype, "acknowledgeBatch");
    const execution = runtime.run({ ...input, durationSeconds: 60 }, undefined, fixture.incidents);
    const rejected = expect(execution).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30_000);
    failRead();
    await settle();
    expect(sendSignal.aborted).toBe(true);
    expect(fixture.incidentStore.lease).toBeUndefined();
    expect(close).not.toHaveBeenCalled();
    expect(acknowledged).not.toHaveBeenCalled();
    settleSend();
    await rejected;
    expect(acknowledged).not.toHaveBeenCalled();
    expect(await runtime.status(requestId)).toMatchObject({ phase: "failed" });
  });

  it("waits for interrupted incident activation before acknowledging a stop", async () => {
    const fixture = blockedIncidents();
    let settleAuthorization!: () => void;
    let authorizationSignal!: AbortSignal;
    fixture.incidents.dependencies.authority.authorize = async (_operation, _run, signal) => {
      authorizationSignal = signal;
      await new Promise<void>((resolve) => {
        settleAuthorization = resolve;
      });
      signal.throwIfAborted();
    };
    const releaseOwner = vi.spyOn(store, "release");
    const execution = runtime.run({ ...input, durationSeconds: 60 }, undefined, fixture.incidents);
    await settle();
    await runtime.requestStop(requestId);
    expect(authorizationSignal.aborted).toBe(true);
    expect(releaseOwner).not.toHaveBeenCalled();
    settleAuthorization();
    expect(await execution).toMatchObject({ phase: "stopped" });
    expect(releaseOwner).toHaveBeenCalledOnce();
    expect(factory).not.toHaveBeenCalled();
  });

  it("preserves uncertainty if an incident head commits before stop but its response is lost", async () => {
    const fixture = blockedIncidents();
    fixture.incidents.dependencies.source.read = async ({ asOf }) => ({
      observations: [],
      receivedAt: asOf,
    });
    let finishWrite!: () => void;
    let markWrite!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      markWrite = resolve;
    });
    const originalWrite = fixture.incidentStore.write.bind(fixture.incidentStore);
    const write = vi.spyOn(fixture.incidentStore, "write").mockImplementation(async (...args) => {
      await originalWrite(...args);
      markWrite();
      await new Promise<void>((resolve) => {
        finishWrite = resolve;
      });
      throw new MiningCoordinationError("uncertain", "Incident head response lost.");
    });
    const releaseOwner = vi.spyOn(store, "release");
    const execution = runtime.run({ ...input, durationSeconds: 60 }, undefined, fixture.incidents);
    const rejected = execution.catch((error: unknown) => error);
    await writeStarted;
    expect(write).toHaveBeenCalledOnce();
    await runtime.requestStop(requestId);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(releaseOwner).not.toHaveBeenCalled();
    finishWrite();
    expect(await rejected).toMatchObject({
      code: "uncertain",
      cause: { code: "uncertain", message: "Incident head response lost." },
    });
    expect(releaseOwner).toHaveBeenCalledOnce();
    expect(await runtime.status(requestId)).toMatchObject({ phase: "failed" });
  });

  it("does not turn a late uncertain incident error into a successful stop", async () => {
    const incidentStore = new Store();
    let settleRead!: () => void;
    const incidents: MiningPublisherIncidents = {
      dependencies: {
        store: incidentStore,
        source: {
          read: async () => {
            await new Promise<void>((resolve) => {
              settleRead = resolve;
            });
            throw new MiningCoordinationError("uncertain", "Incident commit is unconfirmed.");
          },
        },
        authority: { authorize: async () => {}, checkRun: async () => {} },
        now: clock.now,
        monotonic: clock.monotonic,
      },
    };
    const execution = runtime.run({ ...input, durationSeconds: 60 }, undefined, incidents);
    const rejected = expect(execution).rejects.toThrow(/unconfirmed/);
    await settle();
    await runtime.requestStop(requestId);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.lease).toBeDefined();
    settleRead();
    await rejected;
    expect(await runtime.status(requestId)).toMatchObject({ phase: "failed" });
  });

  it("rejects incident activation for non-minute runs before admission", async () => {
    const incidents: MiningPublisherIncidents = {
      dependencies: {
        store: new Store(),
        source: { read: async () => ({ observations: [], receivedAt: new Date().toISOString() }) },
        authority: { authorize: async () => {}, checkRun: async () => {} },
      },
    };
    await expect(runtime.run(input, undefined, incidents)).rejects.toMatchObject({
      code: "invalid",
    });
    expect(await runtime.status(requestId)).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it("freezes the full catalog-ordered binding using the versioned profile", () => {
    const startedAt = new Date().toISOString();
    const run = {
      runId: requestId,
      startedAt,
      stopAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const binding = createD01IncidentRun(run);
    const profile = new Map(toD01PublishProfileRecords().map((row) => [row.tag_id, row]));
    const modules = new Map(D01_PLANT_CATALOG.modules.map((module) => [module.id, module]));
    expect(binding).toMatchObject({ runId: requestId, startedAt, endsAt: run.stopAt });
    expect(binding.tags).toEqual(
      D01_PLANT_CATALOG.telemetry_tags.map((tag) => ({
        tagId: tag.id,
        moduleId: tag.module_id,
        scopeId: modules.get(tag.module_id)?.line,
        unit: tag.unit,
        intervalSeconds: profile.get(tag.id)?.interval_seconds,
      })),
    );
    expect(binding.tags.filter((tag) => tag.intervalSeconds === 30)).toHaveLength(45);
    expect(binding.tags.filter((tag) => tag.intervalSeconds === 60)).toHaveLength(11);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.tags)).toBe(true);
    expect(binding.tags.every(Object.isFrozen)).toBe(true);
  });
});
