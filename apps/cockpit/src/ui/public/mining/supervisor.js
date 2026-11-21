import { readingAt } from "./data.js";

const overlayMetric = {
  hopper: "level",
  crusher: "ore_flow",
  sorter: "ore_flow",
  water: "water_flow",
  dms: "medium_density",
};

export function plantEvidence(catalog, getReading, number, selected) {
  const readings = new Map();
  for (const module of catalog.modules) {
    const metric = overlayMetric[module.kind];
    if (!metric || (module.kind === "dms" && module.id !== selected)) continue;
    const tag = catalog.telemetry_tags.find(
      (tag) => tag.module_id === module.id && tag.metric === metric,
    );
    if (!tag) continue;
    const value = getReading(tag.id);
    readings.set(module.id, {
      label: `${module.line === "shared" ? module.kind : `${module.line} ${module.kind}`} · ${value ? `${number(value.value)} ${tag.unit}` : "unknown"}`,
      current: !!value,
    });
  }
  const activeRoutes = new Set();
  const measuredRoutes = new Map();
  for (const route of catalog.streams) {
    const id = route.target.module_id;
    if (!(
      (route.material === "ore" && id.endsWith(".crusher")) ||
      (route.material === "concentrate" && id.endsWith(".sorter"))
    ))
      continue;
    const tag = catalog.telemetry_tags.find(
      (item) => item.id === `${id}.ore_flow` && item.unit === "t/h",
    );
    const value = tag && getReading(tag.id)?.value;
    if (!Number.isFinite(value) || value < 0) continue;
    measuredRoutes.set(route.id, {
      value,
      unit: tag.unit,
      // The demo scale is capped at 150 t/h; this is not an operating limit.
      width: 0.18 + 0.55 * Math.min(value / 150, 1),
    });
    if (value > 0) activeRoutes.add(route.id);
  }
  return { readings, activeRoutes, measuredRoutes };
}

export function investigationPrompt({ moduleId, incident, asOf }) {
  if (!moduleId && !incident) return "";
  const scope = [
    moduleId && `equipment ${moduleId}`,
    incident && `assessment ${incident.ruleId} (${incident.scopeId})`,
  ]
    .filter(Boolean)
    .join("; ");
  const cutoff = Number.isFinite(Date.parse(asOf))
    ? ` The cockpit evidence cutoff was ${new Date(asOf).toISOString()}.`
    : "";
  return `Investigate ${scope} in the current approved D01 simulation.${cutoff} What do the available readings show, what remains uncertain, and what should I check next?`;
}

const paths = ["A", "B", "C"];
const processMaterials = new Set([
  "ore",
  "crushed-ore",
  "washed-ore",
  "sized-ore",
  "sinks",
  "concentrate",
]);
const diagnosticKinds = {
  density: "dms",
  vibration: "crusher",
  "sorter-feed": "sorter",
  "water-energy": "water",
};

export function diagnosticAssets(catalog, metric) {
  const kind = diagnosticKinds[metric];
  return (catalog?.modules ?? []).filter((module) => kind && module.kind === kind);
}

export function orePaths(catalog) {
  return paths.map((line) => {
    let id = "D01.shared.hopper";
    const modules = [];
    for (const _ of catalog.modules) {
      const link = catalog.streams.find(
        (stream) =>
          stream.source.module_id === id &&
          processMaterials.has(stream.material) &&
          catalog.modules.some(
            (module) => module.id === stream.target.module_id && module.line === line,
          ),
      );
      if (!link || modules.some((module) => module.id === link.target.module_id)) break;
      id = link.target.module_id;
      modules.push(catalog.modules.find((module) => module.id === id));
    }
    return { line, modules };
  });
}

export function buildupObservation(readings, asOf) {
  const ids = ["D01.shared.hopper.level", ...paths.map((line) => `D01.${line}.crusher.ore_flow`)];
  const points = ids.map((id) => readings?.find((reading) => reading.tagId === id));
  if (!points.every((point) => readingAt(point, asOf))) return null;
  const time = Date.parse(points[0].sampleTime);
  if (!points.every((point) => Date.parse(point.sampleTime) === time)) return null;
  return {
    time,
    level: points[0].value,
    feed: points.slice(1).reduce((sum, point) => sum + point.value, 0),
  };
}

export function possibleBuildup(previous, current) {
  const interval = current?.time - previous?.time;
  return (
    interval >= 30_000 &&
    interval <= 90_000 &&
    current.level - previous.level >= 0.1 &&
    previous.feed - current.feed >= 3
  );
}
