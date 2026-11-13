import { describe, expect, it } from "vitest";
import { createD01IncidentRun } from "../src/mining-incidents/catalog.js";
import {
  MiningIncidentRuntime,
  readMiningIncidentJournal,
  type MiningIncidentStore,
} from "../src/mining-incidents/runtime.js";
import type { StoredDocument } from "../src/mining/store.js";
import { mapCurrentIncidentJournal } from "../src/mining/read/incident-dto.js";

class Store implements MiningIncidentStore {
  readonly documents = new Map<string, StoredDocument>();
  private readonly leases = new Map<string, string>();
  writes = 0;
  private revision = 0;

  async read(path: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return structuredClone(this.documents.get(path));
  }
  async create(path: string, value: unknown) {
    if (this.documents.has(path)) return false;
    this.documents.set(path, { value: structuredClone(value), etag: `${++this.revision}`, leased: false });
    return true;
  }
  async write(path: string, value: unknown, etag: string, leaseId?: string) {
    if (!leaseId || this.leases.get(path) !== leaseId || this.documents.get(path)?.etag !== etag)
      throw new Error("Invalid lease or ETag.");
    this.writes++;
    const next = `${++this.revision}`;
    this.documents.set(path, { value: structuredClone(value), etag: next, leased: true });
    return next;
  }
  async acquire(path: string, leaseId: string) {
    if (this.leases.has(path)) return false;
    this.leases.set(path, leaseId);
    return true;
  }
  async renew(path: string, leaseId: string) {
    if (this.leases.get(path) !== leaseId) throw new Error("Invalid lease.");
  }
  async release(path: string, leaseId: string) {
    if (this.leases.get(path) !== leaseId) throw new Error("Invalid lease.");
    this.leases.delete(path);
  }
}

describe("current incident journal mapping", () => {
  it("maps a real catalog-bound persisted assessment without writing during read", async () => {
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    const iso = (minute: number) => new Date(start + minute * 60_000).toISOString();
    const run = {
      runId: "123e4567-e89b-42d3-a456-426614174000",
      startedAt: iso(0),
      stopAt: iso(10),
    };
    const binding = createD01IncidentRun(run);
    const store = new Store();
    const runtime = await MiningIncidentRuntime.open(binding, "fresh", {
      store,
      authority: { authorize: async () => {}, checkRun: async () => {} },
      now: () => start + 10 * 60_000,
      source: {
        read: async ({ asOf }) => {
          const minute = (Date.parse(asOf) - start) / 60_000;
          return {
            receivedAt: asOf,
            observations: [
              {
                kind: "state" as const, runId: run.runId, eventId: `state:${minute}`,
                timestamp: asOf, scopeId: "shared" as const, state: "running" as const,
                scheduledRunning: true, sequence: minute,
              },
              {
                kind: "reading" as const, runId: run.runId, eventId: `water:${minute}`,
                timestamp: asOf, tagId: "D01.shared.water.level", value: 15,
                unit: "%", quality: "good" as const, intervalSeconds: 60 as const,
                ingestionTime: asOf,
              },
            ],
          };
        },
      },
    });
    for (let minute = 0; minute <= 5; minute++) await runtime.processMinute(iso(minute));
    const current = runtime.snapshot().assessments.find((item) => item.incident.ruleId === "shared-water")!;
    await runtime.acknowledge(current.incident.incidentId, iso(6));
    await runtime.close();
    const writes = store.writes;
    const journal = await readMiningIncidentJournal(store, binding);
    expect(journal).toBeDefined();
    if (!journal) throw new Error("Expected persisted journal.");
    const mapped = mapCurrentIncidentJournal({ run, journal });
    const incident = mapped.incidents.find((item) => item.ruleId === "shared-water");
    expect(incident).toMatchObject({
      moduleId: "D01.shared.water", metric: "water-energy",
      acknowledgedAt: iso(6), holdWindowStart: iso(2), holdWindowEnd: iso(5),
    });
    expect(mapped.asOf).toBe(iso(5));
    expect(incident?.evidence.length).toBeGreaterThan(0);
    expect(incident?.evidence.every((item) => item.ingestionTime === null)).toBe(true);
    expect(store.writes).toBe(writes);
    expect(() => mapCurrentIncidentJournal({
      run, journal: { ...journal, binding: "f".repeat(64) },
    })).toThrow();
    expect(() => mapCurrentIncidentJournal({
      run, journal: { ...journal, asOf: null },
    })).toThrow();
  });
});
