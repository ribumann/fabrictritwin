import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  createD01IncidentRun,
  createD01RunContract,
  createD01VersionedIncidentRun,
} from "../src/mining-incidents/catalog.js";
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
import { createD01Simulation } from "@triathlon-twin/simulator/mining";
import {
  MiningDemoIncidentProcessor,
  demoIncidentPath,
} from "../src/mining-incidents/demo-runtime.js";
import { expectedMiningEventIds } from "../src/mining/read/ingestion-dto.js";
import { createMiningDemoProvider } from "../src/mining/read/demo-provider.js";
import type { MiningRunRecord } from "../src/mining/run-coordinator.js";
import type { createBoundedMiningQuery } from "../src/mining/read/bounded-query.js";

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

function demoFixture() {
  const contract = createD01RunContract();
  const record: MiningRunRecord = {
    plantId: "D01",
    runId: "11111111-1111-4111-8111-111111111111",
    durationSeconds: 300,
    scenario: "normal",
    seed: 1,
    startedAt: iso(0),
    stopAt: iso(5),
    authorityUntil: new Date(START + 305_000).toISOString(),
    phase: "publisher_complete",
    contract,
  };
  const simulation = createD01Simulation(
    { ...record, startedAt: new Date(START) },
    () => START + 300_000,
  );
  const rows: Record<string, unknown>[] = [];
  for (let seconds = 5; seconds <= 300; seconds += 5) {
    const { batch } = simulation.step(new Date(START + seconds * 1000));
    if (!batch) continue;
    for (const event of batch.events) {
      rows.push({
        ...event,
        source:
          event.entityType === "PlantTelemetry"
            ? "mining_ValidatedTelemetry"
            : "mining_ValidatedState",
        received_at: iso(10),
        catalog_version: contract.catalogVersion,
        profile_version: contract.profileVersion,
        source_contract_version: "d01-validated-source-v1",
      });
    }
    simulation.acknowledgeBatch(batch.batch_id);
  }
  const expected = expectedMiningEventIds(record);
  const empty = { count: 0, hash: createHash("sha256").update("").digest("hex") };
  const state: { complete: boolean; record: MiningRunRecord | undefined } = {
    complete: true,
    record,
  };
  const store = new Store();
  const query: ReturnType<typeof createBoundedMiningQuery> = vi.fn(async (input) => {
    if (input.kind === "source-readiness")
      return [
        {
          status: "READY",
          catalog_version: contract.catalogVersion,
          profile_version: contract.profileVersion,
          contract_version: "d01-validated-source-v1",
        },
      ];
    if (input.kind === "incident-observations") return structuredClone(rows);
    if (input.kind !== "ingestion") throw new Error("Unexpected demo incident query.");
    return [
      "raw_telemetry",
      "raw_state",
      "validated_telemetry",
      "validated_state",
      "quarantine",
    ].map((family) => {
      const ids =
        !state.complete || family === "quarantine"
          ? empty
          : family.endsWith("telemetry")
            ? expected.telemetry
            : expected.state;
      return {
        family,
        source_status: "READY",
        event_count: ids.count,
        copies: ids.count,
        conflicting_ids: 0,
        event_ids_hash: ids.hash,
      };
    });
  });
  const dependencies = {
    store,
    query,
    now: () => START + 600_000,
    approvedRun: vi.fn(async () => state.record),
  };
  const read = () =>
    createMiningDemoProvider(
      { MINING_INGESTION_RECONCILIATION_ENABLED: "true" },
      query,
      dependencies.now,
      store,
    )({ kind: "incidents", run: record, asOf: iso(10) }, new AbortController().signal);
  return { record, store, rows, state, dependencies, read };
}

describe("service-owned event-time demo reconciliation", () => {
  it("does not manufacture an assessment on a read or adopt a foreign run", async () => {
    const { dependencies, record, store, read } = demoFixture();
    await expect(read()).rejects.toThrow("not complete");
    const processor = new MiningDemoIncidentProcessor(dependencies);
    await expect(processor.start("foreign-run")).rejects.toThrow("no longer the authorized");
    expect(store.documents.size).toBe(0);
    await processor.close();
  });
  it("journals the exact completed run separately and serves a pure, provenance-labelled read", async () => {
    const { dependencies, store, record, read } = demoFixture();
    const processor = new MiningDemoIncidentProcessor(dependencies);
    await processor.start(record.runId);
    const paths = [...store.documents.keys()];
    expect(paths.every((path) => path.startsWith("public-demo-reconciliation/"))).toBe(true);
    const journal = await readMiningIncidentJournal(
      { read: (path, signal) => store.read(demoIncidentPath(path), signal) },
      createD01VersionedIncidentRun({ ...record, contract: createD01RunContract() }),
      { includeObservations: true },
    );
    expect(journal).toMatchObject({ asOf: iso(5), sourceObservedAt: iso(10) });
    expect(journal?.observations).toHaveLength(537);
    const writes = store.writes;
    const documents = store.documents.size;
    const leases = store.leases.size;
    const result = await read();
    expect(result).toMatchObject({
      assessmentKind: "reconciled-event-time",
      sourceObservedAt: iso(10),
      refreshedAt: iso(10),
    });
    expect(result).not.toHaveProperty("observations");
    expect([store.writes, store.documents.size, store.leases.size]).toEqual([
      writes,
      documents,
      leases,
    ]);
    await processor.recoverCurrent();
    expect(store.writes).toBe(writes);
    await processor.close();
  });

  it("never writes while ingestion is pending or run approval is revoked", async () => {
    const { dependencies, store, state, record } = demoFixture();
    state.complete = false;
    const processor = new MiningDemoIncidentProcessor({
      ...dependencies,
      wait: async () => {
        expect(store.documents.size).toBe(0);
        state.record = undefined;
      },
    });
    await expect(processor.start(record.runId)).rejects.toThrow("no longer the authorized");
    expect(store.documents.size).toBe(0);
    await processor.close();
  });

  it("rejects a truncated capture despite green ingestion counts, without creating a journal", async () => {
    const { dependencies, store, rows, record } = demoFixture();
    rows.pop();
    const processor = new MiningDemoIncidentProcessor(dependencies);
    await expect(processor.start(record.runId)).rejects.toThrow("does not match the complete run");
    expect(store.documents.size).toBe(0);
    await processor.close();
  });

  it("recovers an unknown head commit without duplicating minutes", async () => {
    const { dependencies, store, record, read } = demoFixture();
    store.unknownWrite = true;
    const processor = new MiningDemoIncidentProcessor(dependencies);
    await expect(processor.start(record.runId)).rejects.toThrow("head commit is unconfirmed");
    store.unknownWrite = false;
    await processor.recoverCurrent();
    expect(await read()).toMatchObject({ asOf: iso(5), assessmentKind: "reconciled-event-time" });
    expect(store.leases.size).toBe(0);
    await processor.close();
  });

  it("rejects changed source payloads on reads and recovery rather than serving stale journal success", async () => {
    const { dependencies, store, record, rows, read } = demoFixture();
    const processor = new MiningDemoIncidentProcessor(dependencies);
    await processor.start(record.runId);
    const writes = store.writes;
    const reading = rows.find((row) => row.source === "mining_ValidatedTelemetry")!;
    reading.value = Number(reading.value) + 1;
    await expect(read()).rejects.toThrow("conflicts with the durable journal");
    await expect(processor.recoverCurrent()).rejects.toThrow("conflicts with the durable journal");
    expect(store.writes).toBe(writes);
    await processor.close();
  });

  it.each(["AbortError", "Error"])(
    "joins cancellation without swallowing an unrelated %s",
    async (name) => {
      const { dependencies, state, store, record } = demoFixture();
      state.complete = false;
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const processor = new MiningDemoIncidentProcessor({
        ...dependencies,
        wait: async (_milliseconds, signal) => {
          entered();
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener(
              "abort",
              () => {
                const failure = new Error("Cancelled timer", { cause: signal.reason });
                failure.name = name;
                reject(failure);
              },
              { once: true },
            ),
          );
        },
      });
      const work = processor.start(record.runId);
      const failure = expect(work).rejects.toThrow("Cancelled timer");
      await waiting;
      if (name === "AbortError") await expect(processor.close()).resolves.toBeUndefined();
      else await expect(processor.close()).rejects.toThrow("Cancelled timer");
      await failure;
      expect(store.documents.size).toBe(0);
    },
  );
});

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
  it("passes committed observations to the source after recovery without replaying them as new", async () => {
    const { dependencies, source } = fixture();
    const initial = await MiningIncidentRuntime.open(run, "fresh", dependencies);
    await initial.processMinute(iso(0));
    await initial.close();
    const recovered = await MiningIncidentRuntime.open(run, "recover", dependencies);
    await recovered.processMinute(iso(1));
    expect(vi.mocked(source.read).mock.calls[1]![0].committed).toEqual(observations(0));
    await recovered.close();
  });
  it("writes and replays a schema-2 journal only with the exact prospective binding", async () => {
    const { dependencies, store } = fixture();
    const input = {
      runId: run.runId,
      startedAt: run.startedAt,
      stopAt: run.endsAt,
      contract: createD01RunContract(),
    };
    const versioned = createD01VersionedIncidentRun(input);
    const legacy = createD01IncidentRun(input);
    const runtime = await MiningIncidentRuntime.open(versioned, "fresh", dependencies);
    await runtime.processMinute(iso(0));
    const expected = createHash("sha256").update(JSON.stringify(versioned)).digest("hex");
    expect(store.head().value).toMatchObject({ schema: 2, binding: expected });
    expect(
      [...store.documents.entries()]
        .filter(([path]) => !path.endsWith("head.json"))
        .every(([, doc]) => (doc.value as { schema: number }).schema === 2),
    ).toBe(true);
    await runtime.close();
    await expect(readMiningIncidentJournal(store, legacy)).rejects.toThrow();
    await expect(MiningIncidentRuntime.open(legacy, "recover", dependencies)).rejects.toThrow();
    await expect(MiningIncidentRuntime.open(versioned, "fresh", dependencies)).rejects.toThrow();
    const recovered = await MiningIncidentRuntime.open(versioned, "recover", dependencies);
    expect(recovered.snapshot().binding).toBe(expected);
    expect(recovered.snapshot().asOf).toBe(iso(0));
    await recovered.close();
    expect((await readMiningIncidentJournal(store, versioned))?.binding).toBe(expected);
  });

  it("keeps schema-1 binding unchanged and rejects versioned recovery or corrupt versions", async () => {
    const { dependencies, store } = fixture();
    const legacy = createD01IncidentRun({
      runId: run.runId,
      startedAt: run.startedAt,
      stopAt: run.endsAt,
    });
    const versioned = createD01VersionedIncidentRun({
      runId: run.runId,
      startedAt: run.startedAt,
      stopAt: run.endsAt,
      contract: createD01RunContract(),
    });
    const runtime = await MiningIncidentRuntime.open(legacy, "fresh", dependencies);
    await runtime.processMinute(iso(0));
    expect(store.head().value).toMatchObject({
      schema: 1,
      binding: createHash("sha256").update(JSON.stringify(legacy)).digest("hex"),
    });
    await runtime.close();
    await expect(MiningIncidentRuntime.open(versioned, "recover", dependencies)).rejects.toThrow();
    await expect(MiningIncidentRuntime.open(versioned, "fresh", dependencies)).rejects.toThrow();
    const recovered = await MiningIncidentRuntime.open(legacy, "recover", dependencies);
    expect(recovered.snapshot().asOf).toBe(iso(0));
    await recovered.close();
    const badVersion = structuredClone(versioned);
    Object.assign(badVersion.contract!, { evaluatorReplayVersion: 2 });
    await expect(MiningIncidentRuntime.open(badVersion, "recover", dependencies)).rejects.toThrow();
    const badTags = { ...versioned, tags: versioned.tags.slice(1) };
    await expect(MiningIncidentRuntime.open(badTags, "recover", dependencies)).rejects.toThrow();
  });

  it("preserves schema-2 uncertainty and requires explicit recovery after a lost fenced response", async () => {
    const { dependencies, store } = fixture();
    const versioned = createD01VersionedIncidentRun({
      runId: run.runId,
      startedAt: run.startedAt,
      stopAt: run.endsAt,
      contract: createD01RunContract(),
    });
    const runtime = await MiningIncidentRuntime.open(versioned, "fresh", dependencies);
    store.unknownWrite = true;
    await expect(runtime.processMinute(iso(0))).rejects.toMatchObject({ code: "uncertain" });
    expect(store.writes).toBe(1);
    store.unknownWrite = false;
    const recovered = await MiningIncidentRuntime.open(versioned, "recover", dependencies);
    expect(recovered.snapshot().asOf).toBe(iso(0));
    await recovered.close();
  });

  it("rejects a validly hashed schema-1 page in a schema-2 chain", async () => {
    const { dependencies, store } = fixture();
    const versioned = createD01VersionedIncidentRun({
      runId: run.runId,
      startedAt: run.startedAt,
      stopAt: run.endsAt,
      contract: createD01RunContract(),
    });
    const runtime = await MiningIncidentRuntime.open(versioned, "fresh", dependencies);
    await runtime.processMinute(iso(0));
    await runtime.close();
    const [pagePath, page] = [...store.documents.entries()].find(
      ([path]) => !path.endsWith("head.json"),
    )!;
    const changed = { ...(page.value as object), schema: 1 };
    const hash = createHash("sha256").update(JSON.stringify(changed)).digest("hex");
    const head = store.head().value as { tail: string; bytes: number };
    head.tail = hash;
    head.bytes = Buffer.byteLength(JSON.stringify(changed));
    store.documents.set(pagePath.replace(/[^/]+$/, `${hash}.json`), { ...page, value: changed });
    await expect(readMiningIncidentJournal(store, versioned)).rejects.toThrow();
    await expect(MiningIncidentRuntime.open(versioned, "recover", dependencies)).rejects.toThrow();
  });

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

  it("replays current no-transition assessments, binding and actual optional event provenance", async () => {
    const { dependencies, source, store } = fixture();
    source.read = async ({ asOf }) => {
      const minute = (Date.parse(asOf) - START) / 60_000;
      return {
        observations: observations(minute).map((row) =>
          row.kind === "reading" && minute === 5 ? { ...row, ingestionTime: asOf } : row,
        ),
        receivedAt: asOf,
      };
    };
    let runtime = await MiningIncidentRuntime.open(run, "fresh", dependencies);
    for (let minute = 0; minute <= 4; minute++) await runtime.processMinute(iso(minute));
    const notificationCount = runtime.outbox().length;
    await runtime.processMinute(iso(5));
    expect(runtime.outbox()).toHaveLength(notificationCount);
    const before = runtime.snapshot();
    const current = before.assessments.find((row) => row.incident.ruleId === "shared-water")!;
    expect(before.binding).toMatch(/^[a-f0-9]{64}$/);
    expect(current.runId).toBe(run.runId);
    expect(current.catalogHash).toMatch(/^[a-f0-9]{64}$/);
    expect(current.assessedAt).toBe(iso(5));
    expect(current.holdWindow).toEqual({ start: iso(2), end: iso(5) });
    expect(current.evidence.find((row) => row.timestamp === iso(5))?.ingestionTime).toBe(iso(5));
    expect(current.evidence.find((row) => row.timestamp === iso(4))?.ingestionTime).toBeNull();
    await runtime.close();
    const persisted = await readMiningIncidentJournal(store, run);
    expect(persisted?.assessments).toEqual(before.assessments);
    expect(persisted?.binding).toBe(before.binding);
    runtime = await MiningIncidentRuntime.open(run, "recover", dependencies);
    expect(runtime.snapshot()).toEqual(before);
    await runtime.close();
  });

  it("returns all current assessments independently of more than 100 historical notifications", async () => {
    const { dependencies, source, store } = fixture();
    const wideRun: MiningIncidentRun = {
      ...run,
      tags: Array.from({ length: 56 }, (_, tag): MiningIncidentRun["tags"][number] => ({
        tagId: `D01.A.observed.tag${tag}`,
        moduleId: "D01.A.observed",
        scopeId: "A",
        unit: "kPa",
        intervalSeconds: 30,
      })),
    };
    source.read = async ({ asOf }) => {
      const minute = (Date.parse(asOf) - START) / 60_000;
      const readings: MiningReadingObservation[] =
        minute === 3
          ? wideRun.tags.flatMap((tag) =>
              [2.5, 3].map((at): MiningReadingObservation => ({
                kind: "reading",
                runId: run.runId,
                eventId: `${tag.tagId}:${at}`,
                timestamp: iso(at),
                tagId: tag.tagId,
                value: 1,
                unit: tag.unit,
                quality: "good",
                intervalSeconds: 30,
              })),
            )
          : [];
      return {
        observations: [...observations(minute).filter((row) => row.kind === "state"), ...readings],
        receivedAt: asOf,
      };
    };
    const runtime = await MiningIncidentRuntime.open(wideRun, "fresh", dependencies);
    for (let minute = 0; minute <= 5; minute++) await runtime.processMinute(iso(minute));
    const first = runtime.outbox();
    expect(first).toHaveLength(100);
    expect(runtime.outbox(first.at(-1)!.eventId).length).toBeGreaterThan(0);
    await runtime.close();
    const persisted = await readMiningIncidentJournal(store, wideRun, { limit: 1 });
    expect(persisted?.notifications).toHaveLength(1);
    const numericStale = persisted!.assessments.filter((row) =>
      row.incident.scopeId.startsWith("D01."),
    );
    expect(numericStale).toHaveLength(56);
    expect(
      numericStale.every(
        (row) =>
          row.assessedAt === iso(5) &&
          row.holdWindow === null &&
          row.freshness?.lastValidAt === iso(3),
      ),
    ).toBe(true);
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
