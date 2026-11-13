import { createHash } from "node:crypto";
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

/** Source-recorded contract; it is not an authorization or deployment attestation. */
export interface D01RunContract {
  catalogVersion: string;
  profileVersion: string;
  evaluatorReplayVersion: 1;
}

export function createD01RunContract(): D01RunContract {
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  if (
    D01_CATALOG_VERSION !==
      "sha256:0ba278e5e28b3466381534c5a920ce28b551cb3a7ddfc68cdf4371749f2c62ce" ||
    D01_PUBLISH_PROFILE_VERSION !== "d01-publish-profile-v1" ||
    hash(D01_PLANT_CATALOG) !==
      "ae3ed7020cf49e13a6ac6153171e1703506b893047801c6c125a40ecdc7045e7" ||
    hash(toD01PublishProfileRecords()) !==
      "d28979a03d8ee5f5072f40c3a836c499918d2aeb085cbf00e4c770aa4dede3cc"
  ) {
    throw new Error("D01 catalog or publish profile no longer matches the supported contract.");
  }
  return {
    catalogVersion: D01_CATALOG_VERSION,
    profileVersion: D01_PUBLISH_PROFILE_VERSION,
    evaluatorReplayVersion: 1,
  };
}

export function assertD01RunContract(value: unknown): asserts value is D01RunContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid D01 run contract.");
  }
  const contract = value as Record<string, unknown>;
  const supported = createD01RunContract();
  if (
    Object.keys(contract).sort().join() !==
      "catalogVersion,evaluatorReplayVersion,profileVersion" ||
    contract.catalogVersion !== supported.catalogVersion ||
    contract.profileVersion !== supported.profileVersion ||
    contract.evaluatorReplayVersion !== supported.evaluatorReplayVersion
  ) {
    throw new Error("Unsupported D01 run contract.");
  }
}

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

/** Builds the prospective journal definition only from an already bound run. */
export function createD01VersionedIncidentRun(
  run: Pick<MiningRunRecord, "runId" | "startedAt" | "stopAt"> & { contract: D01RunContract },
): MiningIncidentRun {
  assertD01RunContract(run.contract);
  return Object.freeze({
    ...createD01IncidentRun(run),
    contract: Object.freeze(createD01RunContract()),
  });
}
