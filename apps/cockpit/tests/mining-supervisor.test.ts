import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  buildupObservation,
  diagnosticAssets,
  investigationPrompt,
  latestFeedTotal,
  orePaths,
  plantEvidence,
  possibleBuildup,
} from "../src/ui/public/mining/supervisor.js";
import { renderTop } from "../src/ui/public/mining/plant.js";

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
  it("reports available live feed readings without turning missing lines into zero", () => {
    const now = Date.parse("2026-01-01T12:00:30.000Z");
    const feed = (line: string, value: number, sampleTime = "2026-01-01T12:00:25.000Z") => ({
      streamId: `process-${line}-feed`,
      quantity: "dry_solids_mass_flow",
      unit: "t/h",
      status: "OK",
      quality: "good",
      stale: false,
      sampleTime,
      value,
    });
    expect(latestFeedTotal([feed("A", 10), feed("B", 20)], now)).toEqual({
      value: 30,
      count: 2,
      oldestSampleTime: "2026-01-01T12:00:25.000Z",
      delayed: false,
    });
    expect(latestFeedTotal([feed("A", 10, "2026-01-01T11:57:00.000Z")], now)).toBeNull();
    expect(
      latestFeedTotal(
        [
          feed("A", 0),
          { ...feed("B", 20), quality: "bad" },
          feed("C", 30, "2026-01-01T11:59:30.000Z"),
        ],
        now,
      ),
    ).toEqual({
      value: 30,
      count: 2,
      oldestSampleTime: "2026-01-01T11:59:30.000Z",
      delayed: true,
    });
  });

  it("draws separate labeled solids and water lanes on an inspected connection", () => {
    class Element {
      attributes: Record<string, string> = {};
      children: Element[] = [];
      textContent = "";
      constructor(public tag: string) {}
      setAttribute(key: string, value: string) {
        this.attributes[key] = String(value);
      }
      append(...children: Element[]) {
        this.children.push(...children);
      }
      replaceChildren() {
        this.children = [];
      }
      addEventListener() {}
    }
    vi.stubGlobal("document", {
      createElementNS: (_namespace: string, tag: string) => new Element(tag),
    });
    try {
      const source = catalog.streams.find(
        (stream: { id: string }) => stream.id === "utility-A-fines",
      );
      const moduleIds = new Set([source.source.module_id, source.target.module_id]);
      const small = {
        ...catalog,
        modules: catalog.modules.filter((item: { id: string }) => moduleIds.has(item.id)),
        streams: [source],
      };
      const container = new Element("svg");
      const evidence = {
        readings: new Map(),
        measuredRoutes: new Map([
          [
            source.id,
            {
              components: [
                { quantity: "dry_solids_mass_flow", value: 10, unit: "t/h", width: 0.4 },
                { quantity: "water_volume_flow", value: 20, unit: "m3/h", width: 0.3 },
              ],
            },
          ],
        ]),
      };
      renderTop(
        container,
        small,
        new Set(["A", "shared"]),
        true,
        source.source.module_id,
        () => {},
        new Map(),
        new Set(),
        evidence,
      );
      const routes = container.children.filter((item) => item.tag === "polyline");
      expect(routes.map((item) => item.attributes["data-route"])).toEqual(["observed", "water"]);
      expect(routes.map((item) => item.attributes["stroke-width"])).toEqual(["0.4", "0.3"]);
      expect(
        container.children.some((item) => item.textContent === "solids 10 t/h · water 20 m3/h"),
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses separate measured solids and water components without treating missing as zero", () => {
    const reading = {
      streamId: "utility-A-fines",
      status: "OK",
      quality: "good",
      stale: false,
      sampleTime: "2026-01-01T12:00:25.000Z",
      value: 10,
      nominalCapacity: 20,
      quantity: "dry_solids_mass_flow",
      unit: "t/h",
    };
    const water = {
      ...reading,
      quantity: "water_volume_flow",
      unit: "m3/h",
      value: 0,
      nominalCapacity: 100,
    };
    const now = Date.parse("2026-01-01T12:00:30.000Z");
    const evidence = plantEvidence(catalog, () => null, String, null, [reading, water], now);
    expect(evidence.measuredRoutes.get(reading.streamId)?.components).toEqual([
      {
        quantity: "dry_solids_mass_flow",
        value: 10,
        unit: "t/h",
        width: 0.455,
        delayed: false,
        sampleTime: reading.sampleTime,
      },
      {
        quantity: "water_volume_flow",
        value: 0,
        unit: "m3/h",
        width: 0.18,
        delayed: false,
        sampleTime: reading.sampleTime,
      },
    ]);
    expect(evidence.activeRoutes.has(reading.streamId)).toBe(true);
    expect(
      plantEvidence(
        catalog,
        () => ({ value: 42 }),
        String,
        null,
        [
          { ...reading, status: "MISSING", value: null },
          { ...water, stale: true },
        ],
        now,
      ).measuredRoutes.size,
    ).toBe(0);
    expect(
      plantEvidence(catalog, () => null, String, null, [reading, reading], now).measuredRoutes.size,
    ).toBe(0);
    expect(
      plantEvidence(catalog, () => null, String, null, [reading], now + 116_000).measuredRoutes
        .size,
    ).toBe(0);
  });

  it("shows delayed good observations with their sample time but never as current", () => {
    const now = Date.parse("2026-01-01T12:01:00.000Z");
    const reading = {
      streamId: "utility-A-fines",
      status: "STALE",
      quality: "good",
      stale: true,
      sampleTime: "2026-01-01T12:00:20.000Z",
      value: 10,
      nominalCapacity: 20,
      quantity: "dry_solids_mass_flow",
      unit: "t/h",
    };
    const component = plantEvidence(
      catalog,
      () => null,
      String,
      null,
      [reading],
      now,
    ).measuredRoutes.get(reading.streamId)?.components[0];
    expect(component).toMatchObject({ delayed: true, sampleTime: reading.sampleTime, value: 10 });
    expect(
      plantEvidence(catalog, () => null, String, null, [reading], now + 80_001).measuredRoutes.size,
    ).toBe(0);
    expect(
      plantEvidence(catalog, () => null, String, null, [{ ...reading, quality: "bad" }], now)
        .measuredRoutes.size,
    ).toBe(0);
  });

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
