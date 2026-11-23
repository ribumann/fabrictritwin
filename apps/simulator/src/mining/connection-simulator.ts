import {
  D01_CATALOG_VERSION,
  D01_PLANT_CATALOG,
  D01_PLANT_ID,
  getD01TagIntervalSeconds,
} from "./catalog.js";
import type { D01TelemetryTag } from "./catalog.js";
import {
  D01_CONNECTION_MEASUREMENT_CATALOG_VERSION,
  D01_CONNECTION_PROFILE_VERSION,
  D01_CONNECTION_SAMPLE_INTERVAL_SECONDS,
  D01_LEGACY_FLOW_PROJECTION_PROFILE_VERSION,
  toD01ConnectionMeasurementBindingRecords,
} from "./connection-catalog.js";
import type {
  D01ConnectionMeasurementBinding,
  D01ConnectionQuantity,
} from "./connection-catalog.js";
import {
  assertD01ConnectionMeasurementEvent,
  createD01ConnectionBatchId,
  createD01ConnectionEventId,
} from "./connection-events.js";
import type { D01ConnectionMeasurementEvent } from "./connection-events.js";
import { assertD01NumericTelemetryEvent, createD01EventId } from "./events.js";
import { assertD01PlantStateEvent, toD01TransportBody } from "./events.js";
import type {
  D01NumericTelemetryEvent,
  D01PlantStateEvent,
  D01StateScope,
  D01TransportBody,
} from "./events.js";

export const D01_CONNECTION_BALANCE_TOLERANCE = 1e-9;
export const D01_CONNECTION_MAX_BATCH_EVENTS = 200;

export type D01ConnectionScenario =
  | "normal"
  | "line-restriction"
  | "shared-water-restriction"
  | "hopper-starvation"
  | "missing-sensor";
type LineId = "A" | "B" | "C";

export interface CreateD01ConnectionSimulationOptions {
  runId: string;
  startedAt: Date;
  durationSeconds?: number;
  scenario?: D01ConnectionScenario;
  /** Elapsed time at which external feed and new line dispatch stop. */
  shutdownAtSeconds?: number;
  /** Required queue-clearance interval after shutdown; defaults to the modeled 180 seconds. */
  drainDownSeconds?: number;
}

export type D01ConnectionLifecyclePhase = "starting" | "running" | "draining" | "stopped";

export interface D01SharedFlowRunProfile {
  run_profile_version: typeof D01_CONNECTION_PROFILE_VERSION;
  catalog_version: typeof D01_CATALOG_VERSION;
  measurement_catalog_version: typeof D01_CONNECTION_MEASUREMENT_CATALOG_VERSION;
  connection_profile_version: typeof D01_CONNECTION_PROFILE_VERSION;
  legacy_projection_profile_version: typeof D01_LEGACY_FLOW_PROJECTION_PROFILE_VERSION;
  connection_sample_interval_seconds: typeof D01_CONNECTION_SAMPLE_INTERVAL_SECONDS;
  projected_legacy_tag_ids: readonly string[];
  unprojected_legacy_tag_ids: readonly string[];
  expected_connection_observations_per_sample: number;
  expected_legacy_numeric_events_for_run: number;
}

export interface D01ConnectionBalance {
  dry_solids: {
    opening_inventory_tonnes: number;
    external_input_tonnes: number;
    hopper_spill_tonnes: number;
    recovered_product_tonnes: number;
    tailings_overflow_tonnes: number;
    closing_inventory_tonnes: number;
    residual_tonnes: number;
  };
  water: {
    opening_inventory_m3: number;
    makeup_m3: number;
    process_loss_m3: number;
    tailings_underflow_m3: number;
    tank_overflow_m3: number;
    closing_inventory_m3: number;
    residual_m3: number;
  };
  medium: {
    opening_inventory_m3: number;
    makeup_m3: number;
    modeled_loss_m3: number;
    closing_inventory_m3: number;
    residual_m3: number;
  };
}

export interface D01ConnectionBoundaryFlow {
  boundary_id:
    | "external-ore-feed"
    | "hopper-spill"
    | "recovered-product"
    | "tailings-overflow"
    | "water-makeup"
    | "process-water-loss"
    | "tailings-underflow-water"
    | "water-tank-overflow"
    | "medium-makeup"
    | "medium-loss";
  direction: "in" | "out";
  quantity: D01ConnectionQuantity;
  rate: number;
  unit: "t/h" | "m3/h";
}

export interface D01ConnectionInventory {
  hopper_tonnes: number;
  in_transit_solids_tonnes: number;
  tailings_tonnes: number;
  water_tank_m3: number;
  in_transit_water_m3: number;
  ferrosilicon_medium_m3: number;
}

export interface D01ConnectionObservationBatch {
  batch_id: string;
  sample_time: string;
  sample_interval_seconds: typeof D01_CONNECTION_SAMPLE_INTERVAL_SECONDS;
  events: readonly D01ConnectionMeasurementEvent[];
}

export interface D01ConnectionSimulationStep {
  elapsed_seconds: number;
  sample_time: string;
  lifecycle_phase: D01ConnectionLifecyclePhase;
  observations: readonly D01ConnectionMeasurementEvent[];
  batch: D01ConnectionObservationBatch;
  expected_observation_count: number;
  expected_total_observation_count: number;
  emitted_observation_count: number;
  missing_measurement_tag_ids: readonly string[];
  legacy_numeric_events: readonly D01NumericTelemetryEvent[];
  legacy_projection_profile_version: typeof D01_LEGACY_FLOW_PROJECTION_PROFILE_VERSION;
  expected_legacy_event_count: number;
  emitted_legacy_event_count: number;
  unprojected_legacy_tag_ids: readonly string[];
  legacy_state_events: readonly D01PlantStateEvent[];
  legacy_transport_events: readonly D01TransportBody[];
  inventory: D01ConnectionInventory;
  boundary_flows: readonly D01ConnectionBoundaryFlow[];
  balance: D01ConnectionBalance;
  completed: boolean;
}

interface LineState {
  crushTransitTonnes: number[];
  washTransitTonnes: number[];
  dmsTransitTonnes: number[];
  mediumTransitTonnes: number[];
  sorterTransitTonnes: number[];
  mediumInventoryM3: number;
}

const stepSeconds = D01_CONNECTION_SAMPLE_INTERVAL_SECONDS;
const stepHours = stepSeconds / 3600;
const hopperCapacityTonnes = 1200;
const tailingsCapacityTonnes = 8000;
const defaultDurationSeconds = 20 * 60;
const maximumDurationSeconds = 30 * 60;
const delaySteps = 6;
export const D01_CONNECTION_REQUIRED_DRAIN_DOWN_SECONDS = stepSeconds * delaySteps * 6;
const requiredDrainDownSeconds = D01_CONNECTION_REQUIRED_DRAIN_DOWN_SECONDS;
const lineIds: readonly LineId[] = ["A", "B", "C"];
const nominalFeedTonnesPerHour: Record<LineId, number> = { A: 42, B: 44, C: 40 };
const feedWaterDemandPerLoad: Record<"scrubber" | "screen" | "medium", number> = {
  scrubber: 55,
  screen: 22,
  medium: 12,
};
const bindings = toD01ConnectionMeasurementBindingRecords();
const unsupportedLegacyTagIds = new Set([
  ...D01_PLANT_CATALOG.telemetry_tags
    .filter((tag) => tag.metric === "medium_density")
    .map((tag) => tag.id),
  ...D01_PLANT_CATALOG.telemetry_tags
    .filter((tag) => tag.metric === "level" && tag.module_id.endsWith(".medium"))
    .map((tag) => tag.id),
  "D01.shared.thickener.level",
  "D01.shared.tailings.water_flow",
  "D01.shared.lab.product_mass",
]);
const projectedLegacyTags = D01_PLANT_CATALOG.telemetry_tags.filter(
  (tag) => !unsupportedLegacyTagIds.has(tag.id),
);
const unprojectedLegacyTagIds = D01_PLANT_CATALOG.telemetry_tags
  .filter((tag) => unsupportedLegacyTagIds.has(tag.id))
  .map((tag) => tag.id);
const idleCurrents: Record<string, number> = {
  crusher: 6,
  scrubber: 8,
  screen: 2,
  dms: 6,
  medium: 4,
  sorter: 3,
  thickener: 18,
};
const motorLoadMultipliers: Record<string, number> = {
  crusher: 92,
  scrubber: 68,
  screen: 20,
  dms: 54,
  medium: 28,
  sorter: 38,
};
const legacyScopes: readonly D01StateScope[] = ["A", "B", "C", "shared"];
const missingScenarioTagId = bindings.find(
  (binding) =>
    binding.stream_id === "process-B-wash" && binding.quantity === "dry_solids_mass_flow",
)!.measurement_tag_id;

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be finite and non-negative.`);
  }
}

/** Integrates exact tonnes; a full hopper spills excess before dispatching feed. */
export function balanceConnectionHopper(
  inventoryTonnes: number,
  inflowTonnes: number,
  requestedOutflowTonnes: number,
  capacityTonnes = hopperCapacityTonnes,
): { inventory: number; outflow: number; spill: number } {
  assertFiniteNonNegative(inventoryTonnes, "Hopper inventory");
  assertFiniteNonNegative(inflowTonnes, "Hopper inflow");
  assertFiniteNonNegative(requestedOutflowTonnes, "Hopper requested outflow");
  if (!Number.isFinite(capacityTonnes) || capacityTonnes <= 0) {
    throw new RangeError("Hopper capacity must be finite and positive.");
  }
  const incoming = inventoryTonnes + inflowTonnes;
  const spill = Math.max(0, incoming - capacityTonnes);
  const available = incoming - spill;
  const outflow = Math.min(available, requestedOutflowTonnes);
  return { inventory: available - outflow, outflow, spill };
}

function advanceDelay(queue: number[], incoming: number): number {
  queue.push(incoming);
  return queue.shift() ?? 0;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function roundObservationRate(value: number): number {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  if (!Number.isFinite(rounded) || rounded < 0) {
    throw new RangeError("The D01 connection model produced an invalid observation value.");
  }
  return rounded;
}

function validateOptions(options: CreateD01ConnectionSimulationOptions, now: number): void {
  if (!Number.isFinite(now)) throw new TypeError("The D01 simulation clock must be finite.");
  if (options.runId.trim().length === 0) throw new TypeError("runId must not be empty.");
  if (!(options.startedAt instanceof Date) || Number.isNaN(options.startedAt.valueOf())) {
    throw new TypeError("startedAt must be a valid Date.");
  }
  if (options.startedAt.valueOf() > now) {
    throw new RangeError("startedAt cannot be in the future.");
  }
  const duration = options.durationSeconds ?? defaultDurationSeconds;
  if (
    !Number.isSafeInteger(duration) ||
    duration < stepSeconds ||
    duration > maximumDurationSeconds ||
    duration % stepSeconds !== 0
  ) {
    throw new RangeError(
      `durationSeconds must be a positive multiple of ${stepSeconds} no greater than ${maximumDurationSeconds}.`,
    );
  }
  if (options.shutdownAtSeconds === undefined) {
    if (options.drainDownSeconds !== undefined) {
      throw new TypeError("drainDownSeconds requires an explicit shutdownAtSeconds.");
    }
  } else {
    const shutdownAt = options.shutdownAtSeconds;
    const drainDown = options.drainDownSeconds ?? requiredDrainDownSeconds;
    if (
      !Number.isSafeInteger(shutdownAt) ||
      shutdownAt < stepSeconds ||
      shutdownAt >= duration ||
      shutdownAt % stepSeconds !== 0
    ) {
      throw new RangeError(
        `shutdownAtSeconds must be a positive ${stepSeconds}-second boundary before durationSeconds.`,
      );
    }
    if (
      !Number.isSafeInteger(drainDown) ||
      drainDown < requiredDrainDownSeconds ||
      drainDown % stepSeconds !== 0 ||
      shutdownAt + drainDown !== duration
    ) {
      throw new RangeError(
        `durationSeconds must equal shutdownAtSeconds plus a drainDownSeconds interval of at least ${requiredDrainDownSeconds} seconds.`,
      );
    }
  }
  if (
    options.scenario !== undefined &&
    ![
      "normal",
      "line-restriction",
      "shared-water-restriction",
      "hopper-starvation",
      "missing-sensor",
    ].includes(options.scenario)
  ) {
    throw new TypeError(`Unsupported D01 connection scenario '${String(options.scenario)}'.`);
  }
}

function queueInventory(lines: Record<LineId, LineState>, queueName: keyof LineState): number {
  return lineIds.reduce((total, line) => {
    const queue = lines[line][queueName];
    return total + (Array.isArray(queue) ? sum(queue) : 0);
  }, 0);
}

function assertBalance(balance: D01ConnectionBalance): void {
  for (const [quantity, residual] of [
    ["dry-solids", balance.dry_solids.residual_tonnes],
    ["water", balance.water.residual_m3],
    ["medium", balance.medium.residual_m3],
  ] as const) {
    if (Math.abs(residual) > D01_CONNECTION_BALANCE_TOLERANCE) {
      throw new Error(
        `D01 ${quantity} balance residual ${residual} exceeds ${D01_CONNECTION_BALANCE_TOLERANCE}.`,
      );
    }
  }
}

function makeBoundary(
  boundary_id: D01ConnectionBoundaryFlow["boundary_id"],
  direction: D01ConnectionBoundaryFlow["direction"],
  quantity: D01ConnectionQuantity,
  amount: number,
  unit: D01ConnectionBoundaryFlow["unit"],
): D01ConnectionBoundaryFlow {
  return { boundary_id, direction, quantity, rate: amount / stepHours, unit };
}

function bindingKey(streamId: string, quantity: D01ConnectionQuantity): string {
  return `${streamId}|${quantity}`;
}

function addFlow(
  flows: Map<string, number>,
  streamId: string,
  quantity: D01ConnectionQuantity,
  amount: number,
): void {
  const key = bindingKey(streamId, quantity);
  flows.set(key, (flows.get(key) ?? 0) + amount / stepHours);
}

function flowValue(
  flows: ReadonlyMap<string, number>,
  binding: D01ConnectionMeasurementBinding,
): number {
  return flows.get(bindingKey(binding.stream_id, binding.quantity)) ?? 0;
}

export class D01ConnectionFlowSimulator {
  readonly runId: string;
  readonly scenario: D01ConnectionScenario;
  readonly startedAt: Date;
  readonly durationSeconds: number;
  readonly shutdownAtSeconds: number | null;
  readonly drainDownSeconds: number | null;
  readonly runProfile: D01SharedFlowRunProfile;
  readonly initial_legacy_state_events: readonly D01PlantStateEvent[];

  private elapsedSeconds = 0;
  private sequence = 0;
  private legacySequence = 0;
  private hopperTonnes: number;
  private tailingsTonnes = 3600;
  private waterTankM3 = 39;
  private readonly legacyWindows = new Map<string, number[]>();
  private readonly legacyStates = new Map<D01StateScope, "starting" | "running" | "stopped">();
  private readonly thickenerSolidsTransitTonnes = Array<number>(delaySteps).fill(0);
  private readonly thickenerWaterTransitM3 = Array<number>(delaySteps).fill(0);
  private readonly returnWaterTransitM3 = Array<number>(delaySteps).fill(0);
  private readonly lines: Record<LineId, LineState>;

  constructor(
    options: CreateD01ConnectionSimulationOptions,
    private readonly now: () => number = () => Date.now(),
  ) {
    validateOptions(options, this.now());
    this.runId = options.runId;
    this.scenario = options.scenario ?? "normal";
    this.startedAt = new Date(options.startedAt.valueOf());
    this.durationSeconds = options.durationSeconds ?? defaultDurationSeconds;
    this.shutdownAtSeconds = options.shutdownAtSeconds ?? null;
    this.drainDownSeconds =
      this.shutdownAtSeconds === null
        ? null
        : (options.drainDownSeconds ?? requiredDrainDownSeconds);
    this.hopperTonnes = this.scenario === "hopper-starvation" ? 10 : 780;
    for (const tag of projectedLegacyTags) this.legacyWindows.set(tag.id, []);
    this.runProfile = Object.freeze({
      run_profile_version: D01_CONNECTION_PROFILE_VERSION,
      catalog_version: D01_CATALOG_VERSION,
      measurement_catalog_version: D01_CONNECTION_MEASUREMENT_CATALOG_VERSION,
      connection_profile_version: D01_CONNECTION_PROFILE_VERSION,
      legacy_projection_profile_version: D01_LEGACY_FLOW_PROJECTION_PROFILE_VERSION,
      connection_sample_interval_seconds: D01_CONNECTION_SAMPLE_INTERVAL_SECONDS,
      projected_legacy_tag_ids: Object.freeze(projectedLegacyTags.map((tag) => tag.id)),
      unprojected_legacy_tag_ids: Object.freeze([...unprojectedLegacyTagIds]),
      expected_connection_observations_per_sample: bindings.length,
      expected_legacy_numeric_events_for_run: projectedLegacyTags.reduce(
        (total, tag) => total + Math.floor(this.durationSeconds / getD01TagIntervalSeconds(tag)),
        0,
      ),
    });
    this.lines = {
      A: this.createLineState(),
      B: this.createLineState(),
      C: this.createLineState(),
    };
    const startupEvents: D01PlantStateEvent[] = [];
    for (const scope of legacyScopes) {
      this.legacyStates.set(scope, "starting");
      startupEvents.push(
        this.createLegacyStateEvent(scope, "starting", true, this.startedAt.toISOString()),
      );
    }
    this.initial_legacy_state_events = startupEvents;
  }

  get elapsedSecondsSoFar(): number {
    return this.elapsedSeconds;
  }

  get expectedObservationCountForRun(): number {
    return (this.durationSeconds / stepSeconds) * bindings.length;
  }

  get expectedLegacyEventCountForRun(): number {
    return this.runProfile.expected_legacy_numeric_events_for_run;
  }

  step(at: Date): D01ConnectionSimulationStep {
    if (this.elapsedSeconds >= this.durationSeconds) {
      throw new Error("The D01 connection simulation has completed.");
    }
    const nextElapsedSeconds = this.elapsedSeconds + stepSeconds;
    const expectedTime = this.startedAt.valueOf() + nextElapsedSeconds * 1000;
    if (!(at instanceof Date) || Number.isNaN(at.valueOf()) || at.valueOf() !== expectedTime) {
      throw new RangeError(
        "D01 connection steps must be supplied at exact 5-second UTC intervals.",
      );
    }
    const now = this.now();
    if (!Number.isFinite(now)) throw new TypeError("The D01 simulation clock must be finite.");
    if (expectedTime > now) {
      throw new RangeError("A D01 connection step cannot emit a future timestamp.");
    }
    if (!Number.isSafeInteger(this.sequence + bindings.length)) {
      throw new RangeError("D01 connection event sequence range exhausted.");
    }
    this.elapsedSeconds = nextElapsedSeconds;
    const sampleTime = new Date(expectedTime).toISOString();
    const acceptingFeed =
      this.shutdownAtSeconds === null || this.elapsedSeconds <= this.shutdownAtSeconds;
    const openingDryInventory =
      this.hopperTonnes +
      queueInventory(this.lines, "crushTransitTonnes") +
      queueInventory(this.lines, "washTransitTonnes") +
      queueInventory(this.lines, "dmsTransitTonnes") +
      queueInventory(this.lines, "mediumTransitTonnes") +
      queueInventory(this.lines, "sorterTransitTonnes") +
      sum(this.thickenerSolidsTransitTonnes) +
      this.tailingsTonnes;
    const openingWaterInventory =
      this.waterTankM3 + sum(this.thickenerWaterTransitM3) + sum(this.returnWaterTransitM3);
    const openingMediumInventory = lineIds.reduce(
      (total, line) => total + this.lines[line].mediumInventoryM3,
      0,
    );

    const returnedWaterVolume = this.returnWaterTransitM3.shift() ?? 0;
    const returnedWaterRate = returnedWaterVolume / stepHours;
    const makeupCapacityRate =
      this.scenario === "shared-water-restriction" && this.elapsedSeconds >= 180 ? 0 : 120;
    const startupFactor = Math.min(1, this.elapsedSeconds / 60);
    const requestedRates = {} as Record<LineId, number>;
    for (const line of lineIds) {
      const restriction =
        this.scenario === "line-restriction" &&
        line === "B" &&
        this.elapsedSeconds >= 180 &&
        this.elapsedSeconds < 600
          ? 0.35
          : 1;
      requestedRates[line] = acceptingFeed
        ? nominalFeedTonnesPerHour[line] * startupFactor * restriction
        : 0;
    }

    const requestedWaterRate = lineIds.reduce((total, line) => {
      const state = this.lines[line];
      const plannedScrubberFeed =
        (state.crushTransitTonnes[0] ?? 0) / stepHours / nominalFeedTonnesPerHour[line];
      const plannedScreenFeed =
        (state.washTransitTonnes[0] ?? 0) / stepHours / nominalFeedTonnesPerHour[line];
      const plannedMediumFeed =
        (state.mediumTransitTonnes[0] ?? 0) / stepHours / nominalFeedTonnesPerHour[line];
      const requestedLoad = requestedRates[line] / nominalFeedTonnesPerHour[line];
      return (
        total +
        feedWaterDemandPerLoad.scrubber * Math.max(requestedLoad, plannedScrubberFeed) +
        feedWaterDemandPerLoad.screen * Math.max(requestedLoad, plannedScreenFeed) +
        feedWaterDemandPerLoad.medium * Math.max(requestedLoad, plannedMediumFeed)
      );
    }, 0);
    const availableWaterRate =
      (this.waterTankM3 + returnedWaterVolume) / stepHours + makeupCapacityRate;
    const waterAvailabilityFactor =
      requestedWaterRate > 0 ? Math.min(1, availableWaterRate / requestedWaterRate) : 1;
    for (const line of lineIds) requestedRates[line] *= waterAvailabilityFactor;

    const externalFeedRate =
      !acceptingFeed || this.scenario === "hopper-starvation"
        ? 0
        : 132 * (1 + 0.12 * Math.sin((this.elapsedSeconds * Math.PI) / 180));
    const externalFeedTonnes = externalFeedRate * stepHours;
    const requestedDispatchTonnes = sum(Object.values(requestedRates)) * stepHours;
    const hopper = balanceConnectionHopper(
      this.hopperTonnes,
      externalFeedTonnes,
      requestedDispatchTonnes,
    );
    const dispatchedByLineTonnes = {} as Record<LineId, number>;
    const requestedTotal = sum(Object.values(requestedRates));
    for (const line of lineIds) {
      dispatchedByLineTonnes[line] =
        requestedTotal > 0 ? hopper.outflow * (requestedRates[line] / requestedTotal) : 0;
    }
    this.hopperTonnes = hopper.inventory;

    const actualFeedRates = {} as Record<LineId, number>;
    const requestedWaterByLine = {} as Record<
      LineId,
      { scrubber: number; screen: number; medium: number }
    >;
    for (const line of lineIds) {
      actualFeedRates[line] = dispatchedByLineTonnes[line] / stepHours;
      const state = this.lines[line];
      requestedWaterByLine[line] = {
        scrubber:
          feedWaterDemandPerLoad.scrubber *
          ((state.crushTransitTonnes[0] ?? 0) / stepHours / nominalFeedTonnesPerHour[line]),
        screen:
          feedWaterDemandPerLoad.screen *
          ((state.washTransitTonnes[0] ?? 0) / stepHours / nominalFeedTonnesPerHour[line]),
        medium:
          feedWaterDemandPerLoad.medium *
          ((state.mediumTransitTonnes[0] ?? 0) / stepHours / nominalFeedTonnesPerHour[line]),
      };
    }
    const requestedActualWaterRate = lineIds.reduce(
      (total, line) =>
        total +
        requestedWaterByLine[line].scrubber +
        requestedWaterByLine[line].screen +
        requestedWaterByLine[line].medium,
      0,
    );
    const makeupRate = Math.min(
      makeupCapacityRate,
      Math.max(0, requestedActualWaterRate - returnedWaterRate),
    );
    const makeupVolume = makeupRate * stepHours;
    const requestedWaterVolume = requestedActualWaterRate * stepHours;
    const deliveredWaterVolume = Math.min(
      requestedWaterVolume,
      this.waterTankM3 + returnedWaterVolume + makeupVolume,
    );
    const waterDeliveryFactor =
      requestedWaterVolume > 0 ? deliveredWaterVolume / requestedWaterVolume : 1;
    const waterTankBeforeOverflow =
      this.waterTankM3 + returnedWaterVolume + makeupVolume - deliveredWaterVolume;
    const waterTankOverflow = Math.max(0, waterTankBeforeOverflow - 60);
    this.waterTankM3 = waterTankBeforeOverflow - waterTankOverflow;

    const flows = new Map<string, number>();
    let finesSolidsTonnes = 0;
    let effluentSolidsTonnes = 0;
    let mediumTailingsTonnes = 0;
    let sorterRejectTonnes = 0;
    let productTonnes = 0;
    let thickenerWaterInputM3 = 0;
    let processWaterLossM3 = 0;
    let mediumMakeupM3 = 0;
    let mediumLossM3 = 0;

    for (const line of lineIds) {
      const state = this.lines[line];
      const dispatchTonnes = dispatchedByLineTonnes[line];
      const crusherTonnes = advanceDelay(state.crushTransitTonnes, dispatchTonnes);
      const washedTonnes = advanceDelay(state.washTransitTonnes, crusherTonnes);
      const finesTonnes = washedTonnes * 0.02;
      const sizedTonnes = washedTonnes - finesTonnes;
      const dmsTonnes = advanceDelay(state.dmsTransitTonnes, sizedTonnes);
      const sinksTonnes = dmsTonnes * 0.68;
      const floatsTonnes = dmsTonnes - sinksTonnes;
      const mediumTonnes = advanceDelay(state.mediumTransitTonnes, sinksTonnes + floatsTonnes);
      const concentrateTonnes = mediumTonnes * 0.18;
      const washedTailingsTonnes = mediumTonnes * 0.8;
      const effluentTonnes = mediumTonnes - concentrateTonnes - washedTailingsTonnes;
      const sorterTonnes = advanceDelay(state.sorterTransitTonnes, concentrateTonnes);
      const recoveredProductTonnes = sorterTonnes * 0.001;
      const sorterReject = sorterTonnes - recoveredProductTonnes;

      addFlow(flows, `process-${line}-feed`, "dry_solids_mass_flow", dispatchTonnes);
      addFlow(flows, `process-${line}-crush`, "dry_solids_mass_flow", crusherTonnes);
      addFlow(flows, `process-${line}-wash`, "dry_solids_mass_flow", washedTonnes);
      addFlow(flows, `process-${line}-size`, "dry_solids_mass_flow", sizedTonnes);
      addFlow(flows, `process-${line}-sinks`, "dry_solids_mass_flow", sinksTonnes);
      addFlow(flows, `process-${line}-floats`, "dry_solids_mass_flow", floatsTonnes);
      addFlow(flows, `process-${line}-concentrate`, "dry_solids_mass_flow", concentrateTonnes);
      addFlow(flows, `process-${line}-reject`, "dry_solids_mass_flow", washedTailingsTonnes);
      addFlow(flows, `process-${line}-sorter-reject`, "dry_solids_mass_flow", sorterReject);
      addFlow(flows, `process-${line}-product`, "dry_solids_mass_flow", recoveredProductTonnes);
      addFlow(flows, `utility-${line}-fines`, "dry_solids_mass_flow", finesTonnes);
      addFlow(flows, `utility-${line}-effluent`, "dry_solids_mass_flow", effluentTonnes);

      const branchWater = requestedWaterByLine[line];
      const scrubberWater = branchWater.scrubber * waterDeliveryFactor;
      const screenWater = branchWater.screen * waterDeliveryFactor;
      const mediumWater = branchWater.medium * waterDeliveryFactor;
      const finesWater = screenWater * 0.08;
      const effluentWater = scrubberWater * 0.85 + screenWater * 0.92 + mediumWater * 0.5;
      const sentToThickenerRate = finesWater + effluentWater;
      const lossRate = scrubberWater + screenWater + mediumWater - sentToThickenerRate;
      addFlow(flows, `utility-${line}-fines`, "water_volume_flow", finesWater * stepHours);
      addFlow(flows, `utility-${line}-effluent`, "water_volume_flow", effluentWater * stepHours);
      addFlow(
        flows,
        `utility-${line}-scrubber-water`,
        "water_volume_flow",
        scrubberWater * stepHours,
      );
      addFlow(flows, `utility-${line}-screen-water`, "water_volume_flow", screenWater * stepHours);
      addFlow(flows, `utility-${line}-medium-water`, "water_volume_flow", mediumWater * stepHours);
      thickenerWaterInputM3 += sentToThickenerRate * stepHours;
      processWaterLossM3 += lossRate * stepHours;

      const mediumRate = (mediumTonnes / stepHours) * 2;
      const mediumLossRate = mediumRate * 0.005;
      const mediumMakeupRate = mediumLossRate;
      const mediumMakeup = mediumMakeupRate * stepHours;
      const mediumLoss = mediumLossRate * stepHours;
      state.mediumInventoryM3 += mediumMakeup - mediumLoss;
      mediumMakeupM3 += mediumMakeup;
      mediumLossM3 += mediumLoss;
      addFlow(
        flows,
        `utility-${line}-medium-recycle`,
        "medium_volume_flow",
        mediumRate * stepHours,
      );

      finesSolidsTonnes += finesTonnes;
      effluentSolidsTonnes += effluentTonnes;
      mediumTailingsTonnes += washedTailingsTonnes;
      sorterRejectTonnes += sorterReject;
      productTonnes += recoveredProductTonnes;
    }

    const thickenerInputSolidsTonnes = finesSolidsTonnes + effluentSolidsTonnes;
    const thickenerUnderflowSolidsTonnes = advanceDelay(
      this.thickenerSolidsTransitTonnes,
      thickenerInputSolidsTonnes,
    );
    const thickenerWaterOutputM3 = advanceDelay(
      this.thickenerWaterTransitM3,
      thickenerWaterInputM3,
    );
    const tailingsUnderflowWaterM3 = thickenerWaterOutputM3 * 0.25;
    const recoveredWaterM3 = thickenerWaterOutputM3 - tailingsUnderflowWaterM3;
    const tailingsInputTonnes =
      mediumTailingsTonnes + sorterRejectTonnes + thickenerUnderflowSolidsTonnes;
    const tailingsBeforeOverflow = this.tailingsTonnes + tailingsInputTonnes;
    const tailingsOverflowTonnes = Math.max(0, tailingsBeforeOverflow - tailingsCapacityTonnes);
    this.tailingsTonnes = tailingsBeforeOverflow - tailingsOverflowTonnes;
    this.returnWaterTransitM3.push(recoveredWaterM3);

    addFlow(flows, "utility-water-return", "water_volume_flow", returnedWaterVolume);
    addFlow(
      flows,
      "utility-thickener-underflow",
      "dry_solids_mass_flow",
      thickenerUnderflowSolidsTonnes,
    );
    addFlow(flows, "utility-thickener-underflow", "water_volume_flow", tailingsUnderflowWaterM3);

    const closingDryInventory =
      this.hopperTonnes +
      queueInventory(this.lines, "crushTransitTonnes") +
      queueInventory(this.lines, "washTransitTonnes") +
      queueInventory(this.lines, "dmsTransitTonnes") +
      queueInventory(this.lines, "mediumTransitTonnes") +
      queueInventory(this.lines, "sorterTransitTonnes") +
      sum(this.thickenerSolidsTransitTonnes) +
      this.tailingsTonnes;
    const closingWaterInventory =
      this.waterTankM3 + sum(this.thickenerWaterTransitM3) + sum(this.returnWaterTransitM3);
    const closingMediumInventory = lineIds.reduce(
      (total, line) => total + this.lines[line].mediumInventoryM3,
      0,
    );

    const balance: D01ConnectionBalance = {
      dry_solids: {
        opening_inventory_tonnes: openingDryInventory,
        external_input_tonnes: externalFeedTonnes,
        hopper_spill_tonnes: hopper.spill,
        recovered_product_tonnes: productTonnes,
        tailings_overflow_tonnes: tailingsOverflowTonnes,
        closing_inventory_tonnes: closingDryInventory,
        residual_tonnes:
          openingDryInventory +
          externalFeedTonnes -
          hopper.spill -
          productTonnes -
          tailingsOverflowTonnes -
          closingDryInventory,
      },
      water: {
        opening_inventory_m3: openingWaterInventory,
        makeup_m3: makeupVolume,
        process_loss_m3: processWaterLossM3,
        tailings_underflow_m3: tailingsUnderflowWaterM3,
        tank_overflow_m3: waterTankOverflow,
        closing_inventory_m3: closingWaterInventory,
        residual_m3:
          openingWaterInventory +
          makeupVolume -
          processWaterLossM3 -
          tailingsUnderflowWaterM3 -
          waterTankOverflow -
          closingWaterInventory,
      },
      medium: {
        opening_inventory_m3: openingMediumInventory,
        makeup_m3: mediumMakeupM3,
        modeled_loss_m3: mediumLossM3,
        closing_inventory_m3: closingMediumInventory,
        residual_m3:
          openingMediumInventory + mediumMakeupM3 - mediumLossM3 - closingMediumInventory,
      },
    };
    assertBalance(balance);

    const missingMeasurementTagIds =
      this.scenario === "missing-sensor" && this.elapsedSeconds >= 180 && this.elapsedSeconds < 360
        ? [missingScenarioTagId]
        : [];
    const missing = new Set(missingMeasurementTagIds);
    const observations: D01ConnectionMeasurementEvent[] = [];
    for (const binding of bindings) {
      if (missing.has(binding.measurement_tag_id)) continue;
      const sequence = ++this.sequence;
      const event: D01ConnectionMeasurementEvent = {
        entityType: "ConnectionMeasurement",
        schema_version: 1,
        run_id: this.runId,
        event_id: createD01ConnectionEventId(this.runId, sequence),
        sequence,
        sample_time: sampleTime,
        sample_interval_seconds: 5,
        plant_id: D01_PLANT_ID,
        catalog_version: binding.catalog_version,
        measurement_catalog_version: binding.measurement_catalog_version,
        profile_version: binding.profile_version,
        stream_id: binding.stream_id,
        measurement_tag_id: binding.measurement_tag_id,
        source_module_id: binding.source.module_id,
        source_port_id: binding.source.port_id,
        source_equipment_id: binding.source.equipment_id,
        source_equipment_port_id: binding.source.equipment_port_id,
        target_module_id: binding.target.module_id,
        target_port_id: binding.target.port_id,
        target_equipment_id: binding.target.equipment_id,
        target_equipment_port_id: binding.target.equipment_port_id,
        quantity: binding.quantity,
        basis: binding.basis,
        value: roundObservationRate(flowValue(flows, binding)),
        unit: binding.unit,
        quality: "good",
        origin: binding.origin,
      };
      assertD01ConnectionMeasurementEvent(event);
      observations.push(event);
    }
    const legacyNumericEvents = this.createLegacyNumericEvents(sampleTime, flows, actualFeedRates);
    const legacyStateEvents = this.createLegacyStateEvents(sampleTime);
    const legacyTransportEvents = [
      ...legacyStateEvents.map((event) => toD01TransportBody(event)),
      ...legacyNumericEvents.map((event) => toD01TransportBody(event)),
    ].sort((left, right) => left.sequence - right.sequence);
    const expectedLegacyEventCount = projectedLegacyTags.filter(
      (tag) => this.elapsedSeconds % getD01TagIntervalSeconds(tag) === 0,
    ).length;
    if (observations.length > D01_CONNECTION_MAX_BATCH_EVENTS) {
      throw new Error("D01 connection sample exceeds the supported transport batch size.");
    }
    const batch: D01ConnectionObservationBatch = {
      batch_id: createD01ConnectionBatchId(this.runId, sampleTime),
      sample_time: sampleTime,
      sample_interval_seconds: stepSeconds,
      // One transport batch is one unchanged five-second sample, never an average.
      events: observations.map((event) => ({ ...event })),
    };
    const boundaryFlows: D01ConnectionBoundaryFlow[] = [
      makeBoundary("external-ore-feed", "in", "dry_solids_mass_flow", externalFeedTonnes, "t/h"),
      makeBoundary("hopper-spill", "out", "dry_solids_mass_flow", hopper.spill, "t/h"),
      makeBoundary("recovered-product", "out", "dry_solids_mass_flow", productTonnes, "t/h"),
      makeBoundary(
        "tailings-overflow",
        "out",
        "dry_solids_mass_flow",
        tailingsOverflowTonnes,
        "t/h",
      ),
      makeBoundary("water-makeup", "in", "water_volume_flow", makeupVolume, "m3/h"),
      makeBoundary("process-water-loss", "out", "water_volume_flow", processWaterLossM3, "m3/h"),
      makeBoundary(
        "tailings-underflow-water",
        "out",
        "water_volume_flow",
        tailingsUnderflowWaterM3,
        "m3/h",
      ),
      makeBoundary("water-tank-overflow", "out", "water_volume_flow", waterTankOverflow, "m3/h"),
      makeBoundary("medium-makeup", "in", "medium_volume_flow", mediumMakeupM3, "m3/h"),
      makeBoundary("medium-loss", "out", "medium_volume_flow", mediumLossM3, "m3/h"),
    ];
    const inventory: D01ConnectionInventory = {
      hopper_tonnes: this.hopperTonnes,
      in_transit_solids_tonnes: closingDryInventory - this.hopperTonnes - this.tailingsTonnes,
      tailings_tonnes: this.tailingsTonnes,
      water_tank_m3: this.waterTankM3,
      in_transit_water_m3: sum(this.thickenerWaterTransitM3) + sum(this.returnWaterTransitM3),
      ferrosilicon_medium_m3: closingMediumInventory,
    };

    return {
      elapsed_seconds: this.elapsedSeconds,
      sample_time: sampleTime,
      lifecycle_phase: this.lifecyclePhase(),
      observations,
      batch,
      expected_observation_count: bindings.length,
      expected_total_observation_count: this.expectedObservationCountForRun,
      emitted_observation_count: observations.length,
      missing_measurement_tag_ids: missingMeasurementTagIds,
      legacy_numeric_events: legacyNumericEvents,
      legacy_projection_profile_version: D01_LEGACY_FLOW_PROJECTION_PROFILE_VERSION,
      expected_legacy_event_count: expectedLegacyEventCount,
      emitted_legacy_event_count: legacyNumericEvents.length,
      unprojected_legacy_tag_ids: [...unprojectedLegacyTagIds],
      legacy_state_events: legacyStateEvents,
      legacy_transport_events: legacyTransportEvents,
      inventory,
      boundary_flows: boundaryFlows,
      balance,
      completed: this.elapsedSeconds === this.durationSeconds,
    };
  }

  private lifecyclePhase(): D01ConnectionLifecyclePhase {
    if (this.elapsedSeconds >= this.durationSeconds) return "stopped";
    if (this.shutdownAtSeconds !== null && this.elapsedSeconds > this.shutdownAtSeconds) {
      return "draining";
    }
    return this.elapsedSeconds < 60 ? "starting" : "running";
  }

  private projectLegacyTag(
    tag: D01TelemetryTag,
    flows: ReadonlyMap<string, number>,
    actualFeedRates: Readonly<Record<LineId, number>>,
  ): number {
    const parts = tag.module_id.split(".");
    const line = parts[1] as LineId | "shared";
    const moduleKind = parts.at(-1) ?? "";
    const totalFeed = sum(Object.values(actualFeedRates));
    const throughputRatio = totalFeed / 126;
    const lineLoad =
      line === "shared" ? throughputRatio : actualFeedRates[line] / nominalFeedTonnesPerHour[line];
    const flowRate = (streamId: string, quantity: D01ConnectionQuantity): number =>
      flows.get(bindingKey(streamId, quantity)) ?? 0;
    const sharedWaterRate = lineIds.reduce(
      (total, lineId) =>
        total +
        flowRate(`utility-${lineId}-scrubber-water`, "water_volume_flow") +
        flowRate(`utility-${lineId}-screen-water`, "water_volume_flow") +
        flowRate(`utility-${lineId}-medium-water`, "water_volume_flow"),
      0,
    );
    const powerTarget =
      35 +
      180 *
        (lineIds.reduce(
          (total, lineId) => total + actualFeedRates[lineId] / nominalFeedTonnesPerHour[lineId],
          0,
        ) /
          3);

    switch (tag.metric) {
      case "motor_current": {
        if (tag.module_id === "D01.shared.thickener") return 18 + 18 * throughputRatio;
        const base = idleCurrents[moduleKind] ?? 4;
        return base + (motorLoadMultipliers[moduleKind] ?? 20) * lineLoad;
      }
      case "bearing_temperature":
        return 48 + 14 * lineLoad;
      case "vibration_rms":
        return 1.1 + 1.9 * lineLoad;
      case "ore_flow":
        if (tag.module_id.endsWith(".sorter")) {
          return flowRate(`process-${line}-concentrate`, "dry_solids_mass_flow");
        }
        if (tag.module_id === "D01.shared.hopper") {
          return lineIds.reduce(
            (total, lineId) => total + flowRate(`process-${lineId}-feed`, "dry_solids_mass_flow"),
            0,
          );
        }
        return flowRate(`process-${line}-feed`, "dry_solids_mass_flow");
      case "water_flow":
        if (tag.module_id.endsWith(".scrubber")) {
          return flowRate(`utility-${line}-scrubber-water`, "water_volume_flow");
        }
        if (tag.module_id.endsWith(".screen")) {
          return flowRate(`utility-${line}-screen-water`, "water_volume_flow");
        }
        if (tag.module_id === "D01.shared.water") return sharedWaterRate;
        if (tag.module_id === "D01.shared.thickener") {
          return flowRate("utility-thickener-underflow", "water_volume_flow");
        }
        break;
      case "feed_pressure": {
        if (line === "shared") break;
        const dmsFeed = flowRate(`process-${line}-size`, "dry_solids_mass_flow");
        return dmsFeed <= 0 ? 0 : 200 + (100 * dmsFeed) / nominalFeedTonnesPerHour[line];
      }
      case "level":
        if (tag.module_id === "D01.shared.hopper") {
          return (this.hopperTonnes / hopperCapacityTonnes) * 100;
        }
        if (tag.module_id === "D01.shared.water") return (this.waterTankM3 / 60) * 100;
        if (tag.module_id === "D01.shared.tailings") {
          return (this.tailingsTonnes / tailingsCapacityTonnes) * 100;
        }
        break;
      case "power":
        return powerTarget;
      case "medium_density":
      case "product_mass":
        break;
      default:
        throw new Error(`Unsupported D01 legacy metric '${tag.metric}'.`);
    }
    throw new Error(
      `D01 legacy tag '${tag.id}' is not honestly projectable from the shared flow state.`,
    );
  }

  private createLegacyNumericEvents(
    timestamp: string,
    flows: ReadonlyMap<string, number>,
    actualFeedRates: Readonly<Record<LineId, number>>,
  ): D01NumericTelemetryEvent[] {
    const events: D01NumericTelemetryEvent[] = [];
    for (const tag of projectedLegacyTags) {
      const value = this.projectLegacyTag(tag, flows, actualFeedRates);
      if (!Number.isFinite(value)) {
        throw new RangeError(`D01 legacy projection for '${tag.id}' is non-finite.`);
      }
      const samples = this.legacyWindows.get(tag.id);
      if (!samples) throw new Error(`Missing shared-flow legacy window for '${tag.id}'.`);
      samples.push(value);
      if (samples.length > 12) samples.shift();

      const interval = getD01TagIntervalSeconds(tag);
      if (this.elapsedSeconds % interval !== 0) continue;
      const window = samples.slice(-interval / stepSeconds);
      if (window.length !== interval / stepSeconds) {
        throw new Error(`Incomplete shared-flow legacy window for '${tag.id}'.`);
      }
      const event: D01NumericTelemetryEvent = {
        schema_version: 2,
        run_id: this.runId,
        event_id: createD01EventId(this.runId, ++this.legacySequence),
        sequence: this.legacySequence,
        interval_seconds: interval,
        timestamp,
        plant_id: D01_PLANT_ID,
        module_id: tag.module_id,
        equipment_id: tag.equipment_id,
        tag_id: tag.id,
        value: Math.round((sum(window) / window.length) * 10_000) / 10_000,
        unit: tag.unit,
        quality: "good",
      };
      assertD01NumericTelemetryEvent(event);
      events.push(event);
    }
    return events;
  }

  private createLegacyStateEvents(timestamp: string): D01PlantStateEvent[] {
    const events: D01PlantStateEvent[] = [];
    if (this.elapsedSeconds === 60) {
      for (const scope of legacyScopes) {
        this.legacyStates.set(scope, "running");
        events.push(this.createLegacyStateEvent(scope, "running", true, timestamp));
      }
    }
    if (this.elapsedSeconds % 60 === 0) {
      for (const scope of legacyScopes) {
        events.push(
          this.createLegacyStateEvent(
            scope,
            this.legacyStates.get(scope) ?? "starting",
            true,
            timestamp,
          ),
        );
      }
    }
    if (this.elapsedSeconds === this.durationSeconds) {
      for (const scope of legacyScopes) {
        this.legacyStates.set(scope, "stopped");
        events.push(this.createLegacyStateEvent(scope, "stopped", false, timestamp));
      }
    }
    return events;
  }

  private createLegacyStateEvent(
    scopeId: D01StateScope,
    state: "starting" | "running" | "stopped",
    scheduledRunning: boolean,
    timestamp: string,
  ): D01PlantStateEvent {
    const sequence = ++this.legacySequence;
    const event: D01PlantStateEvent = {
      schema_version: 2,
      run_id: this.runId,
      event_id: createD01EventId(this.runId, sequence),
      sequence,
      timestamp,
      plant_id: D01_PLANT_ID,
      scope_id: scopeId,
      scheduled_running: scheduledRunning,
      state,
    };
    assertD01PlantStateEvent(event);
    return event;
  }

  private createLineState(): LineState {
    return {
      crushTransitTonnes: Array<number>(delaySteps).fill(0),
      washTransitTonnes: Array<number>(delaySteps).fill(0),
      dmsTransitTonnes: Array<number>(delaySteps).fill(0),
      mediumTransitTonnes: Array<number>(delaySteps).fill(0),
      sorterTransitTonnes: Array<number>(delaySteps).fill(0),
      mediumInventoryM3: 25,
    };
  }
}

export function createD01ConnectionSimulation(
  options: CreateD01ConnectionSimulationOptions,
  now?: () => number,
): D01ConnectionFlowSimulator {
  return new D01ConnectionFlowSimulator(options, now);
}

export interface CreateD01SharedFlowSimulationOptions extends Omit<
  CreateD01ConnectionSimulationOptions,
  "durationSeconds"
> {
  shutdownAtSeconds: number;
  durationSeconds: number;
}

/**
 * Create the explicitly versioned one-source run. It emits raw connection
 * samples and separate legacy-shaped projections from the same five-second
 * process state, and requires enough time to drain all modeled transit queues.
 */
export function createD01SharedFlowSimulation(
  options: CreateD01SharedFlowSimulationOptions,
  now?: () => number,
): D01ConnectionFlowSimulator {
  return new D01ConnectionFlowSimulator(options, now);
}
