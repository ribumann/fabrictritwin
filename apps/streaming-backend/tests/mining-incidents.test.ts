import { describe, expect, it } from "vitest";
import {
  MiningIncidentEvaluator,
  type MiningTag,
  type MiningReadingObservation,
  type MiningStateObservation,
} from "../src/mining-incidents/evaluator.js";

const START = Date.parse("2026-11-12T12:00:00.000Z");
const RUN = "test-run";
const iso = (seconds: number) => new Date(START + seconds * 1000).toISOString();
const RMS = "D01.B.crusher.vibration_rms";
const TEMP = "D01.B.crusher.bearing_temperature";
const DENSITY = "D01.C.dms.medium_density";
const PRESSURE = "D01.C.dms.feed_pressure";
const WATER = "D01.shared.water.level";
const TAGS: MiningTag[] = [
  { tagId: RMS, moduleId: "D01.B.crusher", scopeId: "B", unit: "mm/s", intervalSeconds: 30 },
  { tagId: TEMP, moduleId: "D01.B.crusher", scopeId: "B", unit: "Cel", intervalSeconds: 60 },
  { tagId: DENSITY, moduleId: "D01.C.dms", scopeId: "C", unit: "kg/m3", intervalSeconds: 30 },
  { tagId: PRESSURE, moduleId: "D01.C.dms", scopeId: "C", unit: "kPa", intervalSeconds: 30 },
  { tagId: WATER, moduleId: "D01.shared.water", scopeId: "shared", unit: "%", intervalSeconds: 60 },
];

function reading(
  evaluator: MiningIncidentEvaluator,
  tagId: string,
  at: number,
  value: number,
  quality: MiningReadingObservation["quality"] = "good",
): MiningReadingObservation {
  const tag = TAGS.find((entry) => entry.tagId === tagId)!;
  const row: MiningReadingObservation = {
    kind: "reading",
    runId: RUN,
    eventId: `${tagId}:${at}`,
    timestamp: iso(at),
    tagId,
    value,
    quality,
    unit: tag.unit,
    intervalSeconds: tag.intervalSeconds,
  };
  evaluator.observe(row, iso(at));
  return row;
}

function state(
  evaluator: MiningIncidentEvaluator,
  scopeId: MiningStateObservation["scopeId"],
  at: number,
  value: MiningStateObservation["state"] = "running",
  scheduledRunning = true,
  sequence = at * 2,
): void {
  evaluator.observe(
    {
      kind: "state",
      runId: RUN,
      eventId: `${scopeId}:${at}:${sequence}`,
      timestamp: iso(at),
      scopeId,
      state: value,
      scheduledRunning,
      sequence,
    },
    iso(at),
  );
}

function feed(
  evaluator: MiningIncidentEvaluator,
  from: number,
  through: number,
  values: Partial<Record<string, number>> = {},
): void {
  for (let at = from; at <= through; at += 30) {
    if (at % 60 === 0)
      for (const scope of ["A", "B", "C", "shared"] as const) state(evaluator, scope, at);
    for (const tag of TAGS) {
      if (at > 0 && at % tag.intervalSeconds === 0) {
        reading(
          evaluator,
          tag.tagId,
          at,
          values[tag.tagId] ??
            { [RMS]: 2.4, [TEMP]: 55, [DENSITY]: 2920, [PRESSURE]: 300, [WATER]: 65 }[tag.tagId] ??
            0,
        );
      }
    }
  }
}

describe("measurement-derived mining advisories", () => {
  it("suppresses startup, raises bearing after full windows, escalates, and clears independently of acknowledgement", () => {
    const evaluator = new MiningIncidentEvaluator(RUN, iso(0), TAGS);
    feed(evaluator, 0, 180, { [RMS]: 7 });
    expect(
      evaluator.evaluate(iso(180)).filter((row) => row.incident.ruleId === "crusher-bearing"),
    ).toEqual([]);
    feed(evaluator, 210, 240, { [RMS]: 7 });
    const raised = evaluator
      .evaluate(iso(240))
      .find((row) => row.incident.ruleId === "crusher-bearing")!;
    expect(raised.transition).toBe("raised");
    expect(raised.incident.severity).toBe("warning");
    evaluator.acknowledge(raised.incident.incidentId, iso(240));
    expect(evaluator.evaluate(iso(240))).toEqual([]);
    feed(evaluator, 270, 360, { [RMS]: 7, [TEMP]: 82 });
    expect(
      evaluator.evaluate(iso(360)).some((row) => row.incident.ruleId === "crusher-bearing"),
    ).toBe(false);
    feed(evaluator, 390, 420, { [RMS]: 7, [TEMP]: 82 });
    const escalated = evaluator
      .evaluate(iso(420))
      .find((row) => row.incident.ruleId === "crusher-bearing")!;
    expect(escalated.transition).toBe("escalated");
    expect(escalated.incident.acknowledgedAt).toBe(iso(240));
    feed(evaluator, 450, 600);
    expect(
      evaluator.evaluate(iso(600)).some((row) => row.incident.ruleId === "crusher-bearing"),
    ).toBe(false);
    feed(evaluator, 630, 660);
    const cleared = evaluator
      .evaluate(iso(660))
      .find((row) => row.incident.ruleId === "crusher-bearing")!;
    expect(cleared.transition).toBe("cleared");
    expect(cleared.evidenceWindow).toEqual({ start: iso(480), end: iso(660) });
    expect(cleared.evidence.every((row) => row.quality === "good")).toBe(true);
  });

  it("resets holds on missing/bad data, retains incidents as unverified, and does not repair holds with late backfill", () => {
    const evaluator = new MiningIncidentEvaluator(RUN, iso(0), TAGS);
    feed(evaluator, 0, 240, { [RMS]: 7 });
    evaluator.evaluate(iso(240));
    state(evaluator, "B", 300);
    reading(evaluator, TEMP, 300, 55);
    evaluator.evaluate(iso(300));
    expect(evaluator.active().find((row) => row.ruleId === "crusher-bearing")?.verification).toBe(
      "unverified",
    );
    reading(evaluator, RMS, 270, 2.4);
    reading(evaluator, RMS, 300, 2.4, "bad");
    feed(evaluator, 330, 420);
    expect(
      evaluator
        .evaluate(iso(420))
        .some((row) => row.incident.ruleId === "crusher-bearing" && row.transition === "cleared"),
    ).toBe(false);
    feed(evaluator, 450, 480);
    expect(
      evaluator
        .evaluate(iso(480))
        .some((row) => row.incident.ruleId === "crusher-bearing" && row.transition === "cleared"),
    ).toBe(true);
  });

  it("uses DMS pressure as an independent trigger and requires both clear bands, including hysteresis", () => {
    const evaluator = new MiningIncidentEvaluator(RUN, iso(0), TAGS);
    feed(evaluator, 0, 240, { [PRESSURE]: 410 });
    expect(
      evaluator.evaluate(iso(240)).find((row) => row.incident.ruleId === "dms-condition")
        ?.transition,
    ).toBe("raised");
    feed(evaluator, 270, 420, { [DENSITY]: 2820 });
    expect(
      evaluator.evaluate(iso(420)).some((row) => row.incident.ruleId === "dms-condition"),
    ).toBe(false);
    feed(evaluator, 450, 600);
    expect(
      evaluator.evaluate(iso(600)).find((row) => row.incident.ruleId === "dms-condition")
        ?.transition,
    ).toBe("cleared");
  });

  it("raises only one shared-water incident and never clears it from missing measurements", () => {
    const evaluator = new MiningIncidentEvaluator(RUN, iso(0), TAGS);
    feed(evaluator, 0, 240, { [WATER]: 24 });
    const water = evaluator
      .evaluate(iso(240))
      .filter((row) => row.incident.ruleId === "shared-water");
    expect(water).toHaveLength(1);
    expect(water[0].incident.scopeId).toBe("shared");
    expect(water[0].incident.severity).toBe("high");
    for (const at of [300, 360, 420]) state(evaluator, "shared", at);
    evaluator.evaluate(iso(420));
    expect(evaluator.active().find((row) => row.ruleId === "shared-water")?.verification).toBe(
      "unverified",
    );
  });

  it("holds the DMS OR condition continuously when the failing sensor alternates", () => {
    const evaluator = new MiningIncidentEvaluator(RUN, iso(0), TAGS);
    for (let at = 0; at <= 240; at += 30) {
      feed(evaluator, at, at, {
        [DENSITY]: at % 60 === 0 ? 2920 : 2670,
        [PRESSURE]: at % 60 === 0 ? 410 : 300,
      });
    }
    expect(
      evaluator.evaluate(iso(240)).find((row) => row.incident.ruleId === "dms-condition")
        ?.transition,
    ).toBe("raised");
  });

  it("does not use unrelated screen quality to invalidate crusher-bearing evidence", () => {
    const screen: MiningTag = {
      tagId: "D01.B.screen.vibration_rms",
      moduleId: "D01.B.screen",
      scopeId: "B",
      unit: "mm/s",
      intervalSeconds: 30,
    };
    const evaluator = new MiningIncidentEvaluator(RUN, iso(0), [...TAGS, screen]);
    feed(evaluator, 0, 240, { [RMS]: 7 });
    evaluator.evaluate(iso(240));
    evaluator.observe(
      {
        kind: "reading",
        runId: RUN,
        eventId: "screen:270",
        timestamp: iso(270),
        tagId: screen.tagId,
        value: 12,
        quality: "bad",
        unit: screen.unit,
        intervalSeconds: screen.intervalSeconds,
      },
      iso(270),
    );
    expect(evaluator.active().find((row) => row.ruleId === "crusher-bearing")?.verification).toBe(
      "verified",
    );
  });

  it("excludes planned stops and clears an unplanned stop only after observed running", () => {
    const evaluator = new MiningIncidentEvaluator(RUN, iso(0), TAGS);
    for (const at of [0, 60, 120]) state(evaluator, "A", at, "stopped", false);
    expect(
      evaluator.evaluate(iso(120)).some((row) => row.incident.ruleId === "unplanned-stop"),
    ).toBe(false);
    for (const at of [180, 240, 300]) state(evaluator, "A", at, at === 240 ? "fault" : "stopped");
    expect(
      evaluator.evaluate(iso(300)).find((row) => row.incident.ruleId === "unplanned-stop")
        ?.transition,
    ).toBe("raised");
    for (const at of [360, 420, 480]) state(evaluator, "A", at);
    expect(
      evaluator.evaluate(iso(480)).find((row) => row.incident.ruleId === "unplanned-stop")
        ?.transition,
    ).toBe("cleared");
  });

  it("uses per-tag and heartbeat freshness and needs two new good observations to clear", () => {
    const evaluator = new MiningIncidentEvaluator(RUN, iso(0), TAGS);
    feed(evaluator, 0, 60);
    evaluator.evaluate(iso(180));
    expect(evaluator.active().some((row) => row.scopeId === RMS)).toBe(true);
    expect(evaluator.active().some((row) => row.scopeId === WATER)).toBe(false);
    evaluator.evaluate(iso(300));
    expect(evaluator.active().some((row) => row.scopeId === WATER)).toBe(true);
    expect(evaluator.active().some((row) => row.scopeId === "state:B")).toBe(true);
    reading(evaluator, WATER, 360, 65);
    state(evaluator, "B", 360);
    expect(
      evaluator
        .evaluate(iso(360))
        .some(
          (row) =>
            row.transition === "cleared" && [WATER, "state:B"].includes(row.incident.scopeId),
        ),
    ).toBe(false);
    reading(evaluator, WATER, 420, 65);
    state(evaluator, "B", 420);
    expect(
      evaluator
        .evaluate(iso(420))
        .filter(
          (row) =>
            row.transition === "cleared" && [WATER, "state:B"].includes(row.incident.scopeId),
        ),
    ).toHaveLength(2);
  });

  it("deduplicates observations, rejects conflicts/future timestamps, and applies same-time transitions after heartbeats", () => {
    const evaluator = new MiningIncidentEvaluator(RUN, iso(0), TAGS);
    const row = reading(evaluator, RMS, 30, 7);
    const { intervalSeconds, ...rest } = row;
    evaluator.observe({ intervalSeconds, ...rest }, iso(30));
    expect(() => evaluator.observe({ ...row, value: 8 }, iso(30))).toThrow("Conflicting");
    expect(() =>
      evaluator.observe({ ...row, eventId: "future", timestamp: iso(60) }, iso(30)),
    ).toThrow("time");
    state(evaluator, "B", 0, "stopped", true, 1);
    state(evaluator, "B", 0, "running", true, 0);
    state(evaluator, "B", 60, "stopped");
    state(evaluator, "B", 120, "stopped");
    expect(
      evaluator.evaluate(iso(120)).find((event) => event.incident.ruleId === "unplanned-stop")
        ?.transition,
    ).toBe("raised");
  });

  it("marks a bad or uncertain latest arrival unverified before the next evaluation", () => {
    for (const quality of ["bad", "uncertain"] as const) {
      const evaluator = new MiningIncidentEvaluator(RUN, iso(0), TAGS);
      feed(evaluator, 0, 240, { [RMS]: 7 });
      evaluator.evaluate(iso(240));
      reading(evaluator, RMS, 270, 2.4, quality);
      expect(evaluator.active().find((row) => row.ruleId === "crusher-bearing")?.verification).toBe(
        "unverified",
      );
      feed(evaluator, 300, 420);
      expect(
        evaluator.evaluate(iso(420)).some((row) => row.incident.ruleId === "crusher-bearing"),
      ).toBe(false);
      feed(evaluator, 450, 480);
      expect(
        evaluator.evaluate(iso(480)).find((row) => row.incident.ruleId === "crusher-bearing")
          ?.transition,
      ).toBe("cleared");
    }
  });

  it("does not raise a process incident when the current completed window is missing", () => {
    const evaluator = new MiningIncidentEvaluator(RUN, iso(0), TAGS);
    feed(evaluator, 0, 210, { [RMS]: 7 });
    state(evaluator, "B", 240);
    reading(evaluator, TEMP, 240, 55);
    expect(
      evaluator.evaluate(iso(240)).some((row) => row.incident.ruleId === "crusher-bearing"),
    ).toBe(false);
  });

  it("attaches actual state evidence and freshness anchors without inventing a heartbeat flag", () => {
    const evaluator = new MiningIncidentEvaluator(RUN, iso(0), TAGS);
    for (const at of [0, 60, 120]) state(evaluator, "B", at, "fault");
    const stopped = evaluator
      .evaluate(iso(120))
      .find((row) => row.incident.ruleId === "unplanned-stop")!;
    expect(stopped.stateEvidence.map((row) => row.timestamp)).toEqual([iso(0), iso(60), iso(120)]);
    const stale = evaluator.evaluate(iso(360)).find((row) => row.incident.scopeId === "state:B")!;
    expect(stale.freshness).toEqual({
      lastValidAt: iso(120),
      intervalSeconds: 60,
      staleAfterSeconds: 195,
    });
    expect(stale.evidenceWindow).toEqual({ start: iso(180), end: iso(360) });
    expect(stale.stateEvidence).toEqual([]);
  });

  it("accepts fresh state transitions between periodic records without counting same-time events twice", () => {
    const evaluator = new MiningIncidentEvaluator(RUN, iso(0), TAGS);
    state(evaluator, "B", 0);
    evaluator.evaluate(iso(240));
    state(evaluator, "B", 300, "running", true, 600);
    state(evaluator, "B", 300, "fault", true, 601);
    expect(
      evaluator
        .evaluate(iso(300))
        .some((row) => row.incident.scopeId === "state:B" && row.transition === "cleared"),
    ).toBe(false);
    state(evaluator, "B", 330);
    expect(
      evaluator.evaluate(iso(360)).find((row) => row.incident.scopeId === "state:B")?.transition,
    ).toBe("cleared");
  });
});
