import plantCatalog from "./plant-catalog.json" with { type: "json" };

export const D01_PLANT_ID = "D01" as const;
export const D01_CATALOG_VERSION =
  "sha256:0ba278e5e28b3466381534c5a920ce28b551cb3a7ddfc68cdf4371749f2c62ce" as const;

export type D01PlantCatalog = typeof plantCatalog;
export type D01Module = D01PlantCatalog["modules"][number];
export type D01Equipment = D01PlantCatalog["equipment"][number];
export type D01Stream = D01PlantCatalog["streams"][number];
export type D01TelemetryTag = D01PlantCatalog["telemetry_tags"][number];

export type D01CatalogRecord =
  | {
      plant_id: typeof D01_PLANT_ID;
      catalog_version: typeof D01_CATALOG_VERSION;
      record_kind: "module";
      record_id: string;
      module_id: string;
      record_json: D01Module;
    }
  | {
      plant_id: typeof D01_PLANT_ID;
      catalog_version: typeof D01_CATALOG_VERSION;
      record_kind: "equipment";
      record_id: string;
      module_id: string;
      record_json: D01Equipment;
    }
  | {
      plant_id: typeof D01_PLANT_ID;
      catalog_version: typeof D01_CATALOG_VERSION;
      record_kind: "stream";
      record_id: string;
      module_id: null;
      record_json: D01Stream;
    }
  | {
      plant_id: typeof D01_PLANT_ID;
      catalog_version: typeof D01_CATALOG_VERSION;
      record_kind: "tag";
      record_id: string;
      module_id: string;
      record_json: D01TelemetryTag;
    };

const expectedCounts = {
  modules: 24,
  equipment: 64,
  streams: 50,
  telemetry_tags: 56,
} as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Invalid D01 catalog: ${message}`);
  }
}

function indexUnique<T extends { id: string }>(
  records: readonly T[],
  kind: string,
): Map<string, T> {
  const index = new Map<string, T>();
  for (const record of records) {
    assert(!index.has(record.id), `duplicate ${kind} ID '${record.id}'.`);
    index.set(record.id, record);
  }
  return index;
}

export function validateD01PlantCatalog(catalog: D01PlantCatalog): void {
  assert(catalog.schema_version === 1, "expected source catalog schema version 1.");
  assert(catalog.plant_id === D01_PLANT_ID, "plant_id must be D01.");
  assert(catalog.units === "meters", "module dimensions must remain in meters.");
  assert(catalog.coordinates === "right-handed-y-up", "coordinate system changed.");

  for (const [collection, expected] of Object.entries(expectedCounts)) {
    assert(
      catalog[collection as keyof typeof expectedCounts].length === expected,
      `expected ${expected} ${collection}.`,
    );
  }

  const modules = indexUnique(catalog.modules, "module");
  const equipment = indexUnique(catalog.equipment, "equipment");
  indexUnique(catalog.telemetry_tags, "tag");
  indexUnique(catalog.streams, "stream");

  for (const module of catalog.modules) {
    assert(
      module.position.length === 3 && module.size.length === 3 && module.rotation.length === 3,
      `module '${module.id}' must retain authored position, size, and rotation.`,
    );
    assert(
      module.position.every(Number.isFinite) &&
        module.size.every((dimension) => Number.isFinite(dimension) && dimension > 0) &&
        module.rotation.every(Number.isFinite),
      `module '${module.id}' has invalid authored dimensions.`,
    );
  }

  for (const child of catalog.equipment) {
    const parent = modules.get(child.module_id);
    assert(parent, `equipment '${child.id}' refers to missing module '${child.module_id}'.`);
    assert(
      child.geometry === "logical-child-no-independent-geometry",
      `equipment '${child.id}' must remain a logical child, not an invented mesh.`,
    );
  }

  for (const tag of catalog.telemetry_tags) {
    const parent = modules.get(tag.module_id);
    const asset = equipment.get(tag.equipment_id);
    assert(parent, `tag '${tag.id}' refers to missing module '${tag.module_id}'.`);
    assert(asset, `tag '${tag.id}' refers to missing equipment '${tag.equipment_id}'.`);
    assert(
      asset.module_id === tag.module_id,
      `tag '${tag.id}' module and equipment parents disagree.`,
    );
    assert(tag.value_type === "double", `tag '${tag.id}' must remain numeric.`);
    assert(
      tag.simulation_envelope.length === 2 &&
        tag.simulation_envelope.every(Number.isFinite) &&
        tag.simulation_envelope[0] <= tag.simulation_envelope[1],
      `tag '${tag.id}' has an invalid numeric envelope.`,
    );
    assert(tag.unit.length > 0, `tag '${tag.id}' is missing its authored unit.`);
  }

  for (const stream of catalog.streams) {
    const sourceModule = modules.get(stream.source.module_id);
    const targetModule = modules.get(stream.target.module_id);
    assert(
      sourceModule,
      `stream '${stream.id}' refers to missing source module '${stream.source.module_id}'.`,
    );
    assert(
      targetModule,
      `stream '${stream.id}' refers to missing target module '${stream.target.module_id}'.`,
    );
    const sourcePort = sourceModule.ports.find((port) => port.id === stream.source.port_id);
    const targetPort = targetModule.ports.find((port) => port.id === stream.target.port_id);
    assert(sourcePort, `stream '${stream.id}' refers to a missing source port.`);
    assert(targetPort, `stream '${stream.id}' refers to a missing target port.`);
    assert(sourcePort.direction === "out", `stream '${stream.id}' source port is not outgoing.`);
    assert(targetPort.direction === "in", `stream '${stream.id}' target port is not incoming.`);
    assert(
      sourcePort.material === stream.material && targetPort.material === stream.material,
      `stream '${stream.id}' material disagrees with its endpoint ports.`,
    );
    assert(
      stream.route_points_m.every((point) => point.length === 3 && point.every(Number.isFinite)),
      `stream '${stream.id}' has an invalid authored route.`,
    );
  }
}

export const D01_PLANT_CATALOG = plantCatalog;

validateD01PlantCatalog(D01_PLANT_CATALOG);

export function getD01TagIntervalSeconds(tag: D01TelemetryTag): 30 | 60 {
  return tag.metric === "bearing_temperature" ||
    tag.metric === "level" ||
    tag.metric === "product_mass"
    ? 60
    : 30;
}

export function toD01CatalogRecords(): D01CatalogRecord[] {
  return [
    ...D01_PLANT_CATALOG.modules.map((record): D01CatalogRecord => ({
      plant_id: D01_PLANT_ID,
      catalog_version: D01_CATALOG_VERSION,
      record_kind: "module",
      record_id: record.id,
      module_id: record.id,
      record_json: record,
    })),
    ...D01_PLANT_CATALOG.equipment.map((record): D01CatalogRecord => ({
      plant_id: D01_PLANT_ID,
      catalog_version: D01_CATALOG_VERSION,
      record_kind: "equipment",
      record_id: record.id,
      module_id: record.module_id,
      record_json: record,
    })),
    ...D01_PLANT_CATALOG.telemetry_tags.map((record): D01CatalogRecord => ({
      plant_id: D01_PLANT_ID,
      catalog_version: D01_CATALOG_VERSION,
      record_kind: "tag",
      record_id: record.id,
      module_id: record.module_id,
      record_json: record,
    })),
    ...D01_PLANT_CATALOG.streams.map((record): D01CatalogRecord => ({
      plant_id: D01_PLANT_ID,
      catalog_version: D01_CATALOG_VERSION,
      record_kind: "stream",
      record_id: record.id,
      module_id: null,
      record_json: record,
    })),
  ];
}
