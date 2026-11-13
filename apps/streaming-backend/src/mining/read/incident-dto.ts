import { createHash } from "node:crypto";
import { D01_CATALOG_VERSION, D01_PLANT_CATALOG } from "@triathlon-twin/simulator/mining";
import { createD01IncidentRun } from "../../mining-incidents/catalog.js";
import type { MiningIncident, MiningIncidentAssessment } from "../../mining-incidents/evaluator.js";
import type { readMiningIncidentJournal } from "../../mining-incidents/runtime.js";
import type { MiningRunRecord } from "../run-coordinator.js";
import { MiningQueryError } from "./bounded-query.js";

type Metric = "feed" | "density" | "vibration" | "water-energy";

function invalid(): never {
  throw new MiningQueryError("malformed", "Invalid current incident assessment.");
}

function instant(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) return invalid();
  return time;
}

function metricForTag(tagId: string): Metric | null {
  if (tagId.endsWith(".ore_flow")) return "feed";
  if (tagId.endsWith(".medium_density")) return "density";
  if (tagId.endsWith(".vibration_rms")) return "vibration";
  if (tagId === "D01.shared.water.level") return "water-energy";
  return null;
}

function ruleTarget(incident: MiningIncident) {
  const tags = new Map(D01_PLANT_CATALOG.telemetry_tags.map((tag) => [tag.id, tag]));
  const scope = incident.scopeId;
  const line = ["A", "B", "C"].includes(scope);
  let title: string;
  let moduleId: string | null;
  let metric: Metric | null;
  let allowedTags: string[];
  switch (incident.ruleId) {
    case "crusher-bearing":
      if (!line) return invalid();
      title = "Crusher bearing condition";
      moduleId = `D01.${scope}.crusher`;
      metric = "vibration";
      allowedTags = [`${moduleId}.vibration_rms`, `${moduleId}.bearing_temperature`];
      break;
    case "dms-condition":
      if (!line) return invalid();
      title = "DMS process condition";
      moduleId = `D01.${scope}.dms`;
      metric = "density";
      allowedTags = [`${moduleId}.medium_density`, `${moduleId}.feed_pressure`];
      break;
    case "shared-water":
      if (scope !== "shared") return invalid();
      title = "Shared water condition";
      moduleId = "D01.shared.water";
      metric = "water-energy";
      allowedTags = [`${moduleId}.level`];
      break;
    case "unplanned-stop":
      if (!line) return invalid();
      title = "Unplanned stop";
      moduleId = null;
      metric = null;
      allowedTags = [];
      break;
    case "telemetry-stale": {
      title = "Telemetry freshness";
      const tag = tags.get(scope);
      if (!tag) {
        if (!["state:A", "state:B", "state:C", "state:shared"].includes(scope)) return invalid();
        moduleId = null;
        metric = null;
        allowedTags = [];
      } else {
        moduleId = tag.module_id;
        metric = metricForTag(tag.id);
        allowedTags = [tag.id];
      }
      break;
    }
    default:
      return invalid();
  }
  if (moduleId && !D01_PLANT_CATALOG.modules.some((module) => module.id === moduleId)) {
    return invalid();
  }
  return { title, moduleId, metric, allowedTags, tags };
}

/**
 * Maps only the journal's current evaluation. Caller must independently authorize the run,
 * verify publisher/catalog provenance and establish source/deployment readiness before use.
 */
export function mapCurrentIncidentAssessments(input: {
  runId: string;
  catalogHash: string;
  asOf: string;
  assessments: readonly MiningIncidentAssessment[];
}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.runId) ||
      !/^[0-9a-f]{64}$/.test(input.catalogHash)) return invalid();
  const asOf = instant(input.asOf);
  const ids = new Set<string>();
  let rowCount = 0;
  const incidents = input.assessments.map((assessment) => {
    const incident = assessment.incident;
    if (
      assessment.runId !== input.runId ||
      assessment.plantId !== "D01" ||
      assessment.catalogHash !== input.catalogHash ||
      assessment.assessedAt !== input.asOf ||
      !/^[0-9a-f]{64}$/.test(incident.incidentId) ||
      ids.has(incident.incidentId) ||
      incident.clearedAt !== null ||
      !["warning", "high"].includes(incident.severity) ||
      !["verified", "unverified"].includes(incident.verification) ||
      instant(incident.raisedAt) > asOf
    ) return invalid();
    ids.add(incident.incidentId);
    if (incident.acknowledgedAt !== null && instant(incident.acknowledgedAt) < instant(incident.raisedAt)) {
      return invalid();
    }
    const start = instant(assessment.evidenceWindow.start);
    const end = instant(assessment.evidenceWindow.end);
    if (start > end || end !== asOf) return invalid();
    if (![null, "breach", "recovery"].includes(assessment.holdKind) ||
        (assessment.holdKind === null) !== (assessment.holdWindow === null)) return invalid();
    if (assessment.holdWindow) {
      const holdStart = instant(assessment.holdWindow.start);
      const holdEnd = instant(assessment.holdWindow.end);
      if (holdStart > holdEnd || holdEnd > asOf) return invalid();
    }
    const target = ruleTarget(incident);
    const evidence = assessment.evidence.map((item) => {
      const tag = target.tags.get(item.tagId);
      const sample = instant(item.timestamp);
      if (
        !tag ||
        !target.allowedTags.includes(item.tagId) ||
        tag.unit !== item.unit ||
        !Number.isFinite(item.value) ||
        !["good", "uncertain", "bad"].includes(item.quality) ||
        sample < start ||
        sample > end
      ) return invalid();
      if (item.ingestionTime !== null) instant(item.ingestionTime);
      return {
        tagId: tag.id,
        equipmentId: tag.equipment_id,
        moduleId: tag.module_id,
        value: item.value,
        unit: tag.unit,
        sampleTime: item.timestamp,
        ingestionTime: null,
        quality: item.quality,
        ageSeconds: Math.floor((asOf - sample) / 1000),
        normalBand: null,
      };
    });
    rowCount += 1 + evidence.length;
    if (rowCount > 1000) throw new MiningQueryError("overflow", "Mining incident response exceeds row limit.");
    return {
      incidentId: incident.incidentId,
      ruleId: incident.ruleId,
      scopeId: incident.scopeId,
      severity: incident.severity,
      raisedAt: incident.raisedAt,
      clearedAt: incident.clearedAt,
      acknowledgedAt: incident.acknowledgedAt,
      verification: incident.verification,
      moduleId: target.moduleId,
      affectedModuleIds: target.moduleId ? [target.moduleId] : [],
      metric: target.metric,
      title: target.title,
      holdWindowStart: assessment.holdWindow?.start ?? null,
      holdWindowEnd: assessment.holdWindow?.end ?? null,
      evidenceWindowStart: assessment.evidenceWindow.start,
      evidenceWindowEnd: assessment.evidenceWindow.end,
      evidence,
    };
  });
  const result = {
    plantId: "D01" as const,
    runId: input.runId,
    catalogVersion: D01_CATALOG_VERSION,
    asOf: input.asOf,
    incidents,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 1_048_576) {
    throw new MiningQueryError("overflow", "Mining incident response exceeds byte limit.");
  }
  return result;
}

/**
 * Validates the journal's reconstructed run and ordered catalog binding, not publisher provenance.
 * This remains unmounted until independently authorized source and deployment proof is available.
 */
export function mapCurrentIncidentJournal(input: {
  run: Pick<MiningRunRecord, "runId" | "startedAt" | "stopAt">;
  journal: NonNullable<Awaited<ReturnType<typeof readMiningIncidentJournal>>>;
}) {
  const run = createD01IncidentRun(input.run);
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  if (
    input.journal.runId !== run.runId ||
    input.journal.binding !== digest(run) ||
    input.journal.asOf === null
  ) return invalid();
  return mapCurrentIncidentAssessments({
    runId: run.runId,
    catalogHash: digest(run.tags),
    asOf: input.journal.asOf,
    assessments: input.journal.assessments,
  });
}
