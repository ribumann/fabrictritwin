import { D01_CATALOG_VERSION, D01_PLANT_CATALOG, D01_PLANT_ID } from "./catalog.js";
import type { D01Stream } from "./catalog.js";

export const D01_CONNECTION_MEASUREMENT_CATALOG_VERSION = "d01-connection-measurements-v1" as const;
export const D01_CONNECTION_PROFILE_VERSION = "d01-shared-flow-v1" as const;
export const D01_LEGACY_FLOW_PROJECTION_PROFILE_VERSION =
  "d01-shared-flow-legacy-projection-v1" as const;
export const D01_CONNECTION_SAMPLE_INTERVAL_SECONDS = 5 as const;

export type D01ConnectionQuantity =
  "dry_solids_mass_flow" | "water_volume_flow" | "medium_volume_flow";
export type D01ConnectionOrigin = "synthetic_sensor_observation";

export interface D01ConnectionMeasurementBinding {
  plant_id: typeof D01_PLANT_ID;
  catalog_version: typeof D01_CATALOG_VERSION;
  measurement_catalog_version: typeof D01_CONNECTION_MEASUREMENT_CATALOG_VERSION;
  profile_version: typeof D01_CONNECTION_PROFILE_VERSION;
  stream_id: string;
  measurement_tag_id: string;
  source: {
    module_id: string;
    port_id: string;
    equipment_id: null;
    equipment_port_id: null;
  };
  target: {
    module_id: string;
    port_id: string;
    equipment_id: null;
    equipment_port_id: null;
  };
  endpoint_granularity: "module-port";
  quantity: D01ConnectionQuantity;
  basis: "dry_solids" | "water" | "ferrosilicon_medium";
  unit: "t/h" | "m3/h";
  nominal_capacity: {
    value: number;
    unit: "t/h" | "m3/h";
    purpose: "visualization_scale_only";
  };
  sample_interval_seconds: typeof D01_CONNECTION_SAMPLE_INTERVAL_SECONDS;
  origin: D01ConnectionOrigin;
}

export interface D01ConnectionComponentDefinition {
  quantity: D01ConnectionQuantity;
  basis: D01ConnectionMeasurementBinding["basis"];
  unit: D01ConnectionMeasurementBinding["unit"];
  nominal_capacity: number;
}

const drySolids = (nominalCapacity = 60): D01ConnectionComponentDefinition => ({
  quantity: "dry_solids_mass_flow",
  basis: "dry_solids",
  unit: "t/h",
  nominal_capacity: nominalCapacity,
});
const water = (nominalCapacity = 120): D01ConnectionComponentDefinition => ({
  quantity: "water_volume_flow",
  basis: "water",
  unit: "m3/h",
  nominal_capacity: nominalCapacity,
});
const medium = (nominalCapacity = 120): D01ConnectionComponentDefinition => ({
  quantity: "medium_volume_flow",
  basis: "ferrosilicon_medium",
  unit: "m3/h",
  nominal_capacity: nominalCapacity,
});

const componentsByStreamId = new Map<string, readonly D01ConnectionComponentDefinition[]>();

function defineStream(
  streamId: string,
  components: readonly D01ConnectionComponentDefinition[],
): void {
  if (componentsByStreamId.has(streamId)) {
    throw new Error(`Duplicate D01 connection measurement definition '${streamId}'.`);
  }
  componentsByStreamId.set(streamId, components);
}

for (const line of ["A", "B", "C"] as const) {
  defineStream(`process-${line}-feed`, [drySolids()]);
  defineStream(`process-${line}-crush`, [drySolids()]);
  defineStream(`process-${line}-wash`, [drySolids()]);
  defineStream(`process-${line}-size`, [drySolids()]);
  defineStream(`process-${line}-sinks`, [drySolids()]);
  defineStream(`process-${line}-floats`, [drySolids()]);
  defineStream(`process-${line}-concentrate`, [drySolids()]);
  defineStream(`process-${line}-reject`, [drySolids()]);
  defineStream(`process-${line}-sorter-reject`, [drySolids()]);
  defineStream(`process-${line}-product`, [drySolids(10)]);
  defineStream(`utility-${line}-fines`, [drySolids(20), water(100)]);
  defineStream(`utility-${line}-effluent`, [drySolids(20), water(250)]);
  defineStream(`utility-${line}-medium-recycle`, [medium(150)]);
  defineStream(`utility-${line}-scrubber-water`, [water()]);
  defineStream(`utility-${line}-screen-water`, [water()]);
  defineStream(`utility-${line}-medium-water`, [water()]);
}

defineStream("utility-water-return", [water(300)]);
defineStream("utility-thickener-underflow", [drySolids(100), water(300)]);

const streamById = new Map(D01_PLANT_CATALOG.streams.map((stream) => [stream.id, stream]));

function endpoint(
  stream: D01Stream,
  side: "source" | "target",
): D01ConnectionMeasurementBinding["source"] {
  const authored = stream[side];
  return {
    module_id: authored.module_id,
    port_id: authored.port_id,
    // The pinned catalog authors module ports, not equipment-owned ports. Do not infer ownership.
    equipment_id: null,
    equipment_port_id: null,
  };
}

function createBindings(): D01ConnectionMeasurementBinding[] {
  for (const streamId of componentsByStreamId.keys()) {
    if (!streamById.has(streamId)) {
      throw new Error(
        `D01 connection measurement definition refers to unknown stream '${streamId}'.`,
      );
    }
  }
  for (const stream of D01_PLANT_CATALOG.streams) {
    if (!componentsByStreamId.has(stream.id)) {
      throw new Error(`D01 stream '${stream.id}' has no versioned connection measurement binding.`);
    }
  }

  const bindings: D01ConnectionMeasurementBinding[] = [];
  for (const stream of D01_PLANT_CATALOG.streams) {
    const components = componentsByStreamId.get(stream.id);
    if (!components) throw new Error(`Missing D01 component definition for '${stream.id}'.`);
    for (const component of components) {
      bindings.push({
        plant_id: D01_PLANT_ID,
        catalog_version: D01_CATALOG_VERSION,
        measurement_catalog_version: D01_CONNECTION_MEASUREMENT_CATALOG_VERSION,
        profile_version: D01_CONNECTION_PROFILE_VERSION,
        stream_id: stream.id,
        measurement_tag_id: `D01.connection.${stream.id}.${component.quantity}`,
        source: endpoint(stream, "source"),
        target: endpoint(stream, "target"),
        endpoint_granularity: "module-port",
        quantity: component.quantity,
        basis: component.basis,
        unit: component.unit,
        nominal_capacity: {
          value: component.nominal_capacity,
          unit: component.unit,
          purpose: "visualization_scale_only",
        },
        sample_interval_seconds: D01_CONNECTION_SAMPLE_INTERVAL_SECONDS,
        origin: "synthetic_sensor_observation",
      });
    }
  }
  return bindings;
}

const bindings = createBindings();
const bindingsByTag = new Map(bindings.map((binding) => [binding.measurement_tag_id, binding]));

export function toD01ConnectionMeasurementBindingRecords(): D01ConnectionMeasurementBinding[] {
  return bindings.map((binding) => ({
    ...binding,
    source: { ...binding.source },
    target: { ...binding.target },
    nominal_capacity: { ...binding.nominal_capacity },
  }));
}

export function getD01ConnectionMeasurementBinding(
  measurementTagId: string,
): D01ConnectionMeasurementBinding | undefined {
  const binding = bindingsByTag.get(measurementTagId);
  return binding
    ? {
        ...binding,
        source: { ...binding.source },
        target: { ...binding.target },
        nominal_capacity: { ...binding.nominal_capacity },
      }
    : undefined;
}

export function validateD01ConnectionMeasurementBindings(
  records: readonly D01ConnectionMeasurementBinding[] = bindings,
): void {
  const tagIds = new Set<string>();
  const byStream = new Set<string>();
  for (const binding of records) {
    if (binding.plant_id !== D01_PLANT_ID || binding.catalog_version !== D01_CATALOG_VERSION) {
      throw new TypeError("D01 connection binding has an incompatible plant or catalog version.");
    }
    if (
      binding.measurement_catalog_version !== D01_CONNECTION_MEASUREMENT_CATALOG_VERSION ||
      binding.profile_version !== D01_CONNECTION_PROFILE_VERSION
    ) {
      throw new TypeError(
        "D01 connection binding has an incompatible measurement/profile version.",
      );
    }
    if (binding.sample_interval_seconds !== D01_CONNECTION_SAMPLE_INTERVAL_SECONDS) {
      throw new TypeError("D01 connection binding cadence must be five seconds.");
    }
    if (tagIds.has(binding.measurement_tag_id)) {
      throw new TypeError(
        `Duplicate D01 connection measurement tag '${binding.measurement_tag_id}'.`,
      );
    }
    tagIds.add(binding.measurement_tag_id);
    const stream = streamById.get(binding.stream_id);
    if (!stream || byStream.has(`${binding.stream_id}:${binding.quantity}`)) {
      throw new TypeError(`Unknown or duplicate D01 connection binding '${binding.stream_id}'.`);
    }
    byStream.add(`${binding.stream_id}:${binding.quantity}`);
    if (
      binding.source.module_id !== stream.source.module_id ||
      binding.source.port_id !== stream.source.port_id ||
      binding.target.module_id !== stream.target.module_id ||
      binding.target.port_id !== stream.target.port_id
    ) {
      throw new TypeError(`D01 connection binding endpoints disagree with stream '${stream.id}'.`);
    }
    if (
      binding.nominal_capacity.value <= 0 ||
      !Number.isFinite(binding.nominal_capacity.value) ||
      binding.nominal_capacity.unit !== binding.unit ||
      binding.nominal_capacity.purpose !== "visualization_scale_only"
    ) {
      throw new TypeError(`D01 connection binding capacity for '${stream.id}' is invalid.`);
    }
    if (
      (binding.quantity === "dry_solids_mass_flow" &&
        (binding.basis !== "dry_solids" || binding.unit !== "t/h")) ||
      (binding.quantity === "water_volume_flow" &&
        (binding.basis !== "water" || binding.unit !== "m3/h")) ||
      (binding.quantity === "medium_volume_flow" &&
        (binding.basis !== "ferrosilicon_medium" || binding.unit !== "m3/h"))
    ) {
      throw new TypeError(`D01 connection binding quantity/unit disagree for '${stream.id}'.`);
    }
  }
  if (records.length !== bindings.length) {
    throw new TypeError("D01 connection binding set is incomplete.");
  }
}

validateD01ConnectionMeasurementBindings();
