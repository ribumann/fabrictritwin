import {
  MiningIncidentEvaluator,
  type MiningIncidentAssessment,
  type MiningReadingObservation,
  type MiningStateObservation,
  type MiningTag,
} from "./evaluator.js";

type Observation = MiningReadingObservation | MiningStateObservation;

export interface ContinuousIncidentAdvisory {
  ruleId: MiningIncidentAssessment["incident"]["ruleId"];
  scopeId: string;
  severity: MiningIncidentAssessment["incident"]["severity"];
  verification: MiningIncidentAssessment["incident"]["verification"];
  evidence: MiningIncidentAssessment["evidence"];
  stateEvidence: MiningIncidentAssessment["stateEvidence"];
  evidenceWindow: MiningIncidentAssessment["evidenceWindow"];
  freshness: MiningIncidentAssessment["freshness"];
}

export interface ContinuousIncidentSnapshot {
  assessmentKind: "rolling-event-time-advisory";
  runId: string;
  windowStart: string;
  asOf: string;
  sourceObservedAt: string;
  advisories: ContinuousIncidentAdvisory[];
}

const MINUTE = 60_000;
const WINDOW = 20 * MINUTE;

function instant(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("Continuous incident evidence requires canonical UTC timestamps.");
  }
  return parsed;
}

/**
 * Reconstructs only a bounded event-time snapshot. It is not a durable
 * incident history or a record of what was known at each historical minute.
 */
export function replayContinuousIncidentSnapshot(input: {
  runId: string;
  runStartedAt: string;
  asOf: string;
  sourceObservedAt: string;
  tags: readonly MiningTag[];
  observations: readonly Observation[];
}): ContinuousIncidentSnapshot {
  const start = instant(input.runStartedAt);
  const end = instant(input.asOf);
  const captured = instant(input.sourceObservedAt);
  if (end < start || end > captured || (end - start) % MINUTE !== 0) {
    throw new Error("Continuous incident snapshot requires an observed run-relative minute.");
  }
  const windowStart = Math.max(start, end - WINDOW);
  const ordered = [...input.observations].sort(
    (left, right) =>
      instant(left.timestamp) - instant(right.timestamp) ||
      (left.kind === "state" ? left.sequence : 0) - (right.kind === "state" ? right.sequence : 0) ||
      left.eventId.localeCompare(right.eventId),
  );
  if (
    ordered.some(
      (row) =>
        row.runId !== input.runId ||
        instant(row.timestamp) < windowStart ||
        instant(row.timestamp) > end,
    )
  ) {
    throw new Error("Continuous incident observation is outside the selected run and window.");
  }

  const evaluator = new MiningIncidentEvaluator(
    input.runId,
    new Date(windowStart).toISOString(),
    input.tags,
  );
  let cursor = 0;
  for (let at = windowStart; at <= end; at += MINUTE) {
    while (cursor < ordered.length && instant(ordered[cursor].timestamp) <= at) {
      evaluator.observe(ordered[cursor], input.sourceObservedAt);
      cursor++;
    }
    evaluator.evaluate(new Date(at).toISOString());
  }

  const advisories = evaluator.activeAssessments().map((assessment) => ({
    ruleId: assessment.incident.ruleId,
    scopeId: assessment.incident.scopeId,
    severity: assessment.incident.severity,
    verification: assessment.incident.verification,
    evidence: assessment.evidence,
    stateEvidence: assessment.stateEvidence,
    evidenceWindow: assessment.evidenceWindow,
    freshness: assessment.freshness,
  }));
  return {
    assessmentKind: "rolling-event-time-advisory",
    runId: input.runId,
    windowStart: new Date(windowStart).toISOString(),
    asOf: input.asOf,
    sourceObservedAt: input.sourceObservedAt,
    advisories,
  };
}
