import { describe, expect, it } from "vitest";
import { D01_PLANT_CATALOG } from "@triathlon-twin/simulator/mining";
import { mapCurrentIncidentAssessments } from "../src/mining/read/incident-dto.js";

const runId = "123e4567-e89b-42d3-a456-426614174000";
const asOf = "2026-01-01T00:05:00.000Z";
const catalogHash = "a".repeat(64);

function assessment(ruleId: "crusher-bearing" | "dms-condition" | "shared-water" | "unplanned-stop" | "telemetry-stale", scopeId: string) {
  return {
    runId,
    plantId: "D01" as const,
    catalogHash,
    assessedAt: asOf,
    incident: {
      incidentId: "b".repeat(64),
      ruleId,
      scopeId,
      severity: "warning" as const,
      raisedAt: "2026-01-01T00:03:00.000Z",
      clearedAt: null,
      acknowledgedAt: "2026-01-01T00:06:00.000Z",
      verification: "unverified" as const,
    },
    holdKind: null,
    holdWindow: null,
    evidenceWindow: { start: "2026-01-01T00:02:00.000Z", end: asOf },
    evidence: [],
  };
}

function map(value: ReturnType<typeof assessment>) {
  return mapCurrentIncidentAssessments({ runId, catalogHash, asOf, assessments: [value] });
}

describe("current incident assessment mapping", () => {
  it.each([
    ["crusher-bearing", "A", "D01.A.crusher", "vibration"],
    ["dms-condition", "B", "D01.B.dms", "density"],
    ["shared-water", "shared", "D01.shared.water", "water-energy"],
    ["unplanned-stop", "C", null, null],
    ["telemetry-stale", "state:A", null, null],
    ["telemetry-stale", "D01.A.crusher.vibration_rms", "D01.A.crusher", "vibration"],
    ["telemetry-stale", "D01.A.crusher.bearing_temperature", "D01.A.crusher", null],
  ] as const)("maps %s scope %s without inventing targets", (rule, scope, moduleId, metric) => {
    const result = map(assessment(rule, scope));
    expect(result.asOf).toBe(asOf);
    expect(result.incidents[0]).toMatchObject({
      moduleId,
      metric,
      affectedModuleIds: moduleId ? [moduleId] : [],
      acknowledgedAt: "2026-01-01T00:06:00.000Z",
      holdWindowStart: null,
      holdWindowEnd: null,
      verification: "unverified",
    });
  });

  it("preserves evidence quality and withholds unproven ingestion time", () => {
    const tag = D01_PLANT_CATALOG.telemetry_tags.find((item) => item.id === "D01.A.crusher.vibration_rms")!;
    const value = assessment("crusher-bearing", "A");
    const evidence = {
      eventId: "c".repeat(64),
      tagId: tag.id,
      unit: tag.unit,
      value: 2,
      timestamp: "2026-01-01T00:04:30.000Z",
      ingestionTime: asOf,
      quality: "uncertain" as const,
    };
    const result = mapCurrentIncidentAssessments({
      runId, catalogHash, asOf, assessments: [{ ...value, evidence: [evidence] }],
    });
    expect(result.incidents[0].evidence[0]).toMatchObject({
      tagId: tag.id, equipmentId: tag.equipment_id, moduleId: tag.module_id,
      quality: "uncertain", ingestionTime: null, ageSeconds: 30,
    });
    expect(() => mapCurrentIncidentAssessments({
      runId, catalogHash, asOf, assessments: [{ ...value, evidence: [{ ...evidence, unit: "wrong" }] }],
    })).toThrow();
    expect(() => mapCurrentIncidentAssessments({
      runId, catalogHash, asOf, assessments: [{ ...value, evidence: [{ ...evidence, value: NaN }] }],
    })).toThrow();
  });

  it("rejects mismatched snapshots, malformed targets and duplicate incidents", () => {
    const value = assessment("crusher-bearing", "A");
    expect(() => map({ ...value, assessedAt: "2026-01-01T00:04:00.000Z" })).toThrow();
    expect(() => map({ ...value, catalogHash: "c".repeat(64) })).toThrow();
    expect(() => map(assessment("crusher-bearing", "shared"))).toThrow();
    expect(() => mapCurrentIncidentAssessments({ runId, catalogHash, asOf, assessments: [value, value] })).toThrow();
  });
});
