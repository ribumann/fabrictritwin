import { describe, expect, it } from "vitest";
import { mapContinuousAdvisories } from "../src/mining/read/continuous-advisory-dto.js";
import type { ContinuousIncidentSnapshot } from "../src/mining-incidents/continuous-replay.js";

describe("continuous incident advisory response", () => {
  it("limits the response and exposes evidence without inventing incident history", () => {
    const snapshot: ContinuousIncidentSnapshot = {
      assessmentKind: "rolling-event-time-advisory",
      runId: "run",
      windowStart: "2026-01-01T00:00:00.000Z",
      asOf: "2026-01-01T00:20:00.000Z",
      sourceObservedAt: "2026-01-01T00:21:00.000Z",
      advisories: Array.from({ length: 21 }, (_, index) => ({
        ruleId: "crusher-bearing" as const,
        scopeId: `scope-${index}`,
        severity: index === 20 ? ("high" as const) : ("warning" as const),
        verification: "verified" as const,
        evidenceWindow: {
          start: "2026-01-01T00:18:00.000Z",
          end: "2026-01-01T00:20:00.000Z",
        },
        evidence: [
          {
            eventId: "internal-event",
            tagId: "D01.B.crusher.vibration_rms",
            value: 7,
            unit: "mm/s",
            timestamp: "2026-01-01T00:19:00.000Z",
            quality: "good" as const,
            ingestionTime: null,
          },
        ],
        stateEvidence: [],
        freshness: null,
      })),
    };
    const result = mapContinuousAdvisories(snapshot);
    expect(result).toMatchObject({
      assessmentKind: "rolling-event-time-advisory",
      plantId: "D01",
      totalAdvisories: 21,
    });
    expect(result.catalogVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.advisories[0]).toMatchObject({
      scopeId: "scope-20",
      severity: "high",
      evidence: [
        {
          tagId: "D01.B.crusher.vibration_rms",
          sampleTime: "2026-01-01T00:19:00.000Z",
        },
      ],
    });
    expect(result.advisories).toHaveLength(20);
    expect(result.advisories[0]).not.toHaveProperty("raisedAt");
    expect(result.advisories[0]).not.toHaveProperty("incidentId");
    expect(result.advisories[0]!.evidence[0]).not.toHaveProperty("eventId");
    expect(result.advisories[0]!.evidence[0]).not.toHaveProperty("ingestionTime");
  });
});
