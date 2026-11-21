import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildupObservation,
  diagnosticAssets,
  investigationPrompt,
  orePaths,
  plantEvidence,
  possibleBuildup,
} from "../src/ui/public/mining/supervisor.js";

const catalog = JSON.parse(
  readFileSync(new URL("../../simulator/src/mining/plant-catalog.json", import.meta.url), "utf8"),
);
const time = Date.parse("2026-03-01T00:02:00Z");
const readings = (at: number, level: number, feed: number) =>
  ["D01.shared.hopper.level", ...["A", "B", "C"].map((line) => `D01.${line}.crusher.ore_flow`)].map(
    (tagId, index) => ({
      tagId,
      quality: "good",
      sampleTime: new Date(at).toISOString(),
      ageSeconds: 0,
      value: index === 0 ? level : feed,
    }),
  );
const at = (sample: number, level: number, feed: number) =>
  buildupObservation(readings(sample, level, feed), new Date(sample).toISOString());

describe("Mining supervisor evidence", () => {
  it("scales only measured inlet routes, including zero, without assigning water to branches", () => {
    const records = new Map([
      ["D01.A.crusher.ore_flow", { value: 42 }],
      ["D01.B.crusher.ore_flow", { value: 0 }],
      ["D01.C.sorter.ore_flow", { value: 7 }],
    ]);
    const evidence = plantEvidence(catalog, (id) => records.get(id), String, "D01.B.dms");
    const active = catalog.streams.filter((route) => evidence.activeRoutes.has(route.id));
    expect(active.map((route) => route.target.module_id)).toEqual([
      "D01.A.crusher",
      "D01.C.sorter",
    ]);
    expect(evidence.readings.get("D01.B.crusher")?.label).toContain("0 t/h");
    expect(evidence.readings.get("D01.C.crusher")?.label).toContain("unknown");
    expect(evidence.readings.has("D01.A.dms")).toBe(false);
    expect(evidence.readings.has("D01.B.dms")).toBe(true);
    const measured = catalog.streams.filter((route) => evidence.measuredRoutes.has(route.id));
    expect(measured.map((route) => route.target.module_id)).toEqual([
      "D01.A.crusher",
      "D01.B.crusher",
      "D01.C.sorter",
    ]);
    expect(evidence.measuredRoutes.get(measured[1].id)).toMatchObject({
      value: 0,
      unit: "t/h",
      width: 0.18,
    });
    expect(evidence.measuredRoutes.get(measured[0].id)!.width).toBeGreaterThan(0.18);
    const invalid = plantEvidence(catalog, () => ({ value: -1 }), String, null);
    expect(invalid.measuredRoutes.size).toBe(0);
  });

  it("drafts a bounded investigation from the selected asset and evidence timestamp", () => {
    const draft = investigationPrompt({
      moduleId: "D01.B.crusher",
      incident: { ruleId: "bearing-b-condition", scopeId: "B" },
      asOf: "2026-03-01T00:02:00Z",
    });
    expect(draft).toContain("D01.B.crusher");
    expect(draft).toContain("bearing-b-condition (B)");
    expect(draft).toContain("2026-03-01T00:02:00.000Z");
  });
  it("follows the authored ore circuit and only offers compatible diagnostic modules", () => {
    expect(orePaths(catalog).map(({ modules }) => modules.map(({ kind }) => kind))).toEqual(
      Array.from({ length: 3 }, () => ["crusher", "scrubber", "screen", "dms", "medium", "sorter"]),
    );
    expect(diagnosticAssets(catalog, "water-energy").map(({ id }) => id)).toEqual([
      "D01.shared.water",
    ]);
    expect(diagnosticAssets(catalog, "vibration").map(({ id }) => id)).toEqual(
      ["A", "B", "C"].map((line) => `D01.${line}.crusher`),
    );
  });

  it("requires two aligned credible observations before suggesting possible buildup", () => {
    const before = at(time - 30_000, 65, 42);
    expect(possibleBuildup(before, at(time, 65.5, 40))).toBe(true);
    expect(possibleBuildup(before, at(time, 65.5, 42))).toBe(false);
    expect(possibleBuildup(at(time - 120_000, 65, 42), at(time, 65.5, 40))).toBe(false);
    const missing = readings(time, 65.5, 40);
    missing[1].quality = "missing";
    expect(buildupObservation(missing, new Date(time).toISOString())).toBeNull();
    const misaligned = readings(time, 65.5, 40);
    misaligned[1].sampleTime = new Date(time - 30_000).toISOString();
    misaligned[1].ageSeconds = 30;
    expect(buildupObservation(misaligned, new Date(time).toISOString())).toBeNull();
  });
});
