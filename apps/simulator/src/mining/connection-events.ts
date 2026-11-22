import { createHash } from "node:crypto";
import { D01_CATALOG_VERSION, D01_PLANT_ID } from "./catalog.js";
import {
  D01_CONNECTION_MEASUREMENT_CATALOG_VERSION,
  D01_CONNECTION_PROFILE_VERSION,
  getD01ConnectionMeasurementBinding,
} from "./connection-catalog.js";
import type {
  D01ConnectionMeasurementBinding,
  D01ConnectionOrigin,
  D01ConnectionQuantity,
} from "./connection-catalog.js";

export const D01_CONNECTION_EVENT_SCHEMA_VERSION = 1 as const;
export const D01_CONNECTION_EVENT_ENTITY_TYPE = "ConnectionMeasurement" as const;
export type D01ConnectionQuality = "good" | "uncertain" | "bad";

/**
 * Versioned raw five-second observation. This is a separate discriminator and
 * exact-field contract; it is not an extension of schema-v2 telemetry/state.
 */
export interface D01ConnectionMeasurementEvent {
  entityType: typeof D01_CONNECTION_EVENT_ENTITY_TYPE;
  schema_version: typeof D01_CONNECTION_EVENT_SCHEMA_VERSION;
  run_id: string;
  event_id: string;
  sequence: number;
  sample_time: string;
  sample_interval_seconds: 5;
  plant_id: typeof D01_PLANT_ID;
  catalog_version: typeof D01_CATALOG_VERSION;
  measurement_catalog_version: typeof D01_CONNECTION_MEASUREMENT_CATALOG_VERSION;
  profile_version: typeof D01_CONNECTION_PROFILE_VERSION;
  stream_id: string;
  measurement_tag_id: string;
  source_module_id: string;
  source_port_id: string;
  source_equipment_id: null;
  source_equipment_port_id: null;
  target_module_id: string;
  target_port_id: string;
  target_equipment_id: null;
  target_equipment_port_id: null;
  quantity: D01ConnectionQuantity;
  basis: D01ConnectionMeasurementBinding["basis"];
  value: number;
  unit: D01ConnectionMeasurementBinding["unit"];
  quality: D01ConnectionQuality;
  origin: D01ConnectionOrigin;
}

export const D01_CONNECTION_EVENT_FIELDS = [
  "entityType",
  "schema_version",
  "run_id",
  "event_id",
  "sequence",
  "sample_time",
  "sample_interval_seconds",
  "plant_id",
  "catalog_version",
  "measurement_catalog_version",
  "profile_version",
  "stream_id",
  "measurement_tag_id",
  "source_module_id",
  "source_port_id",
  "source_equipment_id",
  "source_equipment_port_id",
  "target_module_id",
  "target_port_id",
  "target_equipment_id",
  "target_equipment_port_id",
  "quantity",
  "basis",
  "value",
  "unit",
  "quality",
  "origin",
] as const;

function requireRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Connection measurement must be a JSON object.");
  }
  return input as Record<string, unknown>;
}

function requireCanonicalUtc(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.endsWith("Z")) {
    throw new TypeError("Connection measurement sample_time must be UTC.");
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new TypeError("Connection measurement sample_time must be canonical UTC ISO-8601.");
  }
}

export function createD01ConnectionEventId(runId: string, sequence: number): string {
  if (runId.trim().length === 0 || !Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError("A connection event ID requires a run ID and positive safe sequence.");
  }
  return createHash("sha256").update(`${runId}:connection:${sequence}`, "utf8").digest("hex");
}

export function createD01ConnectionBatchId(runId: string, sampleTime: string): string {
  if (runId.trim().length === 0) {
    throw new RangeError("A connection batch ID requires a non-empty run ID.");
  }
  requireCanonicalUtc(sampleTime);
  return createHash("sha256")
    .update(`${runId}:connection-batch:${sampleTime}`, "utf8")
    .digest("hex");
}

export function assertD01ConnectionMeasurementEvent(
  input: unknown,
  bindingLookup: (
    measurementTagId: string,
  ) => D01ConnectionMeasurementBinding | undefined = getD01ConnectionMeasurementBinding,
): asserts input is D01ConnectionMeasurementEvent {
  const event = requireRecord(input);
  const actualFields = Object.keys(event).sort();
  const expectedFields = [...D01_CONNECTION_EVENT_FIELDS].sort();
  if (
    actualFields.length !== expectedFields.length ||
    actualFields.some((field, index) => field !== expectedFields[index])
  ) {
    throw new TypeError("Connection measurement has missing or unexpected fields.");
  }
  if (
    event.entityType !== D01_CONNECTION_EVENT_ENTITY_TYPE ||
    event.schema_version !== D01_CONNECTION_EVENT_SCHEMA_VERSION
  ) {
    throw new TypeError("Connection measurement must use its v1 discriminator and schema.");
  }
  if (typeof event.run_id !== "string" || event.run_id.trim().length === 0) {
    throw new TypeError("Connection measurement run_id must not be empty.");
  }
  if (!Number.isSafeInteger(event.sequence) || (event.sequence as number) < 1) {
    throw new TypeError("Connection measurement sequence must be a positive safe integer.");
  }
  if (
    typeof event.event_id !== "string" ||
    event.event_id !== createD01ConnectionEventId(event.run_id, event.sequence as number)
  ) {
    throw new TypeError("Connection measurement event_id does not match its run and sequence.");
  }
  requireCanonicalUtc(event.sample_time);
  if (event.sample_interval_seconds !== 5) {
    throw new TypeError("Connection measurement sample interval must be five seconds.");
  }
  if (
    event.plant_id !== D01_PLANT_ID ||
    event.catalog_version !== D01_CATALOG_VERSION ||
    event.measurement_catalog_version !== D01_CONNECTION_MEASUREMENT_CATALOG_VERSION ||
    event.profile_version !== D01_CONNECTION_PROFILE_VERSION
  ) {
    throw new TypeError("Connection measurement is pinned to an unsupported run version.");
  }
  if (typeof event.measurement_tag_id !== "string") {
    throw new TypeError("Connection measurement requires a measurement_tag_id.");
  }
  const binding = bindingLookup(event.measurement_tag_id);
  if (!binding) {
    throw new TypeError(
      `Connection measurement refers to unknown tag '${String(event.measurement_tag_id)}'.`,
    );
  }
  if (
    event.stream_id !== binding.stream_id ||
    event.source_module_id !== binding.source.module_id ||
    event.source_port_id !== binding.source.port_id ||
    event.source_equipment_id !== binding.source.equipment_id ||
    event.source_equipment_port_id !== binding.source.equipment_port_id ||
    event.target_module_id !== binding.target.module_id ||
    event.target_port_id !== binding.target.port_id ||
    event.target_equipment_id !== binding.target.equipment_id ||
    event.target_equipment_port_id !== binding.target.equipment_port_id ||
    event.quantity !== binding.quantity ||
    event.basis !== binding.basis ||
    event.unit !== binding.unit ||
    event.origin !== binding.origin
  ) {
    throw new TypeError(
      `Connection measurement identity, endpoints, quantity, unit, or origin disagree with '${binding.measurement_tag_id}'.`,
    );
  }
  if (typeof event.value !== "number" || !Number.isFinite(event.value) || event.value < 0) {
    throw new TypeError("Connection measurement value must be finite and non-negative.");
  }
  if (event.quality !== "good" && event.quality !== "uncertain" && event.quality !== "bad") {
    throw new TypeError("Connection measurement quality is invalid.");
  }
}
