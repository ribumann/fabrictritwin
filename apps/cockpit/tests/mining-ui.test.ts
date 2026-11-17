import { readFileSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { D01PlantCatalog } from "@triathlon-twin/simulator/mining";
import {
  MiningReads,
  MiningPolling,
  usable,
  formatTimestamp,
  readingAt,
  normalizeReading,
  unknownQuality,
  validIncidentWindows,
  validIncidentAssociation,
  refreshedIncidentSelection,
  sameScope,
  moduleStatus,
  validOverview,
  validAsOf,
  currentIncidentQuery,
  validCurrentAssessmentAsOf,
  validIncidentAssessment,
  incidentAssessmentLabel,
  validSeries,
  seriesQuery,
  verifiedRunIngestion,
  validContinuousOverview,
  continuousThroughputUsable,
  continuousTagReading,
  continuousRunningLines,
} from "../src/ui/public/mining/data.js";
import {
  connections,
  createPlant3D,
  relevantTags,
  visibleModules,
} from "../src/ui/public/mining/plant.js";
import {
  APPEARANCE_RELEASE,
  fitModelToNode,
  fitSplatToNode,
  localSplatPath,
  readBoundedBytes,
  splatFit,
  validateAppearanceBundle,
} from "../src/ui/public/mining/appearance.js";

const reconstructedSource = new URL(
  "../src/ui/public/mining/plant/reconstructed/source/",
  import.meta.url,
);
const readJson = (path: string) =>
  JSON.parse(readFileSync(new URL(path, reconstructedSource), "utf8"));
const readCatalog = (): D01PlantCatalog =>
  JSON.parse(
    readFileSync(new URL("../../simulator/src/mining/plant-catalog.json", import.meta.url), "utf8"),
  );
const loadAppearanceBundle = () =>
  validateAppearanceBundle(
    readCatalog(),
    readJson("metadata.json"),
    readJson("D01.json"),
    readJson("files.json"),
    readJson("quality.json"),
  );

afterEach(() => vi.useRealTimers());
describe("continuous throughput presentation", () => {
  function fixture() {
    const runId = "11111111-1111-4111-8111-111111111111";
    return {
      mode: "continuous",
      plantId: "D01",
      runId,
      catalogVersion: "catalog",
      generation: "release-1",
      quality: "good",
      asOf: "2026-01-01T12:00:00Z",
      watermark: "2026-01-01T11:59:00Z",
      windowStart: "2026-01-01T11:54:00Z",
      windowEnd: "2026-01-01T11:59:00Z",
      run: {
        plantId: "D01",
        runId,
        catalogVersion: "catalog",
        generation: "release-1",
        publisherStatus: "running",
        stopRequested: false,
        authorityUntil: "2026-01-01T12:00:45Z",
      },
      source: { workspace: "triatwin-dev-fabric", database: "mining-d01-realtime" },
      capabilities: { incidents: false, trends: false },
      throughput: { value: 126, unit: "t/h", quality: "good" },
      readings: ["A", "B", "C"].map((line) => ({
        tagId: `D01.${line}.crusher.ore_flow`,
        quality: "good",
        value: 42,
        average: 42,
        unit: "t/h",
        coverage: 1,
        sampleTime: "2026-01-01T11:59:00Z",
        latestSampleTime: "2026-01-01T11:59:00Z",
        receivedAt: "2026-01-01T11:59:35Z",
      })),
    };
  }
  const now = Date.parse("2026-01-01T12:00:00Z");
  function withDetail(data: ReturnType<typeof fixture>) {
    const catalog = readCatalog();
    const eventId = (sequence: number) => sequence.toString(16).padStart(64, "0");
    const readings = data.readings.map((reading, index) => {
      const tag = catalog.telemetry_tags.find((item) => item.id === reading.tagId)!;
      return {
        ...reading,
        moduleId: tag.module_id,
        sourceStatus: "READY",
        latestValue: reading.value,
        latestQuality: "good",
        latestSampleTime: "2026-01-01T11:59:30Z",
        latestReceivedAt: "2026-01-01T11:59:35Z",
        ageSeconds: 30,
        latestEventId: eventId(index + 1),
        latestSequence: index + 1,
      };
    });
    const detailReadings = catalog.telemetry_tags
      .filter((tag) => !readings.some((reading) => reading.tagId === tag.id))
      .map((tag, index) => {
        const age = ["bearing_temperature", "level", "product_mass"].includes(tag.metric) ? 60 : 30;
        const cadence = age;
        const sampleTime = new Date(Date.parse(data.asOf) - age * 1000).toISOString();
        return {
          tagId: tag.id,
          moduleId: tag.module_id,
          equipmentId: tag.equipment_id,
          unit: tag.unit,
          cadenceSeconds: cadence,
          quality: "good",
          value: (tag.simulation_envelope[0] + tag.simulation_envelope[1]) / 2,
          sampleTime,
          receivedAt: new Date(Date.parse(sampleTime) + 1000).toISOString(),
          ageSeconds: age,
          eventId: eventId(index + 10),
          sequence: index + 10,
        };
      });
    const detailedData = {
      ...data,
      readings,
      detail: {
        plantId: "D01",
        runId: data.runId,
        generation: data.generation,
        asOf: data.asOf,
        catalogVersion: data.catalogVersion,
        profileVersion: "d01-publish-profile-v1",
        sourceContractVersion: "d01-validated-source-v1",
        sourceStatus: "READY",
        readings: detailReadings,
        lineStates: ["A", "B", "C"].map((scopeId, index) => ({
          scopeId,
          state: "running",
          scheduledRunning: true,
          quality: "good",
          sampleTime: "2026-01-01T11:59:45Z",
          receivedAt: "2026-01-01T11:59:46Z",
          ageSeconds: 15,
          eventId: eventId(index + 100),
          sequence: index + 100,
        })),
        runningLines: { value: 3, unit: "lines", quality: "good" },
      },
    };
    return { data: detailedData, catalog };
  }
  it("accepts only pinned scope/generation and never fabricates finite overview evidence", () => {
    const data = fixture();
    expect(validContinuousOverview(data, data.runId, "catalog", "release-1", now)).toBe(true);
    expect(validContinuousOverview(data, data.runId, "catalog", "release-2", now)).toBe(false);
    expect(continuousThroughputUsable(data, now)).toBe(true);
    expect(validOverview(data, data.runId, "catalog", data.asOf, false, now)).toBe(false);
  });
  it("accepts a complete pinned detail bundle and exposes only direct readings and reported line state", () => {
    const { data, catalog } = withDetail(fixture());
    expect(data.detail.readings).toHaveLength(53);
    expect(new Set(data.detail.readings.map((reading) => reading.tagId)).size).toBe(53);
    expect(data.detail.readings.every((reading) => reading.quality === "good")).toBe(true);
    expect(data.detail.lineStates.map((state) => state.scopeId)).toEqual(["A", "B", "C"]);
    for (const reading of data.detail.readings) {
      const tag = catalog.telemetry_tags.find((item) => item.id === reading.tagId)!;
      expect(reading).toMatchObject({
        moduleId: tag.module_id,
        equipmentId: tag.equipment_id,
        unit: tag.unit,
        quality: "good",
        cadenceSeconds: ["bearing_temperature", "level", "product_mass"].includes(tag.metric)
          ? 60
          : 30,
      });
    }
    expect(validContinuousOverview(data, data.runId, "catalog", "release-1", now, catalog)).toBe(
      true,
    );
    const detailReading = catalog.telemetry_tags.find(
      (tag) => !data.readings.some((reading) => reading.tagId === tag.id),
    )!;
    expect(continuousTagReading(data, detailReading.id, now)).toMatchObject({
      quality: "good",
      value: (detailReading.simulation_envelope[0] + detailReading.simulation_envelope[1]) / 2,
    });
    expect(continuousRunningLines(data, now)).toBe(3);
    expect(moduleStatus(data, "D01.A.crusher", "continuous")).toBe("not directly reported");
  });
  it("rejects partial or mismatched detail bundles without breaking legacy overview reads", () => {
    const { data, catalog } = withDetail(fixture());
    const partial = {
      ...data,
      detail: { ...data.detail, readings: data.detail.readings.slice(1) },
    };
    expect(validContinuousOverview(partial, data.runId, "catalog", "release-1", now, catalog)).toBe(
      false,
    );
    const wrongSource = {
      ...data,
      detail: { ...data.detail, sourceContractVersion: "other" },
    };
    expect(
      validContinuousOverview(wrongSource, data.runId, "catalog", "release-1", now, catalog),
    ).toBe(false);
    const legacy = fixture();
    expect(
      validContinuousOverview(legacy, legacy.runId, "catalog", "release-1", now, catalog),
    ).toBe(true);
  });
  it("uses cadence freshness without treating line schedules or stale state as module health", () => {
    const { data, catalog } = withDetail(fixture());
    const reading = data.detail.readings.find((item) => item.cadenceSeconds === 30)!;
    reading.sampleTime = new Date(now - 105_000).toISOString();
    reading.receivedAt = new Date(now - 100_000).toISOString();
    reading.ageSeconds = 105;
    expect(validContinuousOverview(data, data.runId, "catalog", "release-1", now, catalog)).toBe(
      true,
    );
    expect(continuousTagReading(data, reading.tagId, now + 1)).toMatchObject({
      quality: "stale",
      value: null,
    });
    reading.ageSeconds = 106;
    reading.sampleTime = new Date(now - 106_000).toISOString();
    expect(validContinuousOverview(data, data.runId, "catalog", "release-1", now, catalog)).toBe(
      false,
    );
    Object.assign(reading, { quality: "stale", value: null });
    expect(validContinuousOverview(data, data.runId, "catalog", "release-1", now, catalog)).toBe(
      true,
    );
    data.detail.lineStates[0].state = "idle";
    data.detail.runningLines.value = 2;
    expect(validContinuousOverview(data, data.runId, "catalog", "release-1", now, catalog)).toBe(
      true,
    );
    expect(continuousRunningLines(data, now)).toBe(2);
    expect(moduleStatus(data, "D01.A.crusher")).toBe("not directly reported");
    data.detail.lineStates[0].quality = "stale";
    data.detail.lineStates[0].sampleTime = new Date(now - 196_000).toISOString();
    data.detail.lineStates[0].ageSeconds = 196;
    Object.assign(data.detail.runningLines, { value: null, quality: "unavailable" });
    expect(validContinuousOverview(data, data.runId, "catalog", "release-1", now, catalog)).toBe(
      true,
    );
    expect(continuousRunningLines(data, now)).toBeNull();
  });
  it("withdraws direct values and the line count for stopped, held or expired owners", () => {
    for (const change of [
      { publisherStatus: "failed" },
      { stopRequested: true },
      { authorityUntil: "2026-01-01T11:59:59Z" },
    ]) {
      const { data } = withDetail(fixture());
      Object.assign(data.run, change);
      expect(continuousRunningLines(data, now)).toBeNull();
      expect(continuousTagReading(data, data.detail.readings[0].tagId, now)).toMatchObject({
        quality: "unavailable",
        value: null,
      });
    }
  });
  it("updates the visible connection banner when continuous evidence recovers", () => {
    const source = readFileSync(new URL("../src/ui/public/mining/app.js", import.meta.url), "utf8");
    const tree = ts.createSourceFile(
      "app.js",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const draw = tree.statements.find(
      (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "drawOverview",
    );
    if (!draw) throw new Error("Missing mining overview renderer");
    const data = fixture();
    const rendered = new Map<string, string>();
    const elements = new Map();
    const element = (id: string) => {
      if (!elements.has(id))
        elements.set(id, { hidden: false, childNodes: [], replaceChildren() {}, append() {} });
      return elements.get(id);
    };
    const context = {
      context: { mode: "continuous", approvedRun: data.run, source: data.source },
      continuousOverview: { ...data, quality: "unavailable" } as typeof data | null,
      demoRun: data.run,
      continuousThroughputUsable: (value: object) => continuousThroughputUsable(value, now),
      continuousRunningLines: (value: object) => continuousRunningLines(value, now),
      $: element,
      text: (id: string, value: string) => rendered.set(id, value),
      timestamp: formatTimestamp,
      coverage: String,
      number: String,
      node: () => ({}),
      kpis: ["throughput", "runningLines", "grossProcessWaterIntensity", "energyIntensity"],
      drawPlant() {},
      drawDrawer() {},
      drawDemoRunStatus() {},
      drawOverview: undefined as undefined | (() => void),
    };
    runInNewContext(`${draw.getText(tree)}; this.drawOverview = drawOverview;`, context);
    context.drawOverview!();
    expect(rendered.get("connection")).toContain("throughput unavailable");
    context.continuousOverview = data;
    context.drawOverview!();
    expect(rendered.get("quality")).toBe("Quality: good");
    expect(rendered.get("connection")).toBe("Real validated Fabric throughput read succeeded.");
    context.continuousOverview = null;
    context.drawOverview!();
    expect(rendered.get("quality")).toContain("unavailable");
    expect(rendered.get("connection")).toContain("throughput unavailable");
  });
  it("withdraws stale, stopped, incomplete, duplicate, or numerically inconsistent KPI evidence", () => {
    const data = fixture();
    expect(continuousThroughputUsable(data, now + 46_000)).toBe(false);
    data.run.stopRequested = true;
    expect(continuousThroughputUsable(data, now)).toBe(false);
    data.run.stopRequested = false;
    data.readings[0].coverage = 0.8;
    expect(continuousThroughputUsable(data, now)).toBe(false);
    data.readings[0].coverage = 1;
    data.throughput.value = 140;
    expect(continuousThroughputUsable(data, now)).toBe(false);
    data.readings[1].tagId = data.readings[0].tagId;
    expect(validContinuousOverview(data, data.runId, "catalog", "release-1", now)).toBe(false);
  });
});
describe("mining chart legends", () => {
  it("shows each series range while preserving the shared axis and quality gaps", () => {
    const source = readFileSync(new URL("../src/ui/public/mining/app.js", import.meta.url), "utf8");
    const tree = ts.createSourceFile(
      "app.js",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const chart = tree.statements.find(
      (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "chart",
    );
    if (!chart) throw new Error("Missing mining chart function");
    class Element {
      children: Element[] = [];
      attributes: Record<string, string> = {};
      className = "";
      namespaceURI = "http://www.w3.org/2000/svg";
      constructor(
        public tag: string,
        public content = "",
      ) {}
      replaceChildren() {
        this.children = [];
      }
      append(...children: Element[]) {
        this.children.push(...children);
      }
      prepend(child: Element) {
        this.children.unshift(child);
      }
      setAttribute(name: string, value: string) {
        this.attributes[name] = value;
      }
    }
    const rows = [
      { seriesId: "A", value: 10, minute: 0, quality: "good" },
      { seriesId: "A", value: -500, minute: 1, quality: "bad" },
      { seriesId: "A", value: 20, minute: 2, quality: "good" },
      { seriesId: "B", value: 100, minute: 0, quality: "good" },
      { seriesId: "B", value: 120, minute: 1, quality: "good" },
      { seriesId: "C", value: 200, minute: 0, quality: "good" },
      { seriesId: "C", value: 220, minute: 1, quality: "good" },
      { seriesId: "C", value: 999, minute: 2, quality: "uncertain" },
    ].map(({ minute, ...row }) => ({
      ...row,
      unit: "t/h",
      coverage: 1,
      timestamp: `2026-11-15T20:0${minute}:00.000Z`,
    }));
    const data = {
      binMinutes: 1,
      windowStart: "2026-11-15T20:00:00.000Z",
      windowEnd: "2026-11-15T20:03:00.000Z",
      rows,
    };
    const original = JSON.stringify(data);
    const context = {
      catalog: { telemetry_tags: ["A", "B", "C"].map((id) => ({ id, unit: "t/h" })) },
      usable,
      number: String,
      timestamp: formatTimestamp,
      coverage: String,
      node: (tag: string, content?: string) => new Element(tag, content),
      document: { createElementNS: (_namespace: string, tag: string) => new Element(tag) },
      chart: undefined as undefined | ((container: Element, data: object) => void),
    };
    runInNewContext(`${chart.getText(tree)}; this.chart = chart;`, context);
    if (!context.chart) throw new Error("Mining chart not loaded");
    const container = new Element("div");
    context.chart(container, data);
    expect(
      container.children
        .filter((child) => child.tag === "p")
        .slice(0, 3)
        .map((child) => child.content),
    ).toEqual([
      "A (t/h): 10 – 20 · solid line",
      "B (t/h): 100 – 120 · dashed line",
      "C (t/h): 200 – 220 · dotted line",
    ]);
    const curves = container.children[0].children;
    expect(curves).toHaveLength(4);
    expect(curves[0].attributes.points).toBe("40,165");
    expect(curves[1].attributes.points).toBe(`400,${165 - (10 / 210) * 120}`);
    expect(curves[3].attributes.points).toBe(`40,${165 - (190 / 210) * 120} 220,45`);
    expect(JSON.stringify(data)).toBe(original);
  });
});
describe("mining request lifecycle", () => {
  it.each([
    { mode: "replay", scope: "all" },
    { mode: "replay", scope: "detail" },
    { mode: "live", scope: "detail" },
  ])("loads the feed comparison in $mode $scope refreshes", async ({ mode, scope }) => {
    const source = readFileSync(new URL("../src/ui/public/mining/app.js", import.meta.url), "utf8");
    const tree = ts.createSourceFile(
      "app.js",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const refresh = tree.statements.find(
      (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "refresh",
    );
    if (!refresh) throw new Error("Missing mining refresh function");
    const catalog = readCatalog();
    const tag = catalog.telemetry_tags.find(
      (item: { metric: string }) => item.metric === "ore_flow",
    );
    const params = {
      plantId: "D01",
      runId: "approved",
      asOf: "2026-11-15T19:07:00.000Z",
      start: "2026-11-15T18:37:00.000Z",
      end: "2026-11-15T19:07:00.000Z",
      binMinutes: "1",
      maxRows: "1000",
    };
    const comparison = {
      plantId: "D01",
      runId: "approved",
      catalogVersion: "pinned",
      moduleId: null,
      metric: "feed",
      binMinutes: 1,
      windowStart: params.start,
      windowEnd: params.end,
      rows: [
        {
          seriesId: tag.id,
          unit: tag.unit,
          timestamp: "2026-11-15T19:06:00.000Z",
          value: 10,
          quality: "good",
        },
      ],
    };
    const read = vi.fn(async (path: string) =>
      path === "compare-lines" ? comparison : { incidents: [], asOf: params.asOf },
    );
    const chart = vi.fn();
    const context = {
      mode,
      incidents: [],
      incidentAsOf: null,
      incidentAssessment: null,
      selectedIncident: null,
      selected: null,
      requestEpoch: 0,
      document: { hidden: false },
      context: { readAvailable: true, approvedRun: { runId: "approved" } },
      query: () => params,
      reads: { read },
      catalog,
      catalogVersion: "pinned",
      currentIncidentQuery,
      seriesQuery,
      validSeries,
      validOverview: () => false,
      sameScope: () => true,
      validIncidentAssessment: () => true,
      refreshedIncidentSelection,
      drawIncidents: vi.fn(),
      drawDrawer: vi.fn(),
      drawOverview: vi.fn(),
      text: vi.fn(),
      chart,
      $: (id: string) => id,
      node: vi.fn(),
      refresh: undefined as undefined | ((scope: string) => Promise<void>),
    };
    runInNewContext(`${refresh.getText(tree)}; this.refresh = refresh;`, context);
    if (!context.refresh) throw new Error("Mining refresh not loaded");
    await context.refresh(scope);
    expect(read).toHaveBeenCalledWith("compare-lines", seriesQuery(params, "feed"));
    expect(read.mock.calls.some(([path]) => path === "incidents")).toBe(mode === "live");
    expect(chart).toHaveBeenCalledWith("feed-chart", comparison);
  });
  it("distinguishes freshly rechecked reconciled event time from live assessment freshness", () => {
    const now = Date.parse("2026-01-01T12:10:00.000Z");
    const data = {
      assessmentKind: "reconciled-event-time",
      asOf: "2026-01-01T12:05:00.000Z",
      sourceObservedAt: "2026-01-01T12:06:00.000Z",
      refreshedAt: "2026-01-01T12:10:00.000Z",
    };
    expect(validIncidentAssessment(data, now)).toBe(true);
    expect(validIncidentAssessment({ asOf: data.asOf }, now)).toBe(false);
    expect(validIncidentAssessment({ ...data, refreshedAt: data.sourceObservedAt }, now)).toBe(
      false,
    );
    expect(
      validIncidentAssessment({ ...data, sourceObservedAt: "2026-01-01T12:11:00Z" }, now),
    ).toBe(false);
    expect(
      validIncidentAssessment({ ...data, sourceObservedAt: "2026-01-01T12:04:00Z" }, now),
    ).toBe(false);
    expect(validIncidentAssessment({ ...data, assessmentKind: "fabricated" }, now)).toBe(false);
    expect(incidentAssessmentLabel(data)).toMatch(
      /Reconciled event time.*source captured.*rechecked.*not a live assessment/,
    );
  });
  it("validates live service cutoffs at response time while keeping replay cutoffs exact", () => {
    const requested = "2026-01-01T12:00:00.000Z";
    const received = Date.parse("2026-01-01T12:00:25.000Z");
    const data = {
      plantId: "D01", runId: "approved", catalogVersion: "pinned",
      run: { plantId: "D01", runId: "approved", catalogVersion: "pinned" },
      asOf: "2026-01-01T12:00:20.000Z",
      latest: { modules: Array(24).fill({}), readings: Array(56).fill({}) },
    };
    expect(validOverview(data, "approved", "pinned", requested, false, received)).toBe(true);
    expect(validOverview(data, "approved", "pinned", requested, true, received)).toBe(false);
    expect(validOverview({
      ...data, asOf: "2026-01-01T11:58:54.000Z",
    }, "approved", "pinned", requested, false, received)).toBe(false);
    expect(validOverview({
      ...data, asOf: "2026-01-01T12:00:41.000Z",
    }, "approved", "pinned", requested, false, received)).toBe(false);
  });
  it("shows timestamped ingestion evidence only for the same run and verified provenance", () => {
    const run = { runId: "approved" };
    const overview = {
      run,
      ingestion: {
        status: "complete",
        asOf: "2026-01-01T12:00:00.000Z",
        provenance: "fabric-event-id-reconciliation-v1",
      },
    };
    expect(verifiedRunIngestion(overview, run)).toMatch(/^complete as of /);
    expect(verifiedRunIngestion(overview, { runId: "new-run" })).toBe("unknown");
    expect(verifiedRunIngestion({ ...overview, ingestion: undefined }, run)).toBe("unknown");
    expect(
      verifiedRunIngestion(
        {
          ...overview,
          ingestion: { ...overview.ingestion, provenance: "publisher" },
        },
        run,
      ),
    ).toBe("unknown");
  });
  it("sends chart windows without the overview-only asOf parameter", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(new Response("{}")));
    const reads = new MiningReads(fetchImpl);
    const params = {
      plantId: "D01",
      runId: "approved",
      asOf: "2026-01-01T12:00:00.000Z",
      start: "2026-01-01T11:30:00.000Z",
      end: "2026-01-01T12:00:00.000Z",
      binMinutes: "1",
      maxRows: "1000",
    };
    await reads.read("compare-lines", seriesQuery(params, "feed"));
    await reads.read("trends", seriesQuery(params, "density", "D01.A.dms"));
    const compare = new URL(fetchImpl.mock.calls[0][0], "https://example.test");
    const trend = new URL(fetchImpl.mock.calls[1][0], "https://example.test");
    expect([...compare.searchParams.keys()].sort()).toEqual(
      ["binMinutes", "end", "maxRows", "metric", "plantId", "runId", "start"].sort(),
    );
    expect([...trend.searchParams.keys()].sort()).toEqual(
      ["binMinutes", "end", "maxRows", "metric", "moduleId", "plantId", "runId", "start"].sort(),
    );
    expect(trend.searchParams.get("end")).toBe(params.asOf);
  });
  it("does not call browser fetch with the MiningReads instance as its receiver", async () => {
    let receiver: unknown;
    const fetchImpl = function (this: unknown) {
      receiver = this;
      return Promise.resolve(new Response("{}"));
    };
    const reads = new MiningReads(fetchImpl);
    await reads.read("context");
    expect(receiver).not.toBe(reads);
  });
  it("reuses identical in-flight and 15-second cached reads, not failures", async () => {
    let now = 0;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ rows: [] })));
    const reads = new MiningReads(fetchImpl, () => now);
    const first = reads.read("context");
    expect(reads.read("context")).toBe(first);
    await first;
    await reads.read("context");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 15_000;
    fetchImpl.mockResolvedValueOnce(new Response("", { status: 503 }));
    await expect(reads.read("context")).rejects.toThrow("503");
    fetchImpl.mockResolvedValueOnce(new Response("{}"));
    await reads.read("context");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it("canonicalizes fields and omits absent optional as-of values", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}"));
    const reads = new MiningReads(fetchImpl);
    await reads.read("overview", { runId: "approved", asOf: undefined, plantId: "D01" });
    await reads.read("overview", { plantId: "D01", runId: "approved" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).not.toContain("undefined");
  });
  it("clears cached context when the current demo run changes", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(new Response("{}")));
    const reads = new MiningReads(fetchImpl);
    await reads.read("context");
    reads.reset();
    await reads.read("context");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("aborts pending work when the view changes", async () => {
    let signal: AbortSignal | undefined;
    const reads = new MiningReads((_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    });
    const pending = reads.read("context");
    reads.abort();
    await expect(pending).rejects.toThrow("aborted");
    expect(signal?.aborted).toBe(true);
  });
  it("uses consolidated 30/60-second polling and stops hidden/replay/disconnected work", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const polling = new MiningPolling(refresh);
    polling.update({ mode: "live", hidden: false, connected: true });
    vi.advanceTimersByTime(60_000);
    expect(refresh.mock.calls.map(([scope]) => scope)).toEqual(["overview", "overview", "detail"]);
    for (const state of [
      { mode: "replay", hidden: false, connected: true },
      { mode: "live", hidden: true, connected: true },
      { mode: "live", hidden: false, connected: false },
    ]) {
      polling.update(state);
      vi.advanceTimersByTime(120_000);
      expect(refresh).toHaveBeenCalledTimes(3);
    }
    polling.update({ mode: "live", hidden: false, connected: true });
    polling.update({ mode: "live", hidden: false, connected: true });
    vi.advanceTimersByTime(30_000);
    expect(refresh).toHaveBeenCalledTimes(4);
    polling.stop();
  });
  it("uses the browser timer receiver when starting and stopping polling", () => {
    const schedule = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return 1;
    });
    const cancel = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
    });
    vi.stubGlobal("setInterval", schedule);
    vi.stubGlobal("clearInterval", cancel);
    try {
      const polling = new MiningPolling(vi.fn());
      polling.update({ mode: "live", hidden: false, connected: true });
      polling.stop();
      expect(schedule).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
describe("unknown and catalog selection semantics", () => {
  it("accepts an absent current hold without weakening the evidence window", () => {
    const incident = {
      holdWindowStart: null,
      holdWindowEnd: null,
      evidenceWindowStart: "2026-01-01T00:00:00Z",
      evidenceWindowEnd: "2026-01-01T00:05:00Z",
    };
    expect(validIncidentWindows(incident)).toBe(true);
    expect(
      validIncidentWindows({
        ...incident,
        holdWindowStart: "2026-01-01T00:00:00Z",
      }),
    ).toBe(false);
    expect(
      validIncidentWindows({
        ...incident,
        evidenceWindowEnd: "2025-12-31T23:59:00Z",
      }),
    ).toBe(false);
    expect(
      validIncidentWindows({
        ...incident,
        holdWindowStart: "2026-01-01T00:01:00Z",
        holdWindowEnd: "2026-01-01T00:00:00Z",
      }),
    ).toBe(false);
  });
  it("rejects non-string evidence-window bounds before parsing", () => {
    const incident = {
      holdWindowStart: null,
      holdWindowEnd: null,
      evidenceWindowStart: "2026-01-01T00:00:00Z",
      evidenceWindowEnd: "2026-01-01T00:05:00Z",
    };
    expect(validIncidentWindows({ ...incident, evidenceWindowStart: 2026 })).toBe(false);
    expect(validIncidentWindows({ ...incident, evidenceWindowEnd: 2026 })).toBe(false);
  });
  it("keeps incident assessments current-only and separates measurement time from replay time", () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    const replayParams = {
      plantId: "D01",
      runId: "approved",
      asOf: "2026-01-01T11:59:00Z",
    };
    expect(currentIncidentQuery("replay", replayParams)).toBeNull();
    expect(currentIncidentQuery("live", replayParams)).toEqual({
      plantId: "D01",
      runId: "approved",
    });
    expect(validCurrentAssessmentAsOf(replayParams.asOf, now)).toBe(true);
    expect(validCurrentAssessmentAsOf("2026-01-01T11:58:00Z", now)).toBe(false);
    expect(validCurrentAssessmentAsOf("not-a-timestamp", now)).toBe(false);
    expect(validCurrentAssessmentAsOf(2026, Date.parse("2026-01-01T00:00:00Z"))).toBe(false);
  });
  it("allows only canonical module associations and does not invent a metric for state-only incidents", () => {
    const catalog = { modules: [{ id: "D01.A.crusher" }] };
    expect(
      validIncidentAssociation(
        { moduleId: null, metric: null, affectedModuleIds: [] },
        catalog,
      ),
    ).toBe(true);
    expect(
      validIncidentAssociation(
        { moduleId: null, metric: "feed", affectedModuleIds: [] },
        catalog,
      ),
    ).toBe(false);
    expect(
      validIncidentAssociation(
        {
          moduleId: "D01.A.crusher",
          metric: null,
          affectedModuleIds: ["D01.A.crusher"],
        },
        catalog,
      ),
    ).toBe(true);
    expect(
      validIncidentAssociation(
        { moduleId: "D01.foreign.crusher", metric: "vibration", affectedModuleIds: [] },
        catalog,
      ),
    ).toBe(false);
  });
  it("refreshes selected incident data and clears a selection no longer active", () => {
    const selected = {
      incidentId: "incident-1",
      holdWindowStart: "2026-01-01T00:00:00Z",
      holdWindowEnd: "2026-01-01T00:05:00Z",
    };
    const refreshed = {
      incidentId: "incident-1",
      holdWindowStart: null,
      holdWindowEnd: null,
    };
    expect(refreshedIncidentSelection(selected, [refreshed])).toBe(refreshed);
    expect(refreshedIncidentSelection(selected, [])).toBeNull();
    expect(refreshedIncidentSelection(null, [refreshed])).toBeNull();
  });
  it("preserves uncertain quality without exposing its value as usable or healthy", () => {
    const asOf = "2026-01-01T00:01:00Z";
    const reading = {
      moduleId: "D01.A.crusher",
      quality: "uncertain",
      value: 42,
      sampleTime: "2026-01-01T00:00:00Z",
      ageSeconds: 60,
    };
    const normalized = normalizeReading(reading, asOf);
    expect(normalized).toMatchObject({ quality: "uncertain", value: null });
    expect(usable(reading)).toBe(false);
    expect(readingAt(reading, asOf)).toBe(false);
    expect(unknownQuality(normalized.quality)).toBe("uncertain / unknown");
    expect(
      moduleStatus(
        {
          quality: "good",
          latest: {
            modules: [{ moduleId: reading.moduleId, status: "normal" }],
            readings: [normalized],
          },
        },
        reading.moduleId,
      ),
    ).toBe("unknown");
    expect(normalizeReading({ ...reading, quality: "unsupported" }, asOf).quality).toBe("missing");
  });
  it("keeps absent or invalid ingestion timestamps unknown", () => {
    expect(formatTimestamp(null)).toBe("unknown");
    expect(formatTimestamp(undefined)).toBe("unknown");
    expect(formatTimestamp("not-a-timestamp")).toBe("unknown");
    expect(formatTimestamp("2026-01-01T00:00:00Z")).toBe("2026-01-01T00:00:00.000Z");
  });
  it("rejects same-run replay details for another time, metric, module, unit or bin", () => {
    const params = {
      runId: "approved",
      moduleId: "D01.A.dms",
      metric: "density",
      start: "2026-01-01T00:00:00Z",
      end: "2026-01-01T00:30:00Z",
      binMinutes: "1",
      maxRows: "1000",
    };
    const row = { seriesId: "D01.A.dms.medium_density", unit: "SG", timestamp: params.start };
    const data = {
      plantId: "D01",
      runId: "approved",
      catalogVersion: "pinned",
      moduleId: params.moduleId,
      metric: "density",
      windowStart: params.start,
      windowEnd: params.end,
      binMinutes: 1,
      rows: [row],
    };
    const catalog = {
      telemetry_tags: [
        { id: row.seriesId, module_id: params.moduleId, metric: "medium_density", unit: "SG" },
      ],
    };
    expect(validSeries(data, params, "pinned", catalog)).toBe(true);
    for (const change of [
      { metric: "vibration" },
      { moduleId: "D01.B.dms" },
      { windowEnd: "2026-01-01T00:31:00Z" },
      { binMinutes: 5 },
      { rows: [{ ...row, unit: "kg" }] },
      { rows: [{ ...row, timestamp: "2025-12-31T23:59:00Z" }] },
    ])
      expect(validSeries({ ...data, ...change }, params, "pinned", catalog)).toBe(false);
    expect(validAsOf(params.start, params.start, true)).toBe(true);
    expect(validAsOf(params.start, params.end, true)).toBe(false);
  });
  it("accepts only aligned partial bins that intersect the requested window", () => {
    const catalog = {
      telemetry_tags: [
        {
          id: "D01.A.dms.medium_density",
          module_id: "D01.A.dms",
          metric: "medium_density",
          unit: "kg/m3",
        },
      ],
    };
    for (const [binMinutes, firstBin, beforeBin] of [
      [1, "2026-01-01T00:02:00Z", "2026-01-01T00:01:00Z"],
      [5, "2026-01-01T00:00:00Z", "2025-12-31T23:55:00Z"],
    ] as const) {
      const params = {
        runId: "approved",
        moduleId: "D01.A.dms",
        metric: "density",
        start: "2026-01-01T00:02:15Z",
        end: "2026-01-01T00:12:15Z",
        binMinutes: String(binMinutes),
        maxRows: "1000",
      };
      const row = { seriesId: "D01.A.dms.medium_density", unit: "kg/m3", timestamp: firstBin };
      const data = {
        plantId: "D01",
        runId: params.runId,
        catalogVersion: "pinned",
        moduleId: params.moduleId,
        metric: params.metric,
        windowStart: params.start,
        windowEnd: params.end,
        binMinutes,
        rows: [row],
      };
      expect(validSeries(data, params, "pinned", catalog)).toBe(true);
      expect(
        validSeries(
          { ...data, rows: [{ ...row, timestamp: beforeBin }] },
          params,
          "pinned",
          catalog,
        ),
      ).toBe(false);
      expect(
        validSeries(
          { ...data, rows: [{ ...row, timestamp: params.start }] },
          params,
          "pinned",
          catalog,
        ),
      ).toBe(false);
    }
  });
  it("does not treat missing, bad, stale or nonfinite readings as healthy zero", () => {
    for (const quality of ["missing", "bad", "stale"])
      expect(usable({ quality, value: 0 })).toBe(false);
    expect(usable({ quality: "good", value: null })).toBe(false);
    expect(usable({ quality: "good", value: NaN })).toBe(false);
    expect(usable({ quality: "good", value: 0 })).toBe(false);
    expect(usable({ quality: "good", value: 0, sampleTime: "2026-01-01T00:00:00Z" })).toBe(true);
    expect(
      readingAt(
        { quality: "good", value: 0, sampleTime: "2026-01-01T00:00:00Z", ageSeconds: 60 },
        "2026-01-01T00:01:00Z",
      ),
    ).toBe(true);
    expect(
      readingAt(
        { quality: "good", value: 0, sampleTime: "2026-01-01T00:00:00Z", ageSeconds: 60 },
        "2026-11-01T00:01:00Z",
      ),
    ).toBe(false);
    expect(moduleStatus(null, "D01.A.crusher")).toBe("unknown");
    expect(
      moduleStatus(
        {
          quality: "good",
          latest: {
            modules: [{ moduleId: "D01.A.crusher", status: "normal" }],
            readings: [{ moduleId: "D01.A.crusher", quality: "bad", value: 0 }],
          },
        },
        "D01.A.crusher",
      ),
    ).toBe("unknown");
  });
  it("evaluates replay at replay time and refuses incomplete/stale overviews", () => {
    const data = {
      plantId: "D01",
      runId: "approved",
      catalogVersion: "pinned",
      run: { plantId: "D01", runId: "approved", catalogVersion: "pinned" },
      asOf: "2026-01-01T00:00:00Z",
      latest: { modules: Array(24).fill({}), readings: Array(56).fill({}) },
    };
    expect(validOverview(data, "approved", "pinned", "2026-01-01T00:00:00Z", true)).toBe(true);
    expect(validOverview(data, "approved", "pinned", "2026-11-01T00:00:00Z", false)).toBe(false);
    expect(validOverview(data, "foreign", "pinned", data.asOf, true)).toBe(false);
    expect(sameScope(data, "approved", "other-catalog")).toBe(false);
    expect(
      validOverview(
        { ...data, run: { ...data.run, catalogVersion: "foreign" } },
        "approved",
        "pinned",
        data.asOf,
        true,
      ),
    ).toBe(false);
    expect(
      validOverview(
        { ...data, latest: { modules: [], readings: [] } },
        "approved",
        "pinned",
        data.asOf,
        true,
      ),
    ).toBe(false);
  });
  it("selects only authored tags, links and visible modules; untagged equipment has none", () => {
    const catalog = {
      modules: [
        { id: "D01.A.dms", kind: "dms", line: "A" },
        { id: "D01.shared.lab", kind: "lab", line: "shared" },
      ],
      telemetry_tags: [
        { id: "D01.A.dms.motor_current", module_id: "D01.A.dms", metric: "motor_current" },
        { id: "D01.A.dms.feed_pressure", module_id: "D01.A.dms", metric: "feed_pressure" },
        { id: "D01.A.dms.medium_density", module_id: "D01.A.dms", metric: "medium_density" },
      ],
      streams: [{ source: { module_id: "D01.A.dms" }, target: { module_id: "D01.shared.lab" } }],
    };
    expect(relevantTags(catalog, "D01.A.dms").map((tag: { metric: string }) => tag.metric)).toEqual(
      ["medium_density", "feed_pressure"],
    );
    expect(relevantTags(catalog, "D01.shared.lab")).toEqual([]);
    expect(connections(catalog, "D01.shared.lab", "upstream")).toEqual(["D01.A.dms"]);
    expect(visibleModules(catalog, new Set(["shared"]))).toEqual([catalog.modules[1]]);
  });
});

describe("pinned reconstructed appearance", () => {
  it("rebuilds screened placements on 20 → 24 → 20 and cancels superseded loads", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const bundle = loadAppearanceBundle();
    for (const asset of bundle.assetsById.values())
      asset.sha256 = createHash("sha256").update(bytes).digest("hex");
    const catalog = readCatalog();
    const renders: { scene: THREE.Scene; camera: THREE.Camera }[] = [];
    const disposeSplat = vi.fn();
    class Renderer {
      domElement = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
      setPixelRatio() {}
      setClearColor() {}
      setSize() {}
      setAnimationLoop() {}
      render(scene: THREE.Scene, camera: THREE.Camera) { renders.push({ scene, camera }); }
      dispose() {}
    }
    class Controls {
      target = new THREE.Vector3();
      enabled = true;
      addEventListener() {}
      removeEventListener() {}
      dispose() {}
    }
    class Loader {
      async loadAsync() {
        return { scene: new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()) };
      }
    }
    class SplatMesh extends THREE.Group {
      initialized = Promise.resolve();
      splats = {};
      dispose() { disposeSplat(); }
    }
    class SparkRenderer extends THREE.Group {
      dispose() {}
    }
    class Observer {
      observe() {}
      disconnect() {}
    }
    let pauseFetch = false;
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => {
      if (!pauseFetch) return Promise.resolve(new Response(bytes));
      return new Promise<Response>((_resolve, reject) =>
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("Appearance change was canceled.", "AbortError")),
        ),
      );
    });
    vi.doMock("three", async () => ({
      ...await vi.importActual<typeof import("three")>("three"),
      WebGLRenderer: Renderer,
    }));
    vi.doMock("three/addons/loaders/GLTFLoader.js", () => ({ GLTFLoader: Loader }));
    vi.doMock("three/addons/controls/OrbitControls.js", () => ({ OrbitControls: Controls }));
    vi.doMock("@sparkjsdev/spark", () => ({ SparkRenderer, SplatMesh }));
    vi.stubGlobal("window", { devicePixelRatio: 1 });
    vi.stubGlobal("ResizeObserver", Observer);
    vi.stubGlobal("fetch", fetchImpl);
    vi.stubGlobal("crypto", webcrypto);
    try {
      const container = { clientWidth: 800, clientHeight: 420, replaceChildren: vi.fn() };
      const viewer = await createPlant3D(container, catalog, vi.fn());
      const lines = new Set(["A", "B", "C", "shared"]);
      viewer.update(lines, false, "D01.A.dms");
      const camera = renders.at(-1)?.camera;
      const selectedBox = renders.at(-1)?.scene.children.find(
        (child) => child instanceof THREE.BoxHelper && child.visible,
      );
      expect(selectedBox).toBeDefined();
      await viewer.setVisualMode("reconstructed", bundle, false);
      expect(viewer.renderedModuleCount).toBe(20);
      await viewer.setVisualMode("reconstructed", bundle, true);
      expect(viewer.renderedModuleCount).toBe(24);
      const loaded = fetchImpl.mock.calls.length;
      await viewer.setVisualMode("reconstructed", bundle, true);
      expect(fetchImpl).toHaveBeenCalledTimes(loaded);
      await viewer.setVisualMode("reconstructed", bundle, false);
      expect(viewer.renderedModuleCount).toBe(20);
      expect(renders.at(-1)?.camera).toBe(camera);
      expect(selectedBox?.visible).toBe(true);
      expect(disposeSplat).toHaveBeenCalled();

      pauseFetch = true;
      const beforePending = fetchImpl.mock.calls.length;
      const pending = viewer.setVisualMode("reconstructed", bundle, true);
      const pendingResult = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(beforePending + 1));
      pauseFetch = false;
      await viewer.setVisualMode("reconstructed", bundle, false);
      await pendingResult;
      expect(viewer.renderedModuleCount).toBe(20);
      viewer.dispose();
    } finally {
      vi.doUnmock("three");
      vi.doUnmock("three/addons/loaders/GLTFLoader.js");
      vi.doUnmock("three/addons/controls/OrbitControls.js");
      vi.doUnmock("@sparkjsdev/spark");
      vi.unstubAllGlobals();
    }
  });

  it("binds the published splats to the same 24 catalog modules and keeps screened placements selectable", () => {
    const bundle = loadAppearanceBundle();
    const bindings = [...bundle.moduleBindings.values()];
    const accepted = bindings.filter(({ asset }) => asset.quality.status === "accepted");
    const excluded = bindings.filter(({ asset }) => asset.quality.status === "excluded");
    expect(bindings).toHaveLength(24);
    expect(accepted).toHaveLength(20);
    expect(excluded).toHaveLength(4);
    expect(new Set(excluded.map(({ asset }) => asset.id)).size).toBe(2);
    for (const { asset, module } of excluded) {
      expect(splatFit(asset, module)).toBeNull();
      expect(splatFit(asset, module, true)).not.toBeNull();
    }
  });

  it("rejects unapproved, encoded and traversing asset paths", () => {
    expect(localSplatPath("/api/assets/plant/splats/object-000.ply")).toBe(
      "/mining/plant/reconstructed/splats/object-000.ply",
    );
    for (const uri of [
      "https://example.invalid/object-000.ply",
      "/api/assets/plant/splats/../object-000.ply",
      "/api/assets/plant/splats/%2e%2e/object-000.ply",
      "/api/assets/plant/splats/object-000.ply?redirect=https://example.invalid",
    ])
      expect(() => localSplatPath(uri)).toThrow();
  });

  it("rejects altered source receipts and invalid render bounds", () => {
    const catalog = readCatalog();
    const metadata = readJson("metadata.json");
    const scene = readJson("D01.json");
    const files = readJson("files.json");
    const quality = readJson("quality.json");
    const appearanceAssets = Array.isArray(metadata.appearance_assets)
      ? metadata.appearance_assets
      : Object.values(metadata.appearance_assets);
    const source = appearanceAssets[0] as { uri: string; sha256: string };
    const fileName = source.uri.split("/").at(-1);
    const tamperedFiles = { ...files, [`splats/${fileName}`]: "0".repeat(64) };
    expect(() =>
      validateAppearanceBundle(catalog, metadata, scene, tamperedFiles, quality),
    ).toThrow(/receipt mismatch/);

    const invalidMetadata = structuredClone(metadata);
    const invalidAssets = Array.isArray(invalidMetadata.appearance_assets)
      ? invalidMetadata.appearance_assets
      : Object.values(invalidMetadata.appearance_assets);
    (invalidAssets[0] as { uri: string }).uri = "/api/assets/plant/splats/../object-000.ply";
    expect(() =>
      validateAppearanceBundle(catalog, invalidMetadata, scene, files, quality),
    ).toThrow(/outside the pinned plant path/);
    expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);

    const invalidQuality = structuredClone(quality);
    invalidQuality.assets[source.sha256].render_bounds.max[0] =
      invalidQuality.assets[source.sha256].render_bounds.min[0];
    expect(() =>
      validateAppearanceBundle(catalog, metadata, scene, files, invalidQuality),
    ).toThrow(/quality record/);
  });

  it("bounds response reads and requires review-only display for screened assets", async () => {
    await expect(readBoundedBytes(new Response(new Uint8Array(5)), 4)).rejects.toThrow(
      /size limit/,
    );
    await expect(
      readBoundedBytes(new Response(new Uint8Array([1, 2, 3])), 3),
    ).resolves.toEqual(new Uint8Array([1, 2, 3]));
    const distorted = {
      quality: {
        status: "accepted",
        render_bounds: { min: [0, 0, 0], max: [10, 1, 10] },
      },
    };
    expect(splatFit(distorted, { size: [1, 10, 1] }, true)).toBeNull();
  });

  it("fits Clean and Reconstructed geometry into the same authored module envelope", () => {
    const module = {
      position: [10, 5, 20],
      rotation: [0, 0, 0],
      size: [4, 2, 6],
    };
    const clean = new THREE.Mesh(
      new THREE.BoxGeometry(1, 2, 3),
      new THREE.MeshBasicMaterial(),
    );
    const fittedClean = fitModelToNode(THREE, clean, module);
    const cleanSize = new THREE.Box3().setFromObject(fittedClean).getSize(new THREE.Vector3());
    expect(cleanSize.x).toBeCloseTo(module.size[0]);
    expect(cleanSize.y).toBeCloseTo(module.size[1]);
    expect(cleanSize.z).toBeCloseTo(module.size[2]);

    const reconstructed = new THREE.Group();
    const asset = {
      quality: {
        status: "accepted",
        render_bounds: { min: [-1, 0, -2], max: [1, 4, 2] },
      },
      provenance: {
        model: APPEARANCE_RELEASE.sdk,
        sdk_revision: APPEARANCE_RELEASE.sdkRevision,
      },
    };
    fitSplatToNode(THREE, reconstructed, asset, module);
    expect(reconstructed.scale.x).toBe(reconstructed.scale.y);
    expect(reconstructed.scale.y).toBe(reconstructed.scale.z);
    expect(reconstructed.rotation.x).toBeCloseTo(Math.PI);
    expect(reconstructed.position.toArray().every(Number.isFinite)).toBe(true);
    clean.geometry.dispose();
    clean.material.dispose();
  });
});
