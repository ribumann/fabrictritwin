import { describe, expect, it, vi } from "vitest";
import {
  MiningIncidentRuntime,
  readMiningIncidentJournal,
  type MiningIncidentAuthority,
  type MiningIncidentDependencies,
  type MiningIncidentRun,
  type MiningIncidentSource,
  type MiningIncidentStore,
} from "../src/mining-incidents/runtime.js";
import {
  MiningIncidentEvaluator,
  type MiningReadingObservation,
  type MiningStateObservation,
} from "../src/mining-incidents/evaluator.js";
import { MiningCoordinationError, type StoredDocument } from "../src/mining/store.js";

const START = Date.parse("2026-11-12T12:00:00.000Z");
const iso = (minute: number) => new Date(START + minute * 60_000).toISOString();
const run: MiningIncidentRun = {
  runId: "approved-run",
  startedAt: iso(0),
  endsAt: iso(10),
  tags: [
    {
      tagId: "D01.shared.water.level",
      moduleId: "D01.shared.water",
      scopeId: "shared",
      unit: "%",
      intervalSeconds: 60,
    },
  ],
};

class Store implements MiningIncidentStore {
  readonly documents = new Map<string, StoredDocument>();
  readonly leases = new Map<string, string>();
  writes = 0;
  reads = 0;
  beforeWrite?: () => Promise<void>;
  beforeRead?: (path: string, signal?: AbortSignal) => Promise<void>;
  unknownWrite = false;
  revision = 0;
  async read(path: string, signal?: AbortSignal) {
    this.reads++;
    await this.beforeRead?.(path, signal);
    signal?.throwIfAborted();
    return structuredClone(this.documents.get(path));
  }
  async create(path: string, value: unknown) {
    if (Buffer.byteLength(JSON.stringify(value)) > 16_384) throw new Error("Over 16 KiB.");
    if (this.documents.has(path)) return false;
    this.documents.set(path, {
      value: structuredClone(value),
      etag: `${++this.revision}`,
      leased: false,
    });
    return true;
  }
  async write(path: string, value: unknown, etag: string, leaseId?: string) {
    await this.beforeWrite?.();
    if (!leaseId || this.leases.get(path) !== leaseId || this.documents.get(path)?.etag !== etag)
      throw new MiningCoordinationError("lease_lost", "Fence rejected.");
    this.writes++;
    const next = `${++this.revision}`;
    this.documents.set(path, { value: structuredClone(value), etag: next, leased: true });
    if (this.unknownWrite) throw new MiningCoordinationError("uncertain", "Lost write response.");
    return next;
  }
  async acquire(path: string, leaseId: string) {
    if (this.leases.has(path)) return false;
    this.leases.set(path, leaseId);
    return true;
  }
  async renew(path: string, leaseId: string) {
    if (this.leases.get(path) !== leaseId)
      throw new MiningCoordinationError("lease_lost", "Lease lost.");
  }
  async release(path: string, leaseId: string) {
    if (this.leases.get(path) !== leaseId)
      throw new MiningCoordinationError("lease_lost", "Lease lost during release.");
    this.leases.delete(path);
  }
  head() {
    const path = [...this.documents.keys()].find((key) => key.endsWith("/head.json"))!;
    return this.documents.get(path)!;
  }
}

function observations(minute: number, quality: "good" | "bad" = "good") {
  const rows: Array<MiningReadingObservation | MiningStateObservation> = [
    {
      kind: "state",
      runId: run.runId,
      eventId: `state:${minute}`,
      timestamp: iso(minute),
      scopeId: "shared",
      state: "running",
      scheduledRunning: true,
      sequence: minute,
    },
  ];
  if (minute > 0)
    rows.push({
      kind: "reading",
      runId: run.runId,
      eventId: `water:${minute}`,
      timestamp: iso(minute),
      tagId: run.tags[0]!.tagId,
      value: minute < 6 ? 15 : 50,
      unit: "%",
      quality,
      intervalSeconds: 60,
    });
  return rows;
}

function fixture() {
  const store = new Store();
  const source: MiningIncidentSource = {
    read: vi.fn(async ({ asOf }) => ({
      observations: observations((Date.parse(asOf) - START) / 60_000),
      receivedAt: asOf,
    })),
  };
  const authority: MiningIncidentAuthority = {
    authorize: vi.fn(async () => {}),
    checkRun: vi.fn(async () => {}),
  };
  const dependencies: MiningIncidentDependencies = {
    store,
    source,
    authority,
    now: () => START + 10 * 60_000,
  };
  return { store, source, authority, dependencies };
}

describe("durable fenced mining incident processing", () => {
  it("replays restart holds, active verification, acknowledgement and next transitions identically", async () => {
    const { dependencies, store } = fixture();
    const direct = new MiningIncidentEvaluator(run.runId, run.startedAt, run.tags);
    let runtime = await MiningIncidentRuntime.open(run, "fresh", dependencies);
    const transitions = [];
    for (let minute = 0; minute <= 10; minute++) {
      for (const observation of observations(minute)) direct.observe(observation, iso(minute));
      transitions.push(...direct.evaluate(iso(minute)));
      await runtime.processMinute(iso(minute));
      if (minute === 4) {
        const incident = direct.active().find((row) => row.ruleId === "shared-water")!;
        direct.acknowledge(incident.incidentId, iso(minute));
        await runtime.acknowledge(incident.incidentId, iso(minute));
      }
      expect(runtime.snapshot().incidents).toEqual(direct.active());
      await runtime.close();
      runtime = await MiningIncidentRuntime.open(run, "recover", dependencies);
      expect(runtime.snapshot().incidents).toEqual(direct.active());
      expect(runtime.outbox()).toEqual(transitions);
    }
    await runtime.close();
    const persisted = await readMiningIncidentJournal(store, run);
    expect(persisted?.notifications).toEqual(transitions);
    expect(store.leases.size).toBe(0);
    expect(
      transitions.some(
        (row) => row.transition === "cleared" && row.incident.ruleId === "shared-water",
      ),
    ).toBe(true);
  });

  it("replays bad arrivals as unverified, not healthy after restart", async () => {
    const { dependencies, source } = fixture();
    let runtime = await MiningIncidentRuntime.open(run, "fresh", dependencies);
    for (let minute = 0; minute <= 4; minute++) await runtime.processMinute(iso(minute));
    source.read = async () => ({ observations: observations(5, "bad"), receivedAt: iso(5) });
    await runtime.processMinute(iso(5));
    const before = runtime.snapshot();
    expect(before.incidents.find((row) => row.ruleId === "shared-water")?.verification).toBe(
      "unverified",
    );
    await runtime.close();
    runtime = await MiningIncidentRuntime.open(run, "recover", dependencies);
    expect(runtime.snapshot()).toEqual(before);
    await runtime.close();
  });

  it("deduplicates minutes and ack without re-reading, re-notifying or clearing; no reminder cooldown sends", async () => {
    const { dependencies, store, source } = fixture();
    const runtime = await MiningIncidentRuntime.open(run, "fresh", dependencies);
    for (let minute = 0; minute <= 4; minute++) await runtime.processMinute(iso(minute));
    const raised = runtime.outbox().find((row) => row.incident.ruleId === "shared-water")!;
    await runtime.acknowledge(raised.incident.incidentId, iso(4));
    const writes = store.writes;
    await runtime.processMinute(iso(4));
    await runtime.acknowledge(raised.incident.incidentId, iso(5));
    expect(store.writes).toBe(writes);
    expect(source.read).toHaveBeenCalledTimes(5);
    expect(
      runtime.snapshot().incidents.find((row) => row.incidentId === raised.incident.incidentId)
        ?.acknowledgedAt,
    ).toBe(iso(4));
    expect(runtime.outbox().filter((row) => row.incident.ruleId === "shared-water")).toEqual([
      raised,
    ]);
    expect(runtime.outbox(raised.eventId).some((row) => row.eventId === raised.eventId)).toBe(
      false,
    );
    await runtime.close();
  });

  it("requires explicit authorization and never adopts another replica's active lease", async () => {
    const { dependencies, store, authority } = fixture();
    const runtime = await MiningIncidentRuntime.open(run, "fresh", dependencies);
    await expect(MiningIncidentRuntime.open(run, "recover", dependencies)).rejects.toThrow("owns");
    expect(store.writes).toBe(0);
    await runtime.close();
    authority.authorize = async () => {
      throw new Error("Delegated authorization required.");
    };
    await expect(MiningIncidentRuntime.open(run, "recover", dependencies)).rejects.toThrow(
      "Delegated",
    );
    expect(store.leases.size).toBe(0);
    const missing = await readMiningIncidentJournal(store, { ...run, runId: "missing" });
    expect(missing).toBeUndefined();
  });

  it.each(["catalog", "run", "schema", "tail", "bytes", "page"])(
    "rejects conflicting/corrupt %s without resetting persisted state",
    async (corruption) => {
      const { dependencies, store } = fixture();
      const runtime = await MiningIncidentRuntime.open(run, "fresh", dependencies);
      await runtime.processMinute(iso(0));
      await runtime.close();
      let input = structuredClone(run);
      const head = store.head().value as Record<string, unknown>;
      if (corruption === "catalog") input.tags = [{ ...run.tags[0]!, unit: "fraction" }];
      if (corruption === "run") input = { ...input, endsAt: iso(9) };
      if (corruption === "schema") head.schema = 2;
      if (corruption === "tail") head.tail = "0".repeat(64);
      if (corruption === "bytes") head.bytes = Number(head.bytes) + 1;
      if (corruption === "page") {
        const page = [...store.documents.entries()].find(
          ([path]) => !path.endsWith("head.json"),
        )![1];
        (page.value as Record<string, unknown>).commands = [];
      }
      const before = structuredClone(store.documents);
      await expect(MiningIncidentRuntime.open(input, "recover", dependencies)).rejects.toThrow();
      await expect(readMiningIncidentJournal(store, input)).rejects.toThrow();
      expect(store.documents).toEqual(before);
      expect(store.writes).toBe(1);
    },
  );

  it("loses authority during a source read without a head commit or notification", async () => {
    const { dependencies, source, store } = fixture();
    const runtime = await MiningIncidentRuntime.open(run, "fresh", dependencies);
    source.read = async () => {
      store.leases.clear();
      return { observations: observations(0), receivedAt: iso(0) };
    };
    await expect(runtime.processMinute(iso(0))).rejects.toThrow();
    expect(store.writes).toBe(0);
    expect((await readMiningIncidentJournal(store, run))?.asOf).toBeNull();
  });

  it("fences an in-flight head commit on the actual leased blob", async () => {
    const { dependencies, store } = fixture();
    const runtime = await MiningIncidentRuntime.open(run, "fresh", dependencies);
    store.beforeWrite = async () => {
      store.leases.clear();
    };
    await expect(runtime.processMinute(iso(0))).rejects.toThrow();
    expect(store.writes).toBe(0);
    expect((await readMiningIncidentJournal(store, run))?.asOf).toBeNull();
  });

  it("does not return a recovered owner after lease loss while reading its journal", async () => {
    const { dependencies, store } = fixture();
    const runtime = await MiningIncidentRuntime.open(run, "fresh", dependencies);
    await runtime.processMinute(iso(0));
    await runtime.close();
    store.beforeRead = async (path) => {
      if (!path.endsWith("head.json")) store.leases.clear();
    };
    await expect(MiningIncidentRuntime.open(run, "recover", dependencies)).rejects.toThrow();
    expect(store.writes).toBe(1);
  });

  it("cancels accepted-stop reads and discards late callbacks", async () => {
    const { dependencies, source, store } = fixture();
    const runtime = await MiningIncidentRuntime.open(run, "fresh", dependencies);
    let finish!: () => void;
    let entered!: () => void;
    const enteredRead = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let signal: AbortSignal | undefined;
    source.read = async (input) => {
      signal = input.signal;
      entered();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { observations: observations(0), receivedAt: iso(0) };
    };
    const processing = runtime.processMinute(iso(0));
    await enteredRead;
    await runtime.close();
    expect(signal?.aborted).toBe(true);
    finish();
    await expect(processing).rejects.toThrow();
    expect(store.writes).toBe(0);
    expect((await readMiningIncidentJournal(store, run))?.asOf).toBeNull();
  });

  it("prevents late writes after close during commit", async () => {
    const { dependencies, store } = fixture();
    const runtime = await MiningIncidentRuntime.open(run, "fresh", dependencies);
    store.beforeWrite = async () => {
      await runtime.close();
    };
    await expect(runtime.processMinute(iso(0))).rejects.toThrow();
    expect(store.writes).toBe(0);
  });

  it("reports unknown commit, never retries, and reconciles only on explicit recovery", async () => {
    const { dependencies, store, source } = fixture();
    const runtime = await MiningIncidentRuntime.open(run, "fresh", dependencies);
    store.unknownWrite = true;
    await expect(runtime.processMinute(iso(0))).rejects.toThrow("unconfirmed");
    expect(store.writes).toBe(1);
    await expect(runtime.processMinute(iso(0))).rejects.toThrow();
    store.unknownWrite = false;
    const recovered = await MiningIncidentRuntime.open(run, "recover", dependencies);
    await recovered.processMinute(iso(0));
    expect(store.writes).toBe(1);
    expect(source.read).toHaveBeenCalledTimes(1);
    expect(recovered.snapshot().asOf).toBe(iso(0));
    await recovered.close();
  });

  it("propagates read-only cancellation without requesting authority or another page", async () => {
    const { dependencies, store, authority } = fixture();
    const runtime = await MiningIncidentRuntime.open(run, "fresh", dependencies);
    await runtime.processMinute(iso(0));
    await runtime.close();
    const cancelled = new AbortController();
    const initialReads = store.reads;
    store.beforeRead = async (_path, signal) => {
      expect(signal).toBe(cancelled.signal);
      cancelled.abort(new Error("Disconnected."));
    };
    await expect(
      readMiningIncidentJournal(store, run, { signal: cancelled.signal }),
    ).rejects.toThrow("Disconnected");
    expect(store.reads).toBe(initialReads + 1);
    expect(authority.authorize).toHaveBeenCalledTimes(1);
  });

  it("bounds and renews minute-relative scheduling and releases at the real end", async () => {
    const { dependencies, store } = fixture();
    let now = START;
    let waits = 0;
    dependencies.now = () => now;
    dependencies.wait = async (milliseconds, signal) => {
      signal.throwIfAborted();
      expect(milliseconds).toBeLessThanOrEqual(15_000);
      now += milliseconds;
      waits++;
    };
    const runtime = await MiningIncidentRuntime.open(run, "fresh", dependencies);
    await runtime.runScheduled();
    expect(now).toBe(START + 10 * 60_000);
    expect(waits).toBe(40);
    expect(store.leases.size).toBe(0);
    expect((await readMiningIncidentJournal(store, run))?.asOf).toBe(run.endsAt);
  });

  it("bounds activation lifetime with monotonic time even when wall time stalls", async () => {
    const { dependencies, store } = fixture();
    let tick = 0;
    dependencies.now = () => START;
    dependencies.monotonic = () => tick;
    dependencies.wait = async () => {
      tick += 31 * 60_000;
    };
    const runtime = await MiningIncidentRuntime.open(run, "fresh", dependencies);
    await expect(runtime.runScheduled()).rejects.toThrow("31-minute lifetime");
    expect(store.writes).toBe(1);
    expect(store.leases.size).toBe(0);
  });

  it("splits a large minute across <=16KiB pages with a single fenced head commit", async () => {
    const { dependencies, source, store } = fixture();
    source.read = async () => ({
      observations: Array.from({ length: 150 }, (_, sequence): MiningStateObservation => ({
        kind: "state",
        runId: run.runId,
        eventId: `${sequence}:${"x".repeat(200)}`,
        timestamp: iso(0),
        scopeId: "shared",
        state: "running",
        scheduledRunning: true,
        sequence,
      })),
      receivedAt: iso(0),
    });
    const runtime = await MiningIncidentRuntime.open(run, "fresh", dependencies);
    await runtime.processMinute(iso(0));
    expect(store.documents.size).toBeGreaterThan(3);
    expect(store.writes).toBe(1);
    for (const document of store.documents.values())
      expect(Buffer.byteLength(JSON.stringify(document.value))).toBeLessThanOrEqual(16_384);
    await runtime.close();
    const recovered = await MiningIncidentRuntime.open(run, "recover", dependencies);
    expect(recovered.snapshot().asOf).toBe(iso(0));
    await recovered.close();
  });
});
