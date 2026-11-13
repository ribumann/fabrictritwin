import { D01_PLANT_CATALOG, D01_PLANT_ID, getD01TagIntervalSeconds } from "./catalog.js";
import type {
  D01StateScope,
  D01AlertTransition,
  D01NumericTelemetryEvent,
  D01PlantStateEvent,
  D01TransportBody,
} from "./events.js";
import {
  assertD01AlertTransition,
  assertD01NumericTelemetryEvent,
  createD01AlertTransitionId,
  createD01BatchId,
  createD01EventId,
  toD01TransportBody,
} from "./events.js";

export type D01Scenario =
  "normal" | "bearing-b" | "dms-c" | "shared-water-restriction" | "communication-gap";

export interface CreateD01SimulationOptions {
  runId: string;
  startedAt: Date;
  seed?: number;
  scenario?: D01Scenario;
  durationSeconds?: number;
}

export interface D01SimulationBatch {
  batch_id: string;
  timestamp: string;
  events: readonly D01TransportBody[];
  /** Simulator-only diagnostics; not part of the transport events or operational incidents. */
  alert_transitions: readonly D01AlertTransition[];
}

export interface D01SimulationStep {
  elapsed_seconds: number;
  timestamp: string;
  numeric_events: readonly D01NumericTelemetryEvent[];
  state_events: readonly D01PlantStateEvent[];
  /** Simulator-only diagnostics; not authoritative operational incidents. */
  alert_transitions: readonly D01AlertTransition[];
  batch: D01SimulationBatch | null;
  completed: boolean;
}

export interface D01InventorySnapshot {
  hopper_tonnes: number;
  water_m3: number;
  tailings_tonnes: number;
  product_sample_g: number;
}

interface LineState {
  nominal_feed_tph: number;
  current_feed_tph: number;
  crusher_discharge_delay: number[];
  dms_feed_delay: number[];
  sorter_feed_delay: number[];
}

type WaterStage = "normal" | "restricted" | "ramping" | "holding" | "recovering";

const stepSeconds = 5;
const defaultDurationSeconds = 20 * 60;
const maximumDurationSeconds = 30 * 60;
const scopeIds: readonly D01StateScope[] = ["A", "B", "C", "shared"];
const nominalFeeds: Record<"A" | "B" | "C", number> = { A: 42, B: 44, C: 40 };
const idleCurrents: Record<string, number> = {
  crusher: 6,
  scrubber: 8,
  screen: 2,
  dms: 6,
  medium: 4,
  sorter: 3,
  thickener: 18,
};

function assertValidRunOptions(options: CreateD01SimulationOptions): void {
  if (options.runId.trim().length === 0) {
    throw new TypeError("runId must not be empty.");
  }
  if (!(options.startedAt instanceof Date) || Number.isNaN(options.startedAt.valueOf())) {
    throw new TypeError("startedAt must be a valid Date.");
  }
  if (options.startedAt.valueOf() > Date.now()) {
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
  if (
    options.seed !== undefined &&
    (!Number.isSafeInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff)
  ) {
    throw new RangeError("seed must be an unsigned 32-bit integer.");
  }
  if (
    options.scenario !== undefined &&
    !["normal", "bearing-b", "dms-c", "shared-water-restriction", "communication-gap"].includes(
      options.scenario,
    )
  ) {
    throw new TypeError(`Unsupported D01 scenario '${String(options.scenario)}'.`);
  }
}

function roundValue(value: number): number {
  const rounded = Math.round(value * 10000) / 10000;
  if (!Number.isFinite(rounded)) {
    throw new RangeError("The D01 process model produced a non-finite value.");
  }
  return rounded;
}

function copyBatch(batch: D01SimulationBatch): D01SimulationBatch {
  return {
    batch_id: batch.batch_id,
    timestamp: batch.timestamp,
    events: batch.events.map((event) => ({ ...event })),
    alert_transitions: batch.alert_transitions.map((event) => ({
      ...event,
      evidence: { ...event.evidence },
    })),
  };
}

export class D01PlantSimulator {
  readonly runId: string;
  readonly seed: number;
  readonly scenario: D01Scenario;
  readonly startedAt: Date;
  readonly durationSeconds: number;

  private elapsedSeconds = 0;
  private sequence = 0;
  private readonly randomStates = new Map<string, number>();
  private readonly values = new Map<string, number>();
  private readonly windows = new Map<string, number[]>();
  private readonly pendingBodies: D01TransportBody[] = [];
  private readonly pendingAlerts: D01AlertTransition[] = [];
  private readonly currentStates = new Map<
    D01StateScope,
    "starting" | "running" | "idle" | "stopped" | "fault"
  >();
  private readonly lines: Record<"A" | "B" | "C", LineState>;
  private readonly waterReturnDelay: number[];
  private lastBatch: D01SimulationBatch | null = null;
  private hopperTonnes = 780;
  private waterVolumeM3 = 39;
  private tailingsTonnes = 3600;
  private productSampleGrams = 0;
  private waterStage: WaterStage = "normal";
  private waterStageElapsedSeconds = 0;
  private waterSupplyFactor = 1;
  private totalWaterDemand = 0;
  private totalWaterDelivered = 0;
  private totalFeed = 0;
  private sharedDisturbance = 0;
  private thickenerLevelPercent = 55;
  private readonly activeAlerts = new Set<string>();
  private lastDmsTelemetryElapsedSeconds = 0;
  private lastDmsTelemetryTimestamp = "";

  constructor(options: CreateD01SimulationOptions) {
    assertValidRunOptions(options);
    this.runId = options.runId;
    this.seed = options.seed ?? 1;
    this.scenario = options.scenario ?? "normal";
    this.startedAt = new Date(options.startedAt.valueOf());
    this.durationSeconds = options.durationSeconds ?? defaultDurationSeconds;
    this.lines = {
      A: {
        nominal_feed_tph: nominalFeeds.A,
        current_feed_tph: 0,
        crusher_discharge_delay: Array(6).fill(0),
        dms_feed_delay: Array(6).fill(0),
        sorter_feed_delay: Array(6).fill(0),
      },
      B: {
        nominal_feed_tph: nominalFeeds.B,
        current_feed_tph: 0,
        crusher_discharge_delay: Array(6).fill(0),
        dms_feed_delay: Array(6).fill(0),
        sorter_feed_delay: Array(6).fill(0),
      },
      C: {
        nominal_feed_tph: nominalFeeds.C,
        current_feed_tph: 0,
        crusher_discharge_delay: Array(6).fill(0),
        dms_feed_delay: Array(6).fill(0),
        sorter_feed_delay: Array(6).fill(0),
      },
    };
    this.waterReturnDelay = Array(18).fill(0);
    this.initializeSignals();

    for (const scopeId of scopeIds) {
      this.currentStates.set(scopeId, "starting");
      this.pendingBodies.push(
        toD01TransportBody(
          this.createStateEvent(scopeId, "starting", true, this.startedAt.toISOString()),
        ),
      );
    }
  }

  get elapsedSecondsSoFar(): number {
    return this.elapsedSeconds;
  }

  get inventory(): D01InventorySnapshot {
    return {
      hopper_tonnes: roundValue(this.hopperTonnes),
      water_m3: roundValue(this.waterVolumeM3),
      tailings_tonnes: roundValue(this.tailingsTonnes),
      product_sample_g: roundValue(this.productSampleGrams),
    };
  }

  getPendingBatch(): D01SimulationBatch | null {
    return this.lastBatch ? copyBatch(this.lastBatch) : null;
  }

  acknowledgeBatch(batchId: string): void {
    if (!this.lastBatch || this.lastBatch.batch_id !== batchId) {
      throw new Error("Cannot acknowledge a D01 batch that is not pending.");
    }
    this.lastBatch = null;
  }

  step(at: Date): D01SimulationStep {
    if (this.elapsedSeconds >= this.durationSeconds) {
      throw new Error("The D01 simulation has completed.");
    }
    if (this.lastBatch) {
      throw new Error(
        `D01 batch '${this.lastBatch.batch_id}' must be acknowledged before advancing.`,
      );
    }
    const nextElapsedSeconds = this.elapsedSeconds + stepSeconds;
    const expectedTime = this.startedAt.valueOf() + nextElapsedSeconds * 1000;
    if (!(at instanceof Date) || Number.isNaN(at.valueOf()) || at.valueOf() !== expectedTime) {
      throw new RangeError("D01 steps must be supplied at exact 5-second UTC intervals.");
    }
    if (expectedTime > Date.now()) {
      throw new RangeError("A D01 step cannot emit a future timestamp.");
    }

    this.elapsedSeconds = nextElapsedSeconds;
    const timestamp = new Date(expectedTime).toISOString();
    const stateEvents: D01PlantStateEvent[] = [];
    const alertTransitions: D01AlertTransition[] = [];
    this.applyScenarioTransitions(timestamp, stateEvents);
    this.advanceProcessModel();
    const numericEvents = this.createDueTelemetry(timestamp);
    alertTransitions.push(...this.evaluateAlerts(timestamp, numericEvents));
    stateEvents.push(...this.createStateEvents(timestamp));
    if (this.elapsedSeconds === this.durationSeconds) {
      for (const scopeId of scopeIds) {
        const event = this.setState(scopeId, "stopped", false, timestamp);
        if (event) {
          stateEvents.push(event);
        }
      }
    }

    const events = [
      ...stateEvents.map((event) => toD01TransportBody(event)),
      ...numericEvents.map((event) => toD01TransportBody(event)),
    ].sort((left, right) => left.sequence - right.sequence);
    this.pendingBodies.push(...events);
    this.pendingAlerts.push(...alertTransitions);

    let batch: D01SimulationBatch | null = null;
    if (this.elapsedSeconds % 30 === 0 || this.elapsedSeconds === this.durationSeconds) {
      batch = {
        batch_id: createD01BatchId(this.runId, this.elapsedSeconds),
        timestamp,
        events: this.pendingBodies.map((event) => ({ ...event })),
        alert_transitions: this.pendingAlerts.map((event) => ({
          ...event,
          evidence: { ...event.evidence },
        })),
      };
      this.pendingBodies.length = 0;
      this.pendingAlerts.length = 0;
      this.lastBatch = copyBatch(batch);
    }

    return {
      elapsed_seconds: this.elapsedSeconds,
      timestamp,
      numeric_events: numericEvents,
      state_events: stateEvents,
      alert_transitions: alertTransitions,
      batch,
      completed: this.elapsedSeconds === this.durationSeconds,
    };
  }

  private initializeSignals(): void {
    for (const tag of D01_PLANT_CATALOG.telemetry_tags) {
      let value = 0;
      if (tag.metric === "motor_current") {
        const kind = tag.module_id.split(".").at(-1) ?? "";
        value = idleCurrents[kind] ?? 4;
      } else if (tag.metric === "bearing_temperature") {
        value = 45;
      } else if (tag.metric === "vibration_rms") {
        value = 1;
      } else if (tag.metric === "medium_density") {
        value = 2920;
      } else if (tag.metric === "level") {
        if (tag.module_id === "D01.shared.hopper") {
          value = (this.hopperTonnes / 1200) * 100;
        } else if (tag.module_id === "D01.shared.water") {
          value = (this.waterVolumeM3 / 60) * 100;
        } else if (tag.module_id === "D01.shared.tailings") {
          value = (this.tailingsTonnes / 8000) * 100;
        } else if (tag.module_id === "D01.shared.thickener") {
          value = this.thickenerLevelPercent;
        } else {
          value = 62;
        }
      } else if (tag.metric === "power") {
        value = 35;
      }
      this.values.set(tag.id, value);
      this.windows.set(tag.id, []);
    }
  }

  private random(key: string): number {
    let value = this.randomStates.get(key);
    if (value === undefined) {
      value = this.seed ^ 0x9e3779b9;
      for (const character of key) {
        value = Math.imul(value ^ character.charCodeAt(0), 0x45d9f3b);
      }
      this.randomStates.set(key, value >>> 0);
    }
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    this.randomStates.set(key, value);
    return value / 0x100000000;
  }

  private delayed(values: number[], value: number): number {
    values.push(value);
    return values.shift() ?? 0;
  }

  private advanceValue(
    tagId: string,
    target: number,
    responseSeconds: number,
    noiseRatio: number,
  ): number {
    const previous = this.values.get(tagId);
    if (previous === undefined) {
      throw new Error(`Missing initialized D01 signal '${tagId}'.`);
    }
    if (!Number.isFinite(target)) {
      throw new RangeError(`D01 target for '${tagId}' is non-finite.`);
    }
    const alpha = stepSeconds / (responseSeconds + stepSeconds);
    const noise = (this.random(tagId) * 2 - 1) * Math.abs(target) * noiseRatio;
    const result = roundValue(previous + alpha * (target - previous) + noise);
    this.values.set(tagId, result);
    const samples = this.windows.get(tagId);
    if (!samples) {
      throw new Error(`Missing D01 sampling window for '${tagId}'.`);
    }
    samples.push(result);
    if (samples.length > 12) {
      samples.shift();
    }
    return result;
  }

  private advanceProcessModel(): void {
    const startupFactor = Math.min(this.elapsedSeconds / 60, 1);
    const waterThrottle = this.waterThrottle();
    const feedFactor = startupFactor * waterThrottle * this.waterSupplyFactor;
    const lineDischarges: Record<"A" | "B" | "C", number> = { A: 0, B: 0, C: 0 };
    const lineDmsFeeds: Record<"A" | "B" | "C", number> = { A: 0, B: 0, C: 0 };
    const lineSorterFeeds: Record<"A" | "B" | "C", number> = { A: 0, B: 0, C: 0 };
    const lineLoads: Record<"A" | "B" | "C", number> = { A: 0, B: 0, C: 0 };
    let feedTotal = 0;

    for (const line of ["A", "B", "C"] as const) {
      const state = this.lines[line];
      let scenarioFactor = 1;
      if (
        line === "B" &&
        this.scenario === "bearing-b" &&
        this.elapsedSeconds >= 300 &&
        this.elapsedSeconds < 900
      ) {
        scenarioFactor = 0.78;
      }
      const sharedNoise = (this.random(`feed-${line}`) * 2 - 1) * 0.025 + this.sharedDisturbance;
      const feedTarget = state.nominal_feed_tph * feedFactor * scenarioFactor * (1 + sharedNoise);
      state.current_feed_tph = this.advanceValue(
        `D01.${line}.crusher.ore_flow`,
        feedTarget,
        35,
        0.006,
      );
      lineLoads[line] = state.current_feed_tph / state.nominal_feed_tph;
      lineDischarges[line] = this.delayed(state.crusher_discharge_delay, state.current_feed_tph);
      lineDmsFeeds[line] = this.delayed(state.dms_feed_delay, lineDischarges[line]);
      lineSorterFeeds[line] = this.delayed(state.sorter_feed_delay, lineDmsFeeds[line]);
      feedTotal += state.current_feed_tph;
    }
    this.totalFeed = feedTotal;
    this.hopperTonnes = Math.min(
      1200,
      Math.max(0, this.hopperTonnes + ((132 - feedTotal) * stepSeconds) / 3600),
    );

    const waterDemandByLine: Record<"A" | "B" | "C", { scrubber: number; screen: number }> = {
      A: { scrubber: lineLoads.A * 55, screen: lineLoads.A * 22 },
      B: { scrubber: lineLoads.B * 55, screen: lineLoads.B * 22 },
      C: { scrubber: lineLoads.C * 55, screen: lineLoads.C * 22 },
    };
    const demand = Object.values(waterDemandByLine).reduce(
      (sum, flow) => sum + flow.scrubber + flow.screen,
      40,
    );
    const restrictedReturn =
      this.waterStage === "restricted" ||
      this.waterStage === "ramping" ||
      this.waterStage === "holding";
    const returnedWater = this.delayed(
      this.waterReturnDelay,
      demand * (restrictedReturn ? 0.25 : 0.65),
    );
    const desiredMakeup = Math.max(0, demand - returnedWater + (35 - this.waterVolumeM3) * 1.5);
    const makeupCapacity =
      this.waterStage === "restricted" ||
      this.waterStage === "ramping" ||
      this.waterStage === "holding"
        ? 0
        : 180;
    const makeupWater = Math.min(desiredMakeup, makeupCapacity);
    const availableFlow = returnedWater + makeupWater + (this.waterVolumeM3 * 3600) / stepSeconds;
    const deliveryFactor = demand > 0 ? Math.min(1, availableFlow / demand) : 1;
    const netWater = demand * deliveryFactor - returnedWater - makeupWater;
    this.waterVolumeM3 = Math.min(
      60,
      Math.max(0, this.waterVolumeM3 - (netWater * stepSeconds) / 3600),
    );
    this.totalWaterDemand = demand;
    this.totalWaterDelivered = demand * deliveryFactor;
    this.waterSupplyFactor = deliveryFactor;

    if (
      this.scenario === "shared-water-restriction" &&
      this.elapsedSeconds >= 180 &&
      this.waterStage === "normal"
    ) {
      this.waterStage = "restricted";
    }
    if (this.waterStage === "restricted" && this.waterVolumeM3 <= 15) {
      this.waterStage = "ramping";
      this.waterStageElapsedSeconds = 0;
    } else if (this.waterStage === "ramping") {
      this.waterStageElapsedSeconds += stepSeconds;
      if (this.waterStageElapsedSeconds >= 60) {
        this.waterStage = "holding";
        this.waterStageElapsedSeconds = 0;
      }
    } else if (this.waterStage === "holding") {
      this.waterStageElapsedSeconds += stepSeconds;
      if (this.waterStageElapsedSeconds >= 180) {
        this.waterStage = "recovering";
        this.waterStageElapsedSeconds = 0;
      }
    } else if (this.waterStage === "recovering") {
      this.waterStageElapsedSeconds += stepSeconds;
      if (this.waterStageElapsedSeconds >= 60) {
        this.waterStage = "normal";
        this.waterStageElapsedSeconds = 0;
      }
    }

    this.sharedDisturbance += (this.random("plant-disturbance") * 2 - 1) * 0.0015;
    this.sharedDisturbance *= 0.97;
    this.thickenerLevelPercent = Math.min(
      95,
      Math.max(10, this.thickenerLevelPercent + (feedTotal - 126) * 0.0007),
    );
    this.tailingsTonnes = Math.min(
      8000,
      Math.max(0, this.tailingsTonnes + ((feedTotal * 0.82 - 99) * stepSeconds) / 3600),
    );
    this.productSampleGrams += (2.5 * Math.min(1, feedTotal / 126) * stepSeconds) / 5;

    const throughputRatio = feedTotal / 126;
    const totalMotorLoad = Object.values(lineLoads).reduce((sum, load) => sum + load, 0) / 3;
    const powerTarget = 35 + 180 * totalMotorLoad;
    for (const tag of D01_PLANT_CATALOG.telemetry_tags) {
      const parts = tag.module_id.split(".");
      const line = parts[1] as "A" | "B" | "C" | "shared";
      const moduleKind = parts.at(-1) ?? "";
      const lineLoad = line === "shared" ? throughputRatio : lineLoads[line];
      let target: number;

      switch (tag.metric) {
        case "motor_current":
          if (tag.module_id === "D01.shared.control") {
            target = powerTarget * 0.18;
          } else if (tag.module_id === "D01.shared.thickener") {
            target = 18 + 18 * throughputRatio;
          } else {
            const base = idleCurrents[moduleKind] ?? 4;
            const loadMultiplier: Record<string, number> = {
              crusher: 92,
              scrubber: 68,
              screen: 20,
              dms: 54,
              medium: 28,
              sorter: 38,
            };
            target = base + (loadMultiplier[moduleKind] ?? 20) * lineLoad;
          }
          break;
        case "bearing_temperature":
          target = 48 + 14 * lineLoad;
          if (
            this.scenario === "bearing-b" &&
            line === "B" &&
            this.elapsedSeconds >= 300 &&
            this.elapsedSeconds < 900
          ) {
            target = 58 + Math.min(1, (this.elapsedSeconds - 300) / 150) * 33;
          }
          break;
        case "vibration_rms":
          target = 1.1 + 1.9 * lineLoad;
          if (
            this.scenario === "bearing-b" &&
            line === "B" &&
            this.elapsedSeconds >= 300 &&
            this.elapsedSeconds < 900
          ) {
            target = 11;
          }
          break;
        case "ore_flow":
          if (tag.module_id.endsWith(".sorter")) {
            target = lineSorterFeeds[line as "A" | "B" | "C"] ?? 0;
          } else if (tag.module_id === "D01.shared.hopper") {
            target = feedTotal;
          } else {
            target = this.lines[line as "A" | "B" | "C"]?.current_feed_tph ?? 0;
          }
          break;
        case "water_flow":
          if (tag.module_id.endsWith(".scrubber")) {
            target = waterDemandByLine[line as "A" | "B" | "C"].scrubber * deliveryFactor;
          } else if (tag.module_id.endsWith(".screen")) {
            target = waterDemandByLine[line as "A" | "B" | "C"].screen * deliveryFactor;
          } else if (tag.module_id === "D01.shared.water") {
            target = this.totalWaterDelivered;
          } else if (tag.module_id === "D01.shared.thickener") {
            target = 24 * throughputRatio;
          } else {
            target = 16 * throughputRatio;
          }
          break;
        case "feed_pressure": {
          const dmsFeed = lineDmsFeeds[line as "A" | "B" | "C"] ?? 0;
          target =
            dmsFeed <= 0 ? 0 : 200 + (100 * dmsFeed) / (nominalFeeds[line as "A" | "B" | "C"] ?? 1);
          break;
        }
        case "medium_density": {
          const scenarioElapsed = this.elapsedSeconds - 180;
          if (
            this.scenario === "dms-c" &&
            line === "C" &&
            scenarioElapsed >= 0 &&
            scenarioElapsed < 540
          ) {
            if (scenarioElapsed < 180) {
              target = 2920 - (250 * scenarioElapsed) / 180;
            } else if (scenarioElapsed < 420) {
              target = 2670;
            } else {
              target = 2670 + 250 * Math.min(1, (scenarioElapsed - 420) / 120);
            }
          } else {
            target = 2920 + this.sharedDisturbance * 20;
          }
          break;
        }
        case "level":
          if (tag.module_id === "D01.shared.hopper") {
            target = (this.hopperTonnes / 1200) * 100;
          } else if (tag.module_id === "D01.shared.water") {
            target = (this.waterVolumeM3 / 60) * 100;
          } else if (tag.module_id === "D01.shared.thickener") {
            target = this.thickenerLevelPercent;
          } else if (tag.module_id === "D01.shared.tailings") {
            target = (this.tailingsTonnes / 8000) * 100;
          } else {
            target = 62 - (1 - lineLoad) * 12;
          }
          break;
        case "power":
          target = powerTarget;
          break;
        case "product_mass":
          target = this.productSampleGrams;
          break;
        default:
          throw new Error(`Unsupported D01 catalog metric '${tag.metric}'.`);
      }

      const noiseRatio = tag.metric === "level" || tag.metric === "product_mass" ? 0.0002 : 0.003;
      this.advanceValue(tag.id, target, 25, noiseRatio);
    }
  }

  private waterThrottle(): number {
    if (this.waterStage === "ramping") {
      return 1 - 0.65 * Math.min(1, this.waterStageElapsedSeconds / 60);
    }
    if (this.waterStage === "holding") {
      return 0.35;
    }
    if (this.waterStage === "recovering") {
      return 0.35 + 0.65 * Math.min(1, this.waterStageElapsedSeconds / 60);
    }
    return 1;
  }

  private createDueTelemetry(timestamp: string): D01NumericTelemetryEvent[] {
    const events: D01NumericTelemetryEvent[] = [];
    for (const tag of D01_PLANT_CATALOG.telemetry_tags) {
      const interval = getD01TagIntervalSeconds(tag);
      if (this.elapsedSeconds % interval !== 0) {
        continue;
      }
      if (
        this.scenario === "communication-gap" &&
        tag.module_id === "D01.B.dms" &&
        this.elapsedSeconds >= 180 &&
        this.elapsedSeconds < 360
      ) {
        continue;
      }
      const samples = this.windows.get(tag.id);
      if (!samples || samples.length === 0) {
        throw new Error(`D01 tag '${tag.id}' has no modeled samples.`);
      }
      const windowLength = interval / stepSeconds;
      const window = samples.slice(-windowLength);
      const value = roundValue(window.reduce((sum, sample) => sum + sample, 0) / window.length);
      const event: D01NumericTelemetryEvent = {
        schema_version: 2,
        run_id: this.runId,
        event_id: createD01EventId(this.runId, this.sequence + 1),
        sequence: ++this.sequence,
        interval_seconds: interval,
        timestamp,
        plant_id: D01_PLANT_ID,
        module_id: tag.module_id,
        equipment_id: tag.equipment_id,
        tag_id: tag.id,
        value,
        unit: tag.unit,
        quality: "good",
      };
      assertD01NumericTelemetryEvent(event);
      events.push(event);
    }
    return events;
  }

  private createStateEvent(
    scopeId: D01StateScope,
    state: "starting" | "running" | "idle" | "stopped" | "fault",
    scheduledRunning: boolean,
    timestamp: string,
  ): D01PlantStateEvent {
    const sequence = ++this.sequence;
    return {
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
  }

  private setState(
    scopeId: D01StateScope,
    state: "starting" | "running" | "idle" | "stopped" | "fault",
    scheduledRunning: boolean,
    timestamp: string,
  ): D01PlantStateEvent | null {
    if (this.currentStates.get(scopeId) === state) {
      return null;
    }
    this.currentStates.set(scopeId, state);
    return this.createStateEvent(scopeId, state, scheduledRunning, timestamp);
  }

  private createStateEvents(timestamp: string): D01PlantStateEvent[] {
    if (this.elapsedSeconds % 60 !== 0) {
      return [];
    }
    const events: D01PlantStateEvent[] = [];
    for (const scopeId of scopeIds) {
      events.push(
        this.createStateEvent(
          scopeId,
          this.currentStates.get(scopeId) ?? "starting",
          true,
          timestamp,
        ),
      );
    }
    return events;
  }

  private applyScenarioTransitions(timestamp: string, stateEvents: D01PlantStateEvent[]): void {
    if (this.elapsedSeconds === 60) {
      for (const scopeId of scopeIds) {
        const event = this.setState(scopeId, "running", true, timestamp);
        if (event) {
          stateEvents.push(event);
        }
      }
    }
  }

  private evaluateAlerts(
    timestamp: string,
    measurements: readonly D01NumericTelemetryEvent[],
  ): D01AlertTransition[] {
    const output: D01AlertTransition[] = [];
    const byTag = new Map(measurements.map((event) => [event.tag_id, event]));
    const bearingTemperature = byTag.get("D01.B.crusher.bearing_temperature");
    const bearingVibration = byTag.get("D01.B.crusher.vibration_rms");
    if (bearingTemperature && bearingVibration) {
      if (bearingTemperature.value >= 80 || bearingVibration.value >= 8) {
        this.addAlert(
          "bearing-b-condition",
          "B",
          "high",
          "raised",
          timestamp,
          {
            bearing_temperature_c: bearingTemperature.value,
            vibration_rms_mm_s: bearingVibration.value,
          },
          output,
        );
      } else if (bearingTemperature.value <= 70 && bearingVibration.value <= 5) {
        this.addAlert(
          "bearing-b-condition",
          "B",
          "high",
          "cleared",
          timestamp,
          {
            bearing_temperature_c: bearingTemperature.value,
            vibration_rms_mm_s: bearingVibration.value,
          },
          output,
        );
      }
    }

    const cDensity = byTag.get("D01.C.dms.medium_density");
    if (cDensity) {
      if (cDensity.value < 2500) {
        this.addAlert(
          "dms-c-density-low",
          "C",
          "high",
          "raised",
          timestamp,
          {
            medium_density_kg_m3: cDensity.value,
          },
          output,
        );
      } else if (cDensity.value >= 2800) {
        this.addAlert(
          "dms-c-density-low",
          "C",
          "high",
          "cleared",
          timestamp,
          {
            medium_density_kg_m3: cDensity.value,
          },
          output,
        );
      }
    }

    const waterLevel = byTag.get("D01.shared.water.level");
    if (waterLevel) {
      if (waterLevel.value < 20) {
        this.addAlert(
          "shared-water-low-level",
          "shared",
          "warning",
          "raised",
          timestamp,
          {
            water_level_percent: waterLevel.value,
          },
          output,
        );
      } else if (waterLevel.value >= 35) {
        this.addAlert(
          "shared-water-low-level",
          "shared",
          "warning",
          "cleared",
          timestamp,
          {
            water_level_percent: waterLevel.value,
          },
          output,
        );
      }
    }

    const dmsTelemetry = measurements.find((event) => event.module_id === "D01.B.dms");
    if (dmsTelemetry) {
      const gapSeconds =
        this.lastDmsTelemetryElapsedSeconds > 0
          ? this.elapsedSeconds - this.lastDmsTelemetryElapsedSeconds
          : 0;
      this.lastDmsTelemetryElapsedSeconds = this.elapsedSeconds;
      this.lastDmsTelemetryTimestamp = dmsTelemetry.timestamp;
      this.addAlert(
        "line-b-telemetry-gap",
        "B",
        "warning",
        "cleared",
        timestamp,
        {
          last_observed_timestamp: dmsTelemetry.timestamp,
          gap_seconds: gapSeconds,
        },
        output,
      );
    } else if (
      this.lastDmsTelemetryElapsedSeconds > 0 &&
      this.elapsedSeconds - this.lastDmsTelemetryElapsedSeconds >= 60
    ) {
      this.addAlert(
        "line-b-telemetry-gap",
        "B",
        "warning",
        "raised",
        timestamp,
        {
          last_observed_timestamp: this.lastDmsTelemetryTimestamp,
          gap_seconds: this.elapsedSeconds - this.lastDmsTelemetryElapsedSeconds,
        },
        output,
      );
    }
    return output;
  }

  private addAlert(
    ruleId: string,
    scopeId: D01StateScope,
    severity: "warning" | "high",
    transition: "raised" | "cleared",
    timestamp: string,
    evidence: Record<string, string | number | boolean>,
    output: D01AlertTransition[],
  ): void {
    const activeKey = `${scopeId}:${ruleId}`;
    if (transition === "raised") {
      if (this.activeAlerts.has(activeKey)) {
        return;
      }
      this.activeAlerts.add(activeKey);
    } else {
      if (!this.activeAlerts.has(activeKey)) {
        return;
      }
      this.activeAlerts.delete(activeKey);
    }
    const alert: D01AlertTransition = {
      plant_id: D01_PLANT_ID,
      run_id: this.runId,
      transition_id: createD01AlertTransitionId(this.runId, ruleId, scopeId, transition, timestamp),
      timestamp,
      rule_id: ruleId,
      scope_id: scopeId,
      transition,
      severity,
      evidence,
    };
    assertD01AlertTransition(alert);
    output.push(alert);
  }
}

export function createD01Simulation(options: CreateD01SimulationOptions): D01PlantSimulator {
  return new D01PlantSimulator(options);
}
