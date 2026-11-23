import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  D01_CATALOG_VERSION,
  D01_CONNECTION_BALANCE_TOLERANCE,
  D01_CONNECTION_EVENT_ENTITY_TYPE,
  D01_CONNECTION_EVENT_FIELDS,
  D01_CONNECTION_MAX_BATCH_EVENTS,
  D01_CONNECTION_MEASUREMENT_CATALOG_VERSION,
  D01_CONNECTION_PROFILE_VERSION,
  D01_LEGACY_FLOW_PROJECTION_PROFILE_VERSION,
  D01_PLANT_CATALOG,
  assertD01ConnectionMeasurementEvent,
  balanceConnectionHopper,
  createD01ConnectionSimulation,
  createD01SharedFlowSimulation,
  toD01ConnectionMeasurementBindingRecords,
} from "../src/mining/index.js";
import type { D01ConnectionScenario, D01ConnectionSimulationStep } from "../src/mining/index.js";

const start = new Date("2024-01-01T00:00:00.000Z");
const runId = "d01-connection-flow-test";

function runSteps(
  scenario: D01ConnectionScenario,
  durationSeconds: number,
): D01ConnectionSimulationStep[] {
  const simulator = createD01ConnectionSimulation(
    { runId, startedAt: start, durationSeconds, scenario },
    () => Date.now(),
  );
  const steps: D01ConnectionSimulationStep[] = [];
  while (simulator.elapsedSecondsSoFar < durationSeconds) {
    const elapsed = simulator.elapsedSecondsSoFar + 5;
    steps.push(simulator.step(new Date(start.valueOf() + elapsed * 1000)));
  }
  return steps;
}

function runSharedFlow(
  shutdownAtSeconds: number,
  drainDownSeconds: number,
): D01ConnectionSimulationStep[] {
  const durationSeconds = shutdownAtSeconds + drainDownSeconds;
  const simulator = createD01SharedFlowSimulation(
    {
      runId,
      startedAt: start,
      durationSeconds,
      shutdownAtSeconds,
      drainDownSeconds,
    },
    () => Date.now(),
  );
  const steps: D01ConnectionSimulationStep[] = [];
  while (simulator.elapsedSecondsSoFar < durationSeconds) {
    const elapsed = simulator.elapsedSecondsSoFar + 5;
    steps.push(simulator.step(new Date(start.valueOf() + elapsed * 1000)));
  }
  return steps;
}

describe("D01 versioned connection measurements", () => {
  it("binds every authored stream and component to one versioned sensor identity", () => {
    const bindings = toD01ConnectionMeasurementBindingRecords();
    expect(D01_PLANT_CATALOG.streams).toHaveLength(50);
    expect(bindings).toHaveLength(57);
    expect(new Set(bindings.map((binding) => binding.measurement_tag_id)).size).toBe(57);
    expect(new Set(bindings.map((binding) => binding.stream_id)).size).toBe(
      D01_PLANT_CATALOG.streams.length,
    );
    for (const binding of bindings) {
      const stream = D01_PLANT_CATALOG.streams.find(
        (candidate) => candidate.id === binding.stream_id,
      );
      expect(binding.catalog_version).toBe(D01_CATALOG_VERSION);
      expect(binding.measurement_catalog_version).toBe(D01_CONNECTION_MEASUREMENT_CATALOG_VERSION);
      expect(binding.profile_version).toBe(D01_CONNECTION_PROFILE_VERSION);
      expect(binding.sample_interval_seconds).toBe(5);
      expect(binding.source).toEqual({
        module_id: stream!.source.module_id,
        port_id: stream!.source.port_id,
        equipment_id: null,
        equipment_port_id: null,
      });
      expect(binding.target).toEqual({
        module_id: stream!.target.module_id,
        port_id: stream!.target.port_id,
        equipment_id: null,
        equipment_port_id: null,
      });
      expect(binding.nominal_capacity.purpose).toBe("visualization_scale_only");
      if (binding.quantity === "dry_solids_mass_flow") {
        expect(binding.basis).toBe("dry_solids");
        expect(binding.unit).toBe("t/h");
      } else if (binding.quantity === "water_volume_flow") {
        expect(binding.basis).toBe("water");
        expect(binding.unit).toBe("m3/h");
      } else {
        expect(binding.basis).toBe("ferrosilicon_medium");
        expect(binding.unit).toBe("m3/h");
      }
    }
  });

  it("emits separate raw five-second events and exact-size batches, preserving legacy profiles", () => {
    const [step] = runSteps("normal", 5);
    expect(step!.expected_observation_count).toBe(57);
    expect(step!.expected_total_observation_count).toBe(57);
    expect(step!.emitted_observation_count).toBe(57);
    expect(step!.batch.events).toHaveLength(57);
    expect(step!.batch.events.length).toBeLessThan(D01_CONNECTION_MAX_BATCH_EVENTS);
    expect(step!.batch.sample_interval_seconds).toBe(5);
    expect(step!.observations.every((event) => event.entityType === "ConnectionMeasurement")).toBe(
      true,
    );
    expect(step!.observations.every((event) => event.sample_time === step!.sample_time)).toBe(true);
    expect(step!.observations.every((event) => event.value >= 0 && event.quality === "good")).toBe(
      true,
    );
    for (const event of step!.observations) {
      expect(event.profile_version).toBe(D01_CONNECTION_PROFILE_VERSION);
      expect(() => assertD01ConnectionMeasurementEvent(event)).not.toThrow();
    }
    expect(() =>
      assertD01ConnectionMeasurementEvent({
        ...step!.observations[0]!,
        interval_seconds: 30,
      }),
    ).toThrow(/unexpected fields/);
    expect(() =>
      assertD01ConnectionMeasurementEvent({
        ...step!.observations[0]!,
        sample_interval_seconds: 30,
      }),
    ).toThrow(/five seconds/);
  });

  it("keeps the JSON Schema discriminator and exact field set aligned with the validator", () => {
    const schema = JSON.parse(
      readFileSync(
        new URL("../src/mining/connection-measurement-v1.schema.json", import.meta.url),
        "utf8",
      ),
    ) as {
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, { const?: unknown }>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required.sort()).toEqual([...D01_CONNECTION_EVENT_FIELDS].sort());
    expect(schema.properties.entityType!.const).toBe(D01_CONNECTION_EVENT_ENTITY_TYPE);
    expect(schema.properties.schema_version!.const).toBe(1);
    expect(schema.properties.sample_interval_seconds!.const).toBe(5);
    expect(schema.properties.profile_version!.const).toBe(D01_CONNECTION_PROFILE_VERSION);
  });

  it("projects legacy flow sensors and state from the same five-second process state", () => {
    const startup = createD01SharedFlowSimulation(
      {
        runId,
        startedAt: start,
        shutdownAtSeconds: 300,
        drainDownSeconds: 190,
        durationSeconds: 490,
      },
      () => Date.now(),
    );
    const steps = runSharedFlow(300, 190);
    const first = steps[0]!;
    const at30 = steps[5]!;
    const at60 = steps[11]!;

    expect(startup.initial_legacy_state_events).toHaveLength(4);
    expect(startup.initial_legacy_state_events.every((event) => event.state === "starting")).toBe(
      true,
    );
    expect(first.lifecycle_phase).toBe("starting");
    expect(first.observations.find((event) => event.stream_id === "process-A-feed")!.value).toBe(
      3.5,
    );
    expect(at60.lifecycle_phase).toBe("running");
    expect(at60.observations.find((event) => event.stream_id === "process-A-feed")!.value).toBe(42);
    expect(at30.expected_legacy_event_count).toBe(41);
    expect(at30.emitted_legacy_event_count).toBe(41);
    expect(at60.expected_legacy_event_count).toBe(47);
    expect(at60.emitted_legacy_event_count).toBe(47);
    expect(at60.legacy_state_events.filter((event) => event.state === "running")).toHaveLength(8);
    expect(at30.legacy_projection_profile_version).toBe(D01_LEGACY_FLOW_PROJECTION_PROFILE_VERSION);
    expect(at30.unprojected_legacy_tag_ids).toHaveLength(9);
    expect(
      at30.legacy_transport_events.every((event) => event.entityType !== "ConnectionMeasurement"),
    ).toBe(true);

    const rawRate = (step: D01ConnectionSimulationStep, streamId: string, quantity: string) =>
      step.observations.find(
        (event) => event.stream_id === streamId && event.quantity === quantity,
      )!.value;
    const average = (rates: number[]) =>
      Math.round((rates.reduce((total, rate) => total + rate, 0) / rates.length) * 10_000) / 10_000;
    const firstSix = steps.slice(0, 6);
    const crusherProjection = at30.legacy_numeric_events.find(
      (event) => event.tag_id === "D01.A.crusher.ore_flow",
    )!;
    expect(crusherProjection.value).toBeCloseTo(
      average(firstSix.map((step) => rawRate(step, "process-A-feed", "dry_solids_mass_flow"))),
      4,
    );

    const sharedWaterProjection = at30.legacy_numeric_events.find(
      (event) => event.tag_id === "D01.shared.water.water_flow",
    )!;
    const branchWaterRates = firstSix.map((step) =>
      ["A", "B", "C"].reduce(
        (total, line) =>
          total +
          rawRate(step, `utility-${line}-scrubber-water`, "water_volume_flow") +
          rawRate(step, `utility-${line}-screen-water`, "water_volume_flow") +
          rawRate(step, `utility-${line}-medium-water`, "water_volume_flow"),
        0,
      ),
    );
    expect(sharedWaterProjection.value).toBeCloseTo(average(branchWaterRates), 4);

    const sorterProjection = at30.legacy_numeric_events.find(
      (event) => event.tag_id === "D01.A.sorter.ore_flow",
    )!;
    expect(sorterProjection.value).toBeCloseTo(
      average(
        firstSix.map((step) => rawRate(step, "process-A-concentrate", "dry_solids_mass_flow")),
      ),
      4,
    );
  });

  it("shuts off feed, drains delayed inventories, and conserves stored hopper and water", () => {
    const steps = runSharedFlow(300, 190);
    const atShutdown = steps.find((step) => step.elapsed_seconds === 300)!;
    const duringDrain = steps.find((step) => step.elapsed_seconds === 305)!;
    const final = steps.at(-1)!;
    const feedStreams = ["process-A-feed", "process-B-feed", "process-C-feed"];
    expect(
      duringDrain.boundary_flows.find((flow) => flow.boundary_id === "external-ore-feed")!.rate,
    ).toBe(0);
    expect(duringDrain.lifecycle_phase).toBe("draining");
    expect(
      feedStreams.every(
        (streamId) =>
          duringDrain.observations.find((event) => event.stream_id === streamId)!.value === 0,
      ),
    ).toBe(true);
    expect(
      duringDrain.observations.find((event) => event.stream_id === "process-A-crush")!.value,
    ).toBeGreaterThan(0);
    expect(
      duringDrain.observations.find((event) => event.stream_id === "utility-A-scrubber-water")!
        .value,
    ).toBeGreaterThan(0);

    expect(final.lifecycle_phase).toBe("stopped");
    expect(final.completed).toBe(true);
    expect(final.inventory.in_transit_solids_tonnes).toBeCloseTo(0, 12);
    expect(final.inventory.in_transit_water_m3).toBeCloseTo(0, 12);
    expect(final.inventory.hopper_tonnes).toBeGreaterThan(0);
    expect(final.inventory.hopper_tonnes).toBeCloseTo(atShutdown.inventory.hopper_tonnes, 12);
    expect(final.inventory.water_tank_m3).toBeGreaterThanOrEqual(0);
    expect(final.observations.every((event) => event.value === 0)).toBe(true);
    expect(final.legacy_state_events.filter((event) => event.state === "stopped")).toHaveLength(4);
    for (const step of steps) {
      expect(Math.abs(step.balance.dry_solids.residual_tonnes)).toBeLessThanOrEqual(
        D01_CONNECTION_BALANCE_TOLERANCE,
      );
      expect(Math.abs(step.balance.water.residual_m3)).toBeLessThanOrEqual(
        D01_CONNECTION_BALANCE_TOLERANCE,
      );
      expect(Math.abs(step.balance.medium.residual_m3)).toBeLessThanOrEqual(
        D01_CONNECTION_BALANCE_TOLERANCE,
      );
    }
  });

  it("closes per-step dry-solids, water, and medium balances at unrounded precision", () => {
    const steps = runSteps("normal", 10 * 60);
    expect(steps).toHaveLength(120);
    for (const step of steps) {
      expect(Math.abs(step.balance.dry_solids.residual_tonnes)).toBeLessThanOrEqual(
        D01_CONNECTION_BALANCE_TOLERANCE,
      );
      expect(Math.abs(step.balance.water.residual_m3)).toBeLessThanOrEqual(
        D01_CONNECTION_BALANCE_TOLERANCE,
      );
      expect(Math.abs(step.balance.medium.residual_m3)).toBeLessThanOrEqual(
        D01_CONNECTION_BALANCE_TOLERANCE,
      );
      expect(step.inventory.hopper_tonnes).toBeGreaterThanOrEqual(0);
      expect(step.inventory.in_transit_solids_tonnes).toBeGreaterThanOrEqual(0);
      expect(step.inventory.tailings_tonnes).toBeGreaterThanOrEqual(0);
      expect(step.inventory.water_tank_m3).toBeGreaterThanOrEqual(0);
      expect(step.inventory.water_tank_m3).toBeLessThanOrEqual(60);
      expect(step.inventory.in_transit_water_m3).toBeGreaterThanOrEqual(0);
      expect(step.inventory.ferrosilicon_medium_m3).toBeGreaterThan(0);
    }
    expect(steps.at(-1)!.balance.dry_solids.recovered_product_tonnes).toBeGreaterThan(0);
  });

  it("models a single-line restriction and a hopper-starvation scenario without losing queued solids", () => {
    const restricted = runSteps("line-restriction", 600);
    const restrictionStep = restricted[59]!;
    const lineA = restrictionStep.observations.find(
      (event) => event.stream_id === "process-A-feed",
    );
    const lineB = restrictionStep.observations.find(
      (event) => event.stream_id === "process-B-feed",
    );
    expect(lineA!.value).toBeGreaterThan(lineB!.value);
    expect(restrictionStep.balance.dry_solids.residual_tonnes).toBeLessThanOrEqual(
      D01_CONNECTION_BALANCE_TOLERANCE,
    );

    const starved = runSteps("hopper-starvation", 900);
    const final = starved.at(-1)!;
    const finalFeed = final.observations.filter((event) =>
      event.stream_id.match(/^process-[ABC]-feed$/),
    );
    expect(finalFeed).toHaveLength(3);
    expect(finalFeed.every((event) => event.value === 0)).toBe(true);
    expect(final.inventory.hopper_tonnes).toBeGreaterThanOrEqual(0);
    for (const step of starved) {
      expect(Math.abs(step.balance.dry_solids.residual_tonnes)).toBeLessThanOrEqual(
        D01_CONNECTION_BALANCE_TOLERANCE,
      );
    }
  });

  it("limits the shared-water scenario to available supply and retains a closed water balance", () => {
    const restricted = runSteps("shared-water-restriction", 30 * 60);
    const final = restricted.at(-1)!;
    const normal = runSteps("normal", 30 * 60).at(-1)!;
    const totalFinalFeed = final.observations
      .filter((event) => /^process-[ABC]-feed$/.test(event.stream_id))
      .reduce((total, event) => total + event.value, 0);
    const totalNormalFeed = normal.observations
      .filter((event) => /^process-[ABC]-feed$/.test(event.stream_id))
      .reduce((total, event) => total + event.value, 0);
    expect(totalFinalFeed).toBeLessThan(totalNormalFeed);
    for (const step of restricted) {
      expect(Math.abs(step.balance.water.residual_m3)).toBeLessThanOrEqual(
        D01_CONNECTION_BALANCE_TOLERANCE,
      );
      expect(step.inventory.water_tank_m3).toBeGreaterThanOrEqual(0);
    }
  });

  it("omits a missing sensor instead of publishing zero and reports reconciliation counts", () => {
    const steps = runSteps("missing-sensor", 6 * 60);
    const affected = steps.filter(
      (step) => step.elapsed_seconds >= 180 && step.elapsed_seconds < 360,
    );
    expect(affected.length).toBe(36);
    for (const step of affected) {
      expect(step.expected_observation_count).toBe(57);
      expect(step.emitted_observation_count).toBe(56);
      expect(step.missing_measurement_tag_ids).toHaveLength(1);
      expect(
        step.observations.some(
          (event) => event.measurement_tag_id === step.missing_measurement_tag_ids[0],
        ),
      ).toBe(false);
    }
    const restored = steps.find((step) => step.elapsed_seconds === 360)!;
    expect(restored.emitted_observation_count).toBe(57);
    expect(
      restored.observations.every((event) => event.entityType === D01_CONNECTION_EVENT_ENTITY_TYPE),
    ).toBe(true);
  });

  it("accounts for explicit capacity spill without rounding integrated mass", () => {
    const result = balanceConnectionHopper(9.9, 0.4, 0.1, 10);
    expect(result.inventory).toBeCloseTo(9.9, 12);
    expect(result.outflow).toBeCloseTo(0.1, 12);
    expect(result.spill).toBeCloseTo(0.3, 12);
  });
});
