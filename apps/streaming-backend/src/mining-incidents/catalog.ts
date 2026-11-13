import {
  D01_CATALOG_VERSION,
  D01_PLANT_CATALOG,
  D01_PLANT_ID,
  D01_PUBLISH_PROFILE_VERSION,
  getD01TagIntervalSeconds,
  toD01PublishProfileRecords,
  validateD01PlantCatalog,
} from "@triathlon-twin/simulator/mining";
import type { MiningRunRecord } from "../mining/run-coordinator.js";
import type { MiningTag } from "./evaluator.js";
import type { MiningIncidentRun } from "./runtime.js";

/** Reconstructs the exact run/catalog binding without activating incident processing. */
export function createD01IncidentRun(
  run: Pick<MiningRunRecord, "runId" | "startedAt" | "stopAt">,
): MiningIncidentRun {
  validateD01PlantCatalog(D01_PLANT_CATALOG);
  const modules = new Map(D01_PLANT_CATALOG.modules.map((module) => [module.id, module]));
  const profile = toD01PublishProfileRecords();
  if (profile.length !== D01_PLANT_CATALOG.telemetry_tags.length) {
    throw new Error("D01 incident publication profile does not match the catalog.");
  }
  const intervals = new Map(profile.map((row) => [row.tag_id, row]));
  if (intervals.size !== profile.length) {
    throw new Error("D01 incident publication profile contains duplicate tags.");
  }
  const tags = D01_PLANT_CATALOG.telemetry_tags.map((tag): MiningTag => {
    const module = modules.get(tag.module_id);
    const scope = module?.line;
    const row = intervals.get(tag.id);
    if (
      !module ||
      (scope !== "A" && scope !== "B" && scope !== "C" && scope !== "shared") ||
      !tag.id.startsWith(`D01.${scope}.`) ||
      !row ||
      row.plant_id !== D01_PLANT_ID ||
      row.catalog_version !== D01_CATALOG_VERSION ||
      row.profile_version !== D01_PUBLISH_PROFILE_VERSION ||
      row.tag_id !== tag.id ||
      row.interval_seconds !== getD01TagIntervalSeconds(tag)
    ) {
      throw new Error(`Invalid D01 incident catalog/profile binding for '${tag.id}'.`);
    }
    return Object.freeze({
      tagId: tag.id,
      moduleId: tag.module_id,
      scopeId: scope,
      unit: tag.unit,
      intervalSeconds: row.interval_seconds,
    });
  });
  return Object.freeze({
    runId: run.runId,
    startedAt: run.startedAt,
    endsAt: run.stopAt,
    tags: Object.freeze(tags),
  });
}
