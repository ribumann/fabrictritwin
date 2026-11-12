import { createHash } from "node:crypto";
import { D01_PLANT_CATALOG, D01_PLANT_ID, getD01TagIntervalSeconds } from "./catalog.js";
import type { D01PlantCatalog } from "./catalog.js";

export const D01_EVENT_SCHEMA_VERSION = 2 as const;

export const D01_EVENT_ENTITY_TYPES = {
  telemetry: "PlantTelemetry",
  state: "PlantStateEvent",
} as const;

export type D01StateScope = "A" | "B" | "C" | "shared";
export type D01State = "starting" | "running" | "idle" | "stopped" | "fault";
export type D01Quality = "good" | "uncertain" | "bad";

export interface D01NumericTelemetryEvent {
  schema_version: typeof D01_EVENT_SCHEMA_VERSION;
  run_id: string;
  event_id: string;
  sequence: number;
  interval_seconds: 30 | 60;
  timestamp: string;
  plant_id: typeof D01_PLANT_ID;
  module_id: string;
  equipment_id: string;
  tag_id: string;
  value: number;
  unit: string;
  quality: D01Quality;
}

export interface D01PlantStateEvent {
  schema_version: typeof D01_EVENT_SCHEMA_VERSION;
  run_id: string;
  event_id: string;
  sequence: number;
  timestamp: string;
  plant_id: typeof D01_PLANT_ID;
  scope_id: D01StateScope;
  scheduled_running: boolean;
  state: D01State;
}

export type D01AlertSeverity = "warning" | "high";
export type D01AlertTransitionKind = "raised" | "cleared";

export interface D01AlertTransition {
  plant_id: typeof D01_PLANT_ID;
  run_id: string;
  transition_id: string;
  timestamp: string;
  rule_id: string;
  scope_id: D01StateScope;
  transition: D01AlertTransitionKind;
  severity: D01AlertSeverity;
  evidence: Record<string, string | number | boolean>;
}

export type D01TransportBody =
  | ({ entityType: typeof D01_EVENT_ENTITY_TYPES.telemetry } & D01NumericTelemetryEvent)
  | ({ entityType: typeof D01_EVENT_ENTITY_TYPES.state } & D01PlantStateEvent);

const numericFields = [
  "schema_version",
  "run_id",
  "event_id",
  "sequence",
  "interval_seconds",
  "timestamp",
  "plant_id",
  "module_id",
  "equipment_id",
  "tag_id",
  "value",
  "unit",
  "quality",
] as const;

const stateFields = [
  "schema_version",
  "run_id",
  "event_id",
  "sequence",
  "timestamp",
  "plant_id",
  "scope_id",
  "scheduled_running",
  "state",
] as const;

const alertFields = [
  "plant_id",
  "run_id",
  "transition_id",
  "timestamp",
  "rule_id",
  "scope_id",
  "transition",
  "severity",
  "evidence",
] as const;

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    throw new TypeError(`${label} has missing or unexpected fields.`);
  }
}

function requireTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.endsWith("Z")) {
    throw new TypeError(`${label} must be a UTC timestamp ending in Z.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical UTC ISO-8601 timestamp.`);
  }
}

function requireCommonFields(value: Record<string, unknown>, label: string): void {
  if (value.schema_version !== D01_EVENT_SCHEMA_VERSION) {
    throw new TypeError(`${label} must use schema_version 2.`);
  }
  if (typeof value.run_id !== "string" || value.run_id.trim().length === 0) {
    throw new TypeError(`${label} run_id must not be empty.`);
  }
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1) {
    throw new TypeError(`${label} sequence must be a positive safe integer.`);
  }
  if (
    typeof value.event_id !== "string" ||
    value.event_id !== createD01EventId(value.run_id, value.sequence as number)
  ) {
    throw new TypeError(`${label} event_id does not match its run_id and sequence.`);
  }
  if (value.plant_id !== D01_PLANT_ID) {
    throw new TypeError(`${label} plant_id must be D01.`);
  }
  requireTimestamp(value.timestamp, `${label} timestamp`);
}

export function createD01EventId(runId: string, sequence: number): string {
  if (runId.trim().length === 0 || !Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError("A D01 event ID requires a non-empty run ID and positive safe sequence.");
  }
  return createHash("sha256").update(`${runId}:${sequence}`, "utf8").digest("hex");
}

export function createD01BatchId(runId: string, elapsedSeconds: number): string {
  if (
    runId.trim().length === 0 ||
    !Number.isSafeInteger(elapsedSeconds) ||
    elapsedSeconds < 5 ||
    elapsedSeconds % 5 !== 0
  ) {
    throw new RangeError("A D01 batch ID requires a run ID and positive 5-second boundary.");
  }
  return createHash("sha256").update(`${runId}:batch:${elapsedSeconds}`, "utf8").digest("hex");
}

export function createD01AlertTransitionId(
  runId: string,
  ruleId: string,
  scopeId: D01StateScope,
  transition: D01AlertTransitionKind,
  timestamp: string,
): string {
  if (runId.trim().length === 0 || ruleId.trim().length === 0) {
    throw new RangeError("A D01 alert transition ID requires a run ID and rule ID.");
  }
  requireTimestamp(timestamp, "Alert transition timestamp");
  return createHash("sha256")
    .update(`${runId}:alert:${ruleId}:${scopeId}:${transition}:${timestamp}`, "utf8")
    .digest("hex");
}

export function assertD01NumericTelemetryEvent(
  input: unknown,
  catalog: D01PlantCatalog = D01_PLANT_CATALOG,
): asserts input is D01NumericTelemetryEvent {
  const event = requireRecord(input, "Numeric telemetry event");
  requireExactFields(event, numericFields, "Numeric telemetry event");
  requireCommonFields(event, "Numeric telemetry event");

  if (event.interval_seconds !== 30 && event.interval_seconds !== 60) {
    throw new TypeError("Numeric telemetry interval_seconds must be 30 or 60.");
  }
  const tag = catalog.telemetry_tags.find((candidate) => candidate.id === event.tag_id);
  if (!tag) {
    throw new TypeError(`Numeric telemetry event refers to unknown tag '${String(event.tag_id)}'.`);
  }
  if (event.interval_seconds !== getD01TagIntervalSeconds(tag)) {
    throw new TypeError(`Numeric telemetry event interval disagrees with tag '${tag.id}'.`);
  }
  if (event.module_id !== tag.module_id || event.equipment_id !== tag.equipment_id) {
    throw new TypeError(`Numeric telemetry event joins disagree with tag '${tag.id}'.`);
  }
  if (event.unit !== tag.unit) {
    throw new TypeError(`Numeric telemetry event unit disagrees with tag '${tag.id}'.`);
  }
  if (typeof event.value !== "number" || !Number.isFinite(event.value)) {
    throw new TypeError(`Numeric telemetry event value for '${tag.id}' must be finite.`);
  }
  const [minimum, maximum] = tag.simulation_envelope;
  if (event.value < minimum || event.value > maximum) {
    throw new RangeError(
      `Numeric telemetry event value ${String(event.value)} for '${tag.id}' is outside [${minimum}, ${maximum}].`,
    );
  }
  if (event.quality !== "good" && event.quality !== "uncertain" && event.quality !== "bad") {
    throw new TypeError(`Numeric telemetry event quality for '${tag.id}' is invalid.`);
  }
}

export function assertD01PlantStateEvent(input: unknown): asserts input is D01PlantStateEvent {
  const event = requireRecord(input, "Plant state event");
  requireExactFields(event, stateFields, "Plant state event");
  requireCommonFields(event, "Plant state event");
  if (
    event.scope_id !== "A" &&
    event.scope_id !== "B" &&
    event.scope_id !== "C" &&
    event.scope_id !== "shared"
  ) {
    throw new TypeError("Plant state event scope_id must be A, B, C, or shared.");
  }
  if (typeof event.scheduled_running !== "boolean") {
    throw new TypeError("Plant state event scheduled_running must be boolean.");
  }
  if (
    event.state !== "starting" &&
    event.state !== "running" &&
    event.state !== "idle" &&
    event.state !== "stopped" &&
    event.state !== "fault"
  ) {
    throw new TypeError("Plant state event state is invalid.");
  }
}

export function assertD01AlertTransition(input: unknown): asserts input is D01AlertTransition {
  const alert = requireRecord(input, "Alert transition");
  requireExactFields(alert, alertFields, "Alert transition");
  if (alert.plant_id !== D01_PLANT_ID) {
    throw new TypeError("Alert transition plant_id must be D01.");
  }
  if (typeof alert.run_id !== "string" || alert.run_id.trim().length === 0) {
    throw new TypeError("Alert transition run_id must not be empty.");
  }
  if (
    alert.scope_id !== "A" &&
    alert.scope_id !== "B" &&
    alert.scope_id !== "C" &&
    alert.scope_id !== "shared"
  ) {
    throw new TypeError("Alert transition scope_id must be A, B, C, or shared.");
  }
  if (alert.transition !== "raised" && alert.transition !== "cleared") {
    throw new TypeError("Alert transition transition must be raised or cleared.");
  }
  if (alert.severity !== "warning" && alert.severity !== "high") {
    throw new TypeError("Alert transition severity must be warning or high.");
  }
  if (typeof alert.rule_id !== "string" || alert.rule_id.trim().length === 0) {
    throw new TypeError("Alert transition rule_id must not be empty.");
  }
  requireTimestamp(alert.timestamp, "Alert transition timestamp");
  if (
    typeof alert.transition_id !== "string" ||
    alert.transition_id !==
      createD01AlertTransitionId(
        alert.run_id,
        alert.rule_id,
        alert.scope_id,
        alert.transition,
        alert.timestamp,
      )
  ) {
    throw new TypeError("Alert transition transition_id does not match its identity fields.");
  }
  const evidence = requireRecord(alert.evidence, "Alert transition evidence");
  for (const [key, value] of Object.entries(evidence)) {
    if (
      key.trim().length === 0 ||
      (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") ||
      (typeof value === "number" && !Number.isFinite(value))
    ) {
      throw new TypeError("Alert transition evidence must contain finite scalar values.");
    }
  }
}

export function toD01TransportBody(event: D01NumericTelemetryEvent): D01TransportBody;
export function toD01TransportBody(event: D01PlantStateEvent): D01TransportBody;
export function toD01TransportBody(
  event: D01NumericTelemetryEvent | D01PlantStateEvent,
): D01TransportBody {
  if ("tag_id" in event) {
    assertD01NumericTelemetryEvent(event);
    return { entityType: D01_EVENT_ENTITY_TYPES.telemetry, ...event };
  }
  assertD01PlantStateEvent(event);
  return { entityType: D01_EVENT_ENTITY_TYPES.state, ...event };
}
