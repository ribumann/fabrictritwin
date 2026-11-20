import { readingAt } from "./data.js";

const paths = ["A", "B", "C"];
const processMaterials = new Set([
  "ore",
  "crushed-ore",
  "washed-ore",
  "sized-ore",
  "sinks",
  "concentrate",
]);
const diagnosticKinds = { density: "dms", vibration: "crusher", "water-energy": "water" };

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
