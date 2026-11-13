import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  D01_CATALOG_VERSION,
  D01_PLANT_CATALOG,
  assertD01AlertTransition,
  assertD01NumericTelemetryEvent,
  assertD01PlantStateEvent,
  createD01AlertTransitionId,
  createD01EventId,
  createD01Simulation,
  getD01TagIntervalSeconds,
  toD01CatalogRecords,
  toD01TransportBody,
  validateD01PlantCatalog,
} from "../src/mining/index.js";
import type {
  D01AlertTransition,
  D01NumericTelemetryEvent,
  D01PlantStateEvent,
  D01Scenario,
  D01SimulationBatch,
  D01TransportBody,
} from "../src/mining/index.js";

const start = new Date("2024-01-01T00:00:00.000Z");
const runId = "d01-test-run";

interface SimulationOutput {
  events: D01TransportBody[];
  alerts: D01AlertTransition[];
  batches: D01SimulationBatch[];
  waterAtEnd: number;
}

function runSimulation(
  scenario: D01Scenario = "normal",
  durationSeconds = 1200,
  seed = 1234,
): SimulationOutput {
  const simulator = createD01Simulation({
    runId,
    seed,
    scenario,
    startedAt: start,
    durationSeconds,
  });
  const events: D01TransportBody[] = [];
  const alerts: D01AlertTransition[] = [];
  const batches: D01SimulationBatch[] = [];

  while (simulator.elapsedSecondsSoFar < durationSeconds) {
    const at = new Date(start.valueOf() + (simulator.elapsedSecondsSoFar + 5) * 1000);
    const result = simulator.step(at);
    alerts.push(...result.alert_transitions);
    if (result.batch) {
      batches.push(result.batch);
      events.push(...result.batch.events);
      expect(simulator.getPendingBatch()).toEqual(result.batch);
      simulator.acknowledgeBatch(result.batch.batch_id);
    }
  }

  expect(simulator.inventory.water_m3).toBeGreaterThanOrEqual(0);
  expect(simulator.inventory.water_m3).toBeLessThanOrEqual(50);
  return { events, alerts, batches, waterAtEnd: simulator.inventory.water_m3 };
}

function readReceipt(): {
  catalog: { sha256: string };
  assets: Array<{ path: string; sha256: string }>;
} {
  return JSON.parse(
    readFileSync(new URL("../src/mining/catalog-receipt.json", import.meta.url), "utf8"),
  ) as {
    catalog: { sha256: string };
    assets: Array<{ path: string; sha256: string }>;
  };
}

describe("D01 mining contracts and catalog", () => {
  it("preserves the published metadata hash, row joins, counts, and v1 contract", () => {
    const receipt = readReceipt();
    expect(D01_CATALOG_VERSION).toBe(`sha256:${receipt.catalog.sha256}`);
    const metadataBytes = readFileSync(
      new URL("../src/mining/plant-catalog.json", import.meta.url),
    );
    expect(createHash("sha256").update(metadataBytes).digest("hex")).toBe(receipt.catalog.sha256);
    expect(receipt.assets).toHaveLength(16);
    expect(receipt.assets.every((asset) => /^[a-f0-9]{64}$/.test(asset.sha256))).toBe(true);

    validateD01PlantCatalog(D01_PLANT_CATALOG);
    const records = toD01CatalogRecords();
    expect(records).toHaveLength(194);
    expect(records.filter((row) => row.record_kind === "module")).toHaveLength(24);
    expect(records.filter((row) => row.record_kind === "equipment")).toHaveLength(64);
    expect(records.filter((row) => row.record_kind === "stream")).toHaveLength(50);
    expect(records.filter((row) => row.record_kind === "tag")).toHaveLength(56);
    expect(records.every((row) => row.catalog_version === D01_CATALOG_VERSION)).toBe(true);
    expect(
      records.filter((row) => row.record_kind === "stream").every((row) => row.module_id === null),
    ).toBe(true);

    const intervals = D01_PLANT_CATALOG.telemetry_tags.map(getD01TagIntervalSeconds);
    expect(intervals.filter((interval) => interval === 30)).toHaveLength(45);
    expect(intervals.filter((interval) => interval === 60)).toHaveLength(11);
    expect(Object.keys(D01_PLANT_CATALOG.telemetry_event_contract.required)).toHaveLength(8);
    expect(D01_PLANT_CATALOG.telemetry_event_contract.required).not.toContain("schema_version");

    const utcPattern = String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`;
    for (const schemaPath of [
      "../src/mining/alert-transition.schema.json",
      "../src/mining/numeric-event-v2.schema.json",
      "../src/mining/state-event-v2.schema.json",
    ]) {
      const schema = JSON.parse(readFileSync(new URL(schemaPath, import.meta.url), "utf8")) as {
        properties: { timestamp: { pattern: string } };
      };
      const pattern = new RegExp(schema.properties.timestamp.pattern);
      expect(schema.properties.timestamp.pattern).toBe(utcPattern);
      expect(pattern.test("2024-01-01T00:00:30.000Z")).toBe(true);
      expect(pattern.test("2024-01-01T01:00:30.000+01:00")).toBe(false);
    }
  });

  it("rejects broken stream joins and emits flattened v2 bodies", () => {
    const invalidCatalog = structuredClone(D01_PLANT_CATALOG);
    invalidCatalog.streams[0]!.source.port_id = "missing-port";
    expect(() => validateD01PlantCatalog(invalidCatalog)).toThrow(/source port/);

    const tag = D01_PLANT_CATALOG.telemetry_tags[0]!;
    const timestamp = "2024-01-01T00:00:30.000Z";
    const numeric: D01NumericTelemetryEvent = {
      schema_version: 2,
      run_id: runId,
      event_id: createD01EventId(runId, 1),
      sequence: 1,
      interval_seconds: 30,
      timestamp,
      plant_id: "D01",
      module_id: tag.module_id,
      equipment_id: tag.equipment_id,
      tag_id: tag.id,
      value: 25,
      unit: tag.unit,
      quality: "good",
    };
    assertD01NumericTelemetryEvent(numeric);
    const body = toD01TransportBody(numeric);
    expect(body.entityType).toBe("PlantTelemetry");
    expect(body).not.toHaveProperty("payload");
    expect(body).toHaveProperty("schema_version", 2);

    expect(() =>
      assertD01NumericTelemetryEvent({
        ...numeric,
        unit: "wrong-unit",
      }),
    ).toThrow(/unit/);
    expect(() =>
      assertD01NumericTelemetryEvent({
        ...numeric,
        value: Number.NaN,
      }),
    ).toThrow(/finite/);
    for (const quality of ["uncertain", "bad"] as const) {
      expect(() => assertD01NumericTelemetryEvent({ ...numeric, quality })).not.toThrow();
    }
    expect(() =>
      assertD01NumericTelemetryEvent({
        ...numeric,
        quality: "invalid",
      }),
    ).toThrow(/quality/);
    expect(() =>
      assertD01NumericTelemetryEvent({
        ...numeric,
        entityType: "PlantTelemetry",
      }),
    ).toThrow(/unexpected fields/);

    const numericSchema = JSON.parse(
      readFileSync(new URL("../src/mining/numeric-event-v2.schema.json", import.meta.url), "utf8"),
    ) as { properties: { quality: { enum: string[] } } };
    expect(numericSchema.properties.quality.enum).toEqual(["good", "uncertain", "bad"]);

    const state: D01PlantStateEvent = {
      schema_version: 2,
      run_id: runId,
      event_id: createD01EventId(runId, 2),
      sequence: 2,
      timestamp,
      plant_id: "D01",
      scope_id: "C",
      scheduled_running: true,
      state: "running",
    };
    assertD01PlantStateEvent(state);
    expect(toD01TransportBody(state).entityType).toBe("PlantStateEvent");

    const alert: D01AlertTransition = {
      plant_id: "D01",
      run_id: runId,
      transition_id: createD01AlertTransitionId(runId, "sample-rule", "C", "raised", timestamp),
      timestamp,
      rule_id: "sample-rule",
      scope_id: "C",
      transition: "raised",
      severity: "warning",
      evidence: { measured_value: 10, source_tag_id: tag.id, unit: tag.unit },
    };
    assertD01AlertTransition(alert);
    expect(() => assertD01AlertTransition({ ...alert, transition_id: "unstable" })).toThrow(
      /transition_id/,
    );
  });

  it("enforces deterministic seed, duration, and real-time timestamp bounds", () => {
    expect(() =>
      createD01Simulation({
        runId,
        startedAt: start,
        seed: -1,
      }),
    ).toThrow(/unsigned 32-bit/);
    expect(() =>
      createD01Simulation({
        runId,
        startedAt: start,
        durationSeconds: 1805,
      }),
    ).toThrow(/durationSeconds/);
    expect(() =>
      createD01Simulation({
        runId,
        startedAt: new Date(Date.now() + 60_000),
      }),
    ).toThrow(/future/);

    const live = createD01Simulation({ runId, startedAt: new Date() });
    expect(() => live.step(new Date(live.startedAt.valueOf() + 5000))).toThrow(/future timestamp/);
    expect(live.elapsedSecondsSoFar).toBe(0);
  });
});

describe("D01 deterministic bounded simulator", () => {
  it("produces 2,020 numeric events, 80 heartbeats, and stable retry batches in 20 minutes", () => {
    const first = runSimulation("normal", 1200);
    const second = runSimulation("normal", 1200);
    const numeric = first.events.filter((event) => event.entityType === "PlantTelemetry");
    const state = first.events.filter((event) => event.entityType === "PlantStateEvent");

    expect(numeric).toHaveLength(2020);
    expect(state).toHaveLength(92);
    expect(first.alerts).toHaveLength(0);
    expect(first.batches.map((batch) => batch.batch_id)).toEqual(
      second.batches.map((batch) => batch.batch_id),
    );
    expect(numeric.map((event) => [event.event_id, event.value])).toEqual(
      second.events
        .filter((event) => event.entityType === "PlantTelemetry")
        .map((event) => [event.event_id, event.value]),
    );
    for (const batch of first.batches) {
      expect(batch.events.map((event) => event.sequence)).toEqual(
        [...batch.events.map((event) => event.sequence)].sort((left, right) => left - right),
      );
    }

    const heartbeatsAtMinute = state.filter(
      (event) =>
        event.state === "running" &&
        new Date(event.timestamp).valueOf() > start.valueOf() &&
        (new Date(event.timestamp).valueOf() - start.valueOf()) % 60_000 === 0,
    );
    expect(heartbeatsAtMinute).toHaveLength(84);
    expect(heartbeatsAtMinute.length - 4).toBe(80);
  });

  it("models bearing, DMS, water, and communication-gap scenarios as correlated events", () => {
    const bearing = runSimulation("bearing-b", 1200);
    expect(bearing.alerts.map((alert) => alert.transition)).toEqual(["raised", "cleared"]);
    expect(bearing.alerts.every((alert) => !("scenario" in alert.evidence))).toBe(true);
    expect(bearing.alerts[0]?.evidence).toMatchObject({
      bearing_temperature_c: expect.any(Number),
      vibration_rms_mm_s: expect.any(Number),
    });
    expect(
      bearing.events.some(
        (event) =>
          event.entityType === "PlantStateEvent" &&
          event.scope_id === "B" &&
          event.state === "fault",
      ),
    ).toBe(true);
    expect(
      bearing.events.some(
        (event) =>
          event.entityType === "PlantTelemetry" &&
          event.tag_id === "D01.B.crusher.bearing_temperature" &&
          event.value > 65,
      ),
    ).toBe(true);

    const dms = runSimulation("dms-c", 900);
    expect(dms.alerts.map((alert) => alert.transition)).toEqual(["raised", "cleared"]);
    expect(dms.alerts.every((alert) => !("scenario" in alert.evidence))).toBe(true);
    expect(
      dms.events.some(
        (event) =>
          event.entityType === "PlantTelemetry" &&
          event.tag_id === "D01.C.dms.medium_density" &&
          event.value < 2600,
      ),
    ).toBe(true);

    const water = runSimulation("shared-water-restriction", 1200);
    expect(water.waterAtEnd).toBeLessThan(35);
    expect(water.alerts[0]?.rule_id).toBe("shared-water-low-level");
    expect(water.alerts.every((alert) => !("scenario" in alert.evidence))).toBe(true);
    expect(
      water.events.some(
        (event) =>
          event.entityType === "PlantStateEvent" &&
          event.scope_id === "shared" &&
          event.state === "fault",
      ),
    ).toBe(true);

    const gap = runSimulation("communication-gap", 360);
    const lineBTimestamps = gap.events
      .filter(
        (event) => event.entityType === "PlantTelemetry" && event.module_id.startsWith("D01.B."),
      )
      .map((event) => event.timestamp);
    expect(lineBTimestamps.some((timestamp) => timestamp === "2024-01-01T00:03:00.000Z")).toBe(
      false,
    );
    expect(lineBTimestamps.some((timestamp) => timestamp === "2024-01-01T00:06:00.000Z")).toBe(
      true,
    );
    expect(gap.alerts.map((alert) => alert.transition)).toEqual(["raised", "cleared"]);
    expect(gap.alerts.every((alert) => !("scenario" in alert.evidence))).toBe(true);
  });

  it("requires a pending batch to be acknowledged before another step", () => {
    const simulator = createD01Simulation({
      runId,
      startedAt: start,
      durationSeconds: 35,
    });
    for (let elapsed = 5; elapsed < 30; elapsed += 5) {
      simulator.step(new Date(start.valueOf() + elapsed * 1000));
    }
    const result = simulator.step(new Date(start.valueOf() + 30_000));
    expect(result.batch).not.toBeNull();
    const batch = result.batch!;
    expect(simulator.getPendingBatch()).toEqual(batch);
    expect(() => simulator.step(new Date(start.valueOf() + 35_000))).toThrow(
      /must be acknowledged/,
    );
    expect(() => simulator.acknowledgeBatch("wrong-batch")).toThrow(/not pending/);
    simulator.acknowledgeBatch(batch.batch_id);

    const final = simulator.step(new Date(start.valueOf() + 35_000));
    expect(final.completed).toBe(true);
    expect(final.batch?.events.length).toBeGreaterThan(0);
    expect(() => simulator.step(new Date(start.valueOf() + 40_000))).toThrow(/completed/);
  });
});
