import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MiningRunCoordinator,
  type MiningClock,
  type StartMiningRun,
} from "../src/mining/run-coordinator.js";
import {
  MiningCoordinationError,
  type MiningStore,
  type StoredDocument,
} from "../src/mining/store.js";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const plantPath = "plants/D01.json";
const input: StartMiningRun = { plantId: "D01", requestId: first };
const clock: MiningClock = { now: () => Date.now(), monotonic: () => Date.now() };

class SharedStorage implements MiningStore {
  readonly documents = new Map<string, { value: unknown; etag: string }>();
  private readonly leases = new Map<string, { id: string; until: number }>();
  private revision = 0;
  fault?: { operation: string; path: string; after: boolean };

  private fail(operation: string, path: string, after: boolean): void {
    if (
      this.fault?.operation === operation &&
      this.fault.path === path &&
      this.fault.after === after
    ) {
      this.fault = undefined;
      throw new MiningCoordinationError("uncertain", "Injected lost response.");
    }
  }

  private liveLease(path: string) {
    const lease = this.leases.get(path);
    return lease && lease.until > Date.now() ? lease : undefined;
  }

  async read(path: string): Promise<StoredDocument | undefined> {
    this.fail("read", path, false);
    const document = this.documents.get(path);
    return document
      ? { ...structuredClone(document), leased: Boolean(this.liveLease(path)) }
      : undefined;
  }

  async create(path: string, value: unknown): Promise<boolean> {
    this.fail("create", path, false);
    if (this.documents.has(path)) return false;
    this.documents.set(path, { value: structuredClone(value), etag: String(++this.revision) });
    this.fail("create", path, true);
    return true;
  }

  async write(path: string, value: unknown, etag: string, leaseId?: string): Promise<string> {
    this.fail("write", path, false);
    const lease = this.liveLease(path);
    if (
      this.documents.get(path)?.etag !== etag ||
      (leaseId ? lease?.id !== leaseId : Boolean(lease))
    ) {
      throw new MiningCoordinationError("lease_lost", "ETag or lease fence rejected.");
    }
    const next = String(++this.revision);
    this.documents.set(path, { value: structuredClone(value), etag: next });
    this.fail("write", path, true);
    return next;
  }

  async acquire(path: string, leaseId: string): Promise<boolean> {
    this.fail("acquire", path, false);
    if (this.liveLease(path)) return false;
    this.leases.set(path, { id: leaseId, until: Date.now() + 60_000 });
    this.fail("acquire", path, true);
    return true;
  }

  async renew(path: string, leaseId: string): Promise<void> {
    this.fail("renew", path, false);
    if (this.liveLease(path)?.id !== leaseId) {
      throw new MiningCoordinationError("lease_lost", "Lease renewal rejected.");
    }
    this.leases.set(path, { id: leaseId, until: Date.now() + 60_000 });
    this.fail("renew", path, true);
  }

  async release(path: string, leaseId: string): Promise<void> {
    this.fail("release", path, false);
    if (this.liveLease(path)?.id !== leaseId) {
      throw new MiningCoordinationError("lease_lost", "Lease release rejected.");
    }
    this.leases.delete(path);
    this.fail("release", path, true);
  }

  revoke(): void {
    this.leases.clear();
  }
}

async function owner(coordinator: MiningRunCoordinator, options: StartMiningRun = input) {
  const result = await coordinator.start(options);
  expect(result.kind).toBe("started");
  if (result.kind !== "started") throw new Error("Expected fresh owner.");
  return result.owner;
}

describe("mining durable run coordination", () => {
  let storage: SharedStorage;
  let replicaA: MiningRunCoordinator;
  let replicaB: MiningRunCoordinator;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    storage = new SharedStorage();
    replicaA = new MiningRunCoordinator(storage, clock);
    replicaB = new MiningRunCoordinator(storage, clock);
  });
  afterEach(() => vi.useRealTimers());

  it("admits exactly one of two independent replicas racing for D01", async () => {
    const results = await Promise.allSettled([
      replicaA.start(input),
      replicaB.start({ ...input, requestId: second }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((result) => result.status === "rejected");
    expect(failed?.status === "rejected" && failed.reason).toMatchObject({ code: "conflict" });
    const statuses = await Promise.all([replicaA.status(first), replicaB.status(second)]);
    expect(statuses.map((status) => status?.phase).sort()).toEqual(["rejected", "running"]);
  });

  it("races the same idempotency key without returning a second sender capability", async () => {
    const results = await Promise.all([replicaA.start(input), replicaB.start(input)]);
    expect(results.map((result) => result.kind).sort()).toEqual(["observed", "started"]);
    const retry = await replicaB.start(input);
    expect(retry).toMatchObject({
      kind: "observed",
      status: { admission: "accepted", phase: "running" },
    });
    expect(retry).not.toHaveProperty("owner");
    await expect(replicaA.start({ ...input, seed: 2 })).rejects.toMatchObject({ code: "conflict" });
    await expect(replicaA.start({ ...input, scenario: "bearing-b" })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(replicaA.start({ ...input, durationSeconds: 30 })).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("persists stable defaults and validates bounded admission before writing anything", async () => {
    const invalid = [
      { durationSeconds: 0 },
      { durationSeconds: -1 },
      { durationSeconds: 1801 },
      { durationSeconds: NaN },
      { durationSeconds: 30.5 },
      { durationSeconds: 31 },
      { seed: -1 },
      { seed: 2 ** 32 },
      { seed: 1.5 },
      { requestId: "../other" },
    ];
    for (const parameters of invalid) {
      await expect(replicaA.start({ ...input, ...parameters })).rejects.toMatchObject({
        code: "invalid",
      });
    }
    expect(storage.documents.size).toBe(0);
    const result = await replicaA.start(input);
    expect(result).toMatchObject({
      kind: "started",
      run: {
        runId: first,
        plantId: "D01",
        durationSeconds: 1200,
        seed: 1,
        scenario: "normal",
        startedAt: "2026-01-01T00:00:00.000Z",
        stopAt: "2026-01-01T00:20:00.000Z",
      },
    });
  });

  it("persists cross-replica stop acceptance separately from acknowledgement", async () => {
    const active = await owner(replicaA);
    const stop = await replicaB.requestStop(first);
    expect(stop).toMatchObject({
      accepted: true,
      status: { phase: "running", stopRequested: true },
    });
    expect(active.signal.aborted).toBe(false);
    const publish = vi.fn();
    await expect(active.runBatch(publish)).rejects.toMatchObject({ code: "cancelled" });
    expect(publish).not.toHaveBeenCalled();
    expect(active.signal.aborted).toBe(true);
    expect(await replicaB.status(first)).toMatchObject({ phase: "stopped" });
    await active.finish();
    expect(await replicaB.requestStop(first)).toMatchObject({ status: { phase: "stopped" } });
  });

  it("drains at most the single already-authorized batch, then acknowledges stop", async () => {
    const active = await owner(replicaA);
    let settle!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const batch = active.runBatch(async () => {
      entered();
      await new Promise<void>((resolve) => {
        settle = resolve;
      });
    });
    await started;
    await expect(active.runBatch(async () => undefined)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await replicaB.requestStop(first)).toMatchObject({ status: { phase: "running" } });
    await expect(active.finish()).rejects.toMatchObject({ code: "conflict" });
    expect(await replicaB.status(first)).not.toMatchObject({ phase: "stopped" });
    settle();
    await batch;
    await active.finish();
    expect(await replicaB.status(first)).toMatchObject({ phase: "stopped" });
    await expect(active.runBatch(async () => undefined)).rejects.toMatchObject({
      code: "lease_lost",
    });
  });

  it("cancels the owner on lease loss without authorizing another batch", async () => {
    const active = await owner(replicaA);
    storage.revoke();
    const publish = vi.fn();
    await expect(active.runBatch(publish)).rejects.toMatchObject({ code: "lease_lost" });
    expect(active.signal.aborted).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    expect(await replicaB.status(first)).toMatchObject({ phase: "interrupted" });
    await expect(active.finish()).rejects.toMatchObject({ code: "lease_lost" });
  });

  it("never resurrects an expired owner, even though Azure permits expired lease renewal", async () => {
    const active = await owner(replicaA);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(active.signal.aborted).toBe(true);
    await expect(active.heartbeat()).rejects.toMatchObject({ code: "lease_lost" });
    expect(await replicaB.status(first)).toMatchObject({ phase: "interrupted" });
    expect(await replicaB.start(input)).toMatchObject({
      kind: "observed",
      status: { phase: "interrupted" },
    });
    await vi.advanceTimersByTimeAsync(15_001);
    const next = await owner(replicaB, { ...input, requestId: second });
    expect(await replicaA.status(first)).toMatchObject({ phase: "interrupted" });
    await expect(active.runBatch(async () => undefined)).rejects.toMatchObject({
      code: "lease_lost",
    });
    await next.finish();
  });

  it("preserves terminal history after a new explicit run, never claims Fabric ingestion", async () => {
    const active = await owner(replicaA);
    await active.runBatch(async () => "transport accepted");
    await active.finish();
    await owner(replicaB, { ...input, requestId: second });
    expect(await replicaA.status(first)).toMatchObject({ phase: "publisher_complete" });
    expect(await replicaA.start(input)).toMatchObject({
      kind: "observed",
      status: { phase: "publisher_complete" },
    });
  });

  it.each([
    ["create", `requests/${first}.json`],
    ["acquire", plantPath],
    ["write", plantPath],
    ["write", `requests/${first}.json`],
  ])("returns no owner on uncertain %s %s, and retry never takes over", async (operation, path) => {
    storage.fault = { operation, path, after: true };
    await expect(replicaA.start(input)).rejects.toMatchObject({ code: "uncertain" });
    const retry = await replicaB.start(input);
    expect(retry.kind).toBe("observed");
    expect(retry).not.toHaveProperty("owner");
    expect(retry).not.toMatchObject({ status: { phase: "publisher_complete" } });
  });

  it("reports unconfirmed acquisition as unknown, blocks other senders until finite expiry", async () => {
    storage.fault = { operation: "acquire", path: plantPath, after: true };
    await expect(replicaA.start(input)).rejects.toMatchObject({ code: "uncertain" });
    expect(await replicaB.status(first)).toMatchObject({
      admission: "pending",
      phase: "admission_unknown",
    });
    await expect(replicaB.start({ ...input, requestId: second })).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("does not claim stop accepted when the response is uncertain; reconciles by the same run ID", async () => {
    const active = await owner(replicaA);
    storage.fault = { operation: "create", path: `stops/${first}.json`, after: true };
    await expect(replicaB.requestStop(first)).rejects.toMatchObject({ code: "uncertain" });
    expect(await replicaA.status(first)).toMatchObject({ phase: "running", stopRequested: true });
    expect(await replicaB.requestStop(first)).toMatchObject({ accepted: true });
    await active.finish();
    expect(await replicaA.status(first)).toMatchObject({ phase: "stopped" });
  });

  it.each(["renew", "write"])("fails closed on an uncertain owner %s", async (operation) => {
    const active = await owner(replicaA);
    storage.fault = { operation, path: plantPath, after: true };
    const publish = vi.fn();
    await expect(active.runBatch(publish)).rejects.toMatchObject({ code: "uncertain" });
    expect(active.signal.aborted).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    await expect(active.runBatch(publish)).rejects.toMatchObject({ code: "lease_lost" });
  });

  it("fails closed when the stop-intent read is unavailable", async () => {
    const active = await owner(replicaA);
    storage.fault = { operation: "read", path: `stops/${first}.json`, after: false };
    await expect(active.runBatch(vi.fn())).rejects.toMatchObject({ code: "uncertain" });
    expect(active.signal.aborted).toBe(true);
  });

  it("records publisher failures as failed, not publisher complete", async () => {
    const active = await owner(replicaA);
    await expect(
      active.runBatch(async () => {
        throw new Error("publisher failed");
      }),
    ).rejects.toThrow("publisher failed");
    expect(active.signal.aborted).toBe(true);
    await active.finish();
    expect(await replicaB.status(first)).toMatchObject({ phase: "failed" });
  });

  it("does not label a publisher failure at the duration boundary as completed", async () => {
    const active = await owner(replicaA, { ...input, durationSeconds: 30 });
    await expect(
      active.runBatch(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
        throw new Error("transport uncertain at deadline");
      }),
    ).rejects.toThrow("transport uncertain at deadline");
    await active.finish("failed");
    expect(await replicaB.status(first)).toMatchObject({ phase: "failed" });
  });

  it("hard-stops an actively renewed 30-minute run and denies any later sends", async () => {
    const active = await owner(replicaA, { ...input, durationSeconds: 1800 });
    for (let seconds = 0; seconds < 1770; seconds += 30) {
      await vi.advanceTimersByTimeAsync(30_000);
      await active.heartbeat();
    }
    expect(active.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(active.signal.aborted).toBe(true);
    const publish = vi.fn();
    await expect(active.runBatch(publish)).rejects.toMatchObject({ code: "cancelled" });
    expect(publish).not.toHaveBeenCalled();
    expect(await replicaB.status(first)).toMatchObject({ phase: "publisher_complete" });
  });

  it("aborts a batch at the duration boundary, but does not acknowledge until it drains", async () => {
    const active = await owner(replicaA, { ...input, durationSeconds: 30 });
    let settle!: () => void;
    let entered!: () => void;
    const enteredBatch = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const batch = active.runBatch(async (signal) => {
      entered();
      await new Promise<void>((resolve) => {
        settle = resolve;
      });
      expect(signal.aborted).toBe(true);
    });
    await enteredBatch;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(active.signal.aborted).toBe(true);
    expect(await replicaB.status(first)).toMatchObject({ phase: "interrupted" });
    settle();
    await batch;
    await active.finish();
    expect(await replicaB.status(first)).toMatchObject({ phase: "publisher_complete" });
  });

  it("reports terminal release uncertainty without enabling any new send", async () => {
    const active = await owner(replicaA);
    storage.fault = { operation: "release", path: plantPath, after: true };
    await expect(active.finish()).rejects.toMatchObject({ code: "uncertain" });
    expect(active.signal.aborted).toBe(true);
    expect(await replicaB.status(first)).toMatchObject({ phase: "publisher_complete" });
  });

  it("rejects malformed durable state rather than inventing healthy defaults", async () => {
    await owner(replicaA);
    storage.documents.get(plantPath)!.value = { version: 1, run: { runId: first } };
    await expect(replicaB.status(first)).rejects.toMatchObject({ code: "invalid" });
  });

  it("leaves no scheduled work merely by constructing an inactive coordinator", () => {
    expect(vi.getTimerCount()).toBe(0);
  });
});
