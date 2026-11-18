import { D01_CATALOG_VERSION, D01_PLANT_ID } from "@triathlon-twin/simulator/mining";
import type { ContinuousIncidentSnapshot } from "../../mining-incidents/continuous-replay.js";

/** Public event-time assessments; these are not durable incident records. */
export function mapContinuousAdvisories(snapshot: ContinuousIncidentSnapshot) {
  const advisories = [...snapshot.advisories]
    .sort(
      (left, right) =>
        Number(right.severity === "high") - Number(left.severity === "high") ||
        left.ruleId.localeCompare(right.ruleId) ||
        left.scopeId.localeCompare(right.scopeId),
    )
    .slice(0, 20)
    .map((item) => ({
      ruleId: item.ruleId,
      scopeId: item.scopeId,
      severity: item.severity,
      verification: item.verification,
      evidenceWindow: item.evidenceWindow,
      evidence: item.evidence.map((row) => ({
        tagId: row.tagId,
        value: row.value,
        unit: row.unit,
        sampleTime: row.timestamp,
        quality: row.quality,
      })),
      stateEvidence: item.stateEvidence.map((row) => ({
        scopeId: row.scopeId,
        state: row.state,
        scheduledRunning: row.scheduledRunning,
        sampleTime: row.timestamp,
      })),
      freshness: item.freshness,
    }));
  return {
    assessmentKind: snapshot.assessmentKind,
    plantId: D01_PLANT_ID,
    catalogVersion: D01_CATALOG_VERSION,
    runId: snapshot.runId,
    windowStart: snapshot.windowStart,
    asOf: snapshot.asOf,
    sourceObservedAt: snapshot.sourceObservedAt,
    totalAdvisories: snapshot.advisories.length,
    advisories,
  };
}
