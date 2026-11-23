import { readFileSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { D01PlantCatalog } from "@triathlon-twin/simulator/mining";
import { collectPreview, collectReceipt, streamWindow } from "../src/ui/public/mining/stream.js";
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
  validConnectionFlow,
  validConnectionTrend,
  moduleStatus,
  lineOperatingState,
  validOverview,
  validAsOf,
  currentIncidentQuery,
  validCurrentAssessmentAsOf,
  validIncidentAssessment,
  incidentAssessmentLabel,
  validSeries,
  crossRunChartData,
  seriesQuery,
  verifiedRunIngestion,
  validContinuousOverview,
  validContinuousAdvisories,
  continuousThroughputUsable,
  continuousTagReading,
  continuousRunningLines,
  continuousSummaryFresh,
  continuousSummaryMetric,
  continuousClockSkewMs,
  simulationTiming,
  activePublisher,
  demoContextChanged,
} from "../src/ui/public/mining/data.js";

describe("shared-flow preparation", () => {
  it("keeps a preparing or scheduled run cancellable and refreshes context on activation", () => {
    const preparing = { runId: "run", publisherStatus: "preparing" };
    const scheduled = { ...preparing, publisherStatus: "scheduled" };
    const running = { ...preparing, publisherStatus: "running" };
    expect(activePublisher(preparing)).toBe(true);
    expect(activePublisher(scheduled)).toBe(true);
    expect(activePublisher({ ...running, publisherStatus: "failed" })).toBe(false);
    expect(demoContextChanged({ approvedRun: preparing }, scheduled, false)).toBe(true);
    expect(demoContextChanged({ approvedRun: scheduled }, running, false)).toBe(true);
    expect(demoContextChanged({ approvedRun: running }, running, false)).toBe(false);
    expect(
      demoContextChanged(
        { approvedRun: { ...running, publisherStatus: "stop_requested" } },
        { ...running, stopRequested: true },
        false,
      ),
    ).toBe(false);
  });
});

describe("bounded live stream charts", () => {
  const start = Date.parse("2026-01-01T00:00:00Z");
  const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
  const run = { runId: "current", startedAt: at(0), stopAt: at(600), publisherStatus: "running" };
  const numeric = {
    runId: run.runId,
    sampleTime: at(30),
    receivedAt: at(31),
    telemetryCount: 45,
    stateCount: 4,
  };

  it("distinguishes normal collection, arrival and overdue without treating state as numeric", () => {
    const state = { ...numeric, sampleTime: at(5), receivedAt: at(6), telemetryCount: 0 };
    const observed = collectReceipt([], { ...run, nativeReceipt: state });
    expect(streamWindow(run, observed, start + 29_000)).toMatchObject({
      state: "collecting",
      remaining: 1,
    });

    expect(streamWindow(run, observed, start + 32_000)?.state).toBe("arriving");
    expect(streamWindow(run, observed, start + 36_000)?.state).toBe("overdue");
    const withNumeric = collectReceipt(observed, { ...run, nativeReceipt: numeric });
    expect(streamWindow(run, withNumeric, start + 36_000)).toMatchObject({
      state: "collecting",
      remaining: 24,
    });
    expect(collectReceipt(withNumeric, { ...run, nativeReceipt: numeric })).toBe(withNumeric);
    expect(streamWindow({ ...run, stopRequested: true }, withNumeric)).toBeNull();
    expect(collectReceipt(withNumeric, { ...run, runId: "other", nativeReceipt: numeric })).toEqual(
      [],
    );
  });

  describe("safe mining read errors", () => {
    it("preserves known categories without exposing upstream text or guessing a 503 cause", async () => {
      const response = (code: string) =>
        new Response(JSON.stringify({ error: { code, message: "private backend detail" } }), {
          status: 503,
        });
      const configured = new MiningReads(async () => response("mining_read_configuration"));
      await expect(configured.read("overview")).rejects.toMatchObject({
        category: "not_configured",
        message: "Mining readings are not configured.",
      });
      const unknown = new MiningReads(async () => response("__proto__"));
      await expect(unknown.read("overview")).rejects.toMatchObject({
        category: "service_failed",
        message: "Live readings unavailable. Plant layout still works. Retry.",
      });
      const pending = new MiningReads(async () => response("mining_flow_pending"));
      await expect(pending.read("connection-latest")).rejects.toMatchObject({
        category: "waiting",
        message: "Waiting for the first connection flow samples.",
      });
    });

    it("shows a pending flow read as waiting, but reports a real read failure", async () => {
      const source = readFileSync(
        new URL("../src/ui/public/mining/app.js", import.meta.url),
        "utf8",
      );
      const tree = ts.createSourceFile("app.js", source, ts.ScriptTarget.Latest, true);
      const refresh = tree.statements.find(
        (statement): statement is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(statement) && statement.name?.text === "refreshConnectionFlow",
      );
      if (!refresh) throw new Error("Connection flow refresh not found");
      const labels = new Map<string, string>();
      const sandbox: any = {
        mode: "live",
        context: {
          capabilities: { connectionFlow: true },
          readAvailable: true,
          approvedRun: { runId: "current" },
        },
        document: { hidden: false },
        requestEpoch: 0,
        flowExpiryTimer: undefined,
        connectionFlow: null,
        flowTrendGeneration: 0,
        $: () => ({}),
        text: (id: string, value: string) => labels.set(id, value),
        reads: { read: vi.fn() },
        clearTimeout,
        drawPlant: vi.fn(),
        drawDrawer: vi.fn(),
      };
      runInNewContext(`${refresh.getText(tree)}; this.refresh = refreshConnectionFlow;`, sandbox);
      sandbox.reads.read.mockRejectedValueOnce({ category: "waiting" });
      await sandbox.refresh("overview");
      expect(labels.get("flow-status")).toBe("Waiting for the first connection flow samples.");
      sandbox.reads.read.mockRejectedValueOnce(new Error("private upstream failure"));
      await sandbox.refresh("overview");
      expect(labels.get("flow-status")).toBe(
        "Connection flows unavailable. Plant layout remains available.",
      );
    });
  });

  it("keeps only in-run simulator samples without filling missing ticks", () => {
    const simulatorPreview = [
      { runId: run.runId, sampleTime: at(15), hopperTonnes: 779 },
      { runId: "earlier", sampleTime: at(10), hopperTonnes: 0 },
      { runId: run.runId, sampleTime: at(5), hopperTonnes: 780 },
    ];
    expect(collectPreview({ ...run, simulatorPreview })).toEqual([
      { seconds: 5, value: 780 },
      { seconds: 15, value: 779 },
    ]);
  });
});
import {
  connections,
  createPlant3D,
  relevantTags,
  visibleModules,
} from "../src/ui/public/mining/plant.js";

describe("connection flow browser scope", () => {
  const now = Date.parse("2026-01-01T12:00:30.000Z");
  const catalog = { streams: [{ id: "feed" }, { id: "water" }] };
  const data = {
    plantId: "D01",
    runId: "current",
    catalogVersion: "pinned",
    runStartedAt: "2026-01-01T12:00:00.000Z",
    asOf: new Date(now).toISOString(),
    readings: [
      {
        streamId: "feed",
        measurementTagId: "feed-solids",
        quantity: "dry_solids_mass_flow",
        unit: "t/h",
        nominalCapacity: 60,
        status: "OK",
        quality: "good",
        stale: false,
        value: 0,
        sampleTime: "2026-01-01T12:00:25.000Z",
        receiptTime: "2026-01-01T12:00:28.000Z",
      },
      {
        streamId: "water",
        measurementTagId: "water-flow",
        quantity: "water_volume_flow",
        unit: "m3/h",
        nominalCapacity: 120,
        status: "MISSING",
        value: null,
      },
    ],
  };
  it("accepts a measured zero but refuses stale, foreign or incomplete scopes", () => {
    expect(validConnectionFlow(data, "current", "pinned", catalog, now)).toBe(true);
    expect(validConnectionFlow(data, "other", "pinned", catalog, now)).toBe(false);
    expect(validConnectionFlow(data, "current", "pinned", catalog, now + 31_000)).toBe(false);
    expect(
      validConnectionFlow(
        { ...data, readings: [data.readings[0]] },
        "current",
        "pinned",
        catalog,
        now,
      ),
    ).toBe(false);
    expect(
      validConnectionFlow(
        { ...data, readings: [data.readings[0], data.readings[0], data.readings[1]] },
        "current",
        "pinned",
        catalog,
        now,
      ),
    ).toBe(false);
  });
  it("accepts timestamped delayed observations but rejects inconsistent delay metadata", () => {
    const delayed = {
      ...data,
      readings: [
        {
          ...data.readings[0],
          status: "STALE",
          stale: true,
          sampleTime: "2026-01-01T12:00:05.000Z",
        },
        data.readings[1],
      ],
    };
    expect(validConnectionFlow(delayed, "current", "pinned", catalog, now)).toBe(true);
    delayed.readings[0].stale = false;
    expect(validConnectionFlow(delayed, "current", "pinned", catalog, now)).toBe(false);
  });
  it("checks complete aligned trend grids rather than filling gaps", () => {
    const request = {
      runId: "current",
      catalogVersion: "pinned",
      streamIds: ["feed"],
      start: "2026-01-01T12:00:00.000Z",
      end: "2026-01-01T12:00:30.000Z",
      windowSeconds: 30,
    };
    const point = {
      streamId: "feed",
      measurementTagId: "feed-solids",
      quantity: "dry_solids_mass_flow",
      unit: "t/h",
      windowStart: request.start,
      windowEnd: request.end,
      samples: 6,
      expectedSamples: 6,
      coverage: 1,
      complete: true,
      conflicts: 0,
      quality: "good",
      state: "COMPLETE",
      value: 0,
    };
    const open = {
      ...point,
      windowStart: request.end,
      windowEnd: "2026-01-01T12:01:00.000Z",
      samples: 0,
      coverage: 0,
      complete: false,
      state: "OPEN_WINDOW",
      value: null,
    };
    const result = { ...data, start: request.start, end: request.end, points: [point] };
    expect(validConnectionTrend(result, request, data)).toBe(true);
    expect(validConnectionTrend({ ...result, points: [] }, request, data)).toBe(false);
    const extendedRequest = { ...request, end: "2026-01-01T12:00:35.000Z" };
    expect(
      validConnectionTrend(
        { ...result, end: extendedRequest.end, points: [point, open] },
        extendedRequest,
        data,
      ),
    ).toBe(true);
    expect(
      validConnectionTrend({ ...result, points: [{ ...point, conflicts: 1 }] }, request, data),
    ).toBe(false);
    const shiftedFlow = { ...data, runStartedAt: "2026-01-01T12:00:07.000Z" };
    const shiftedRequest = {
      ...request,
      start: shiftedFlow.runStartedAt,
      end: "2026-01-01T12:00:37.000Z",
    };
    const shiftedResult = {
      ...result,
      runStartedAt: shiftedFlow.runStartedAt,
      start: shiftedRequest.start,
      end: shiftedRequest.end,
      points: [{ ...point, windowStart: shiftedRequest.start, windowEnd: shiftedRequest.end }],
    };
    expect(validConnectionTrend(shiftedResult, shiftedRequest, shiftedFlow)).toBe(true);
    expect(validConnectionTrend(shiftedResult, request, shiftedFlow)).toBe(false);
  });
});
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
describe("simulation arrival timing", () => {
  const start = "2026-11-19T12:00:00Z";
  const run = {
    runId: "current",
    startedAt: start,
    stopAt: "2026-11-19T12:10:00Z",
    publisherStatus: "running",
    stopRequested: false,
  };
  const now = Date.parse(start) + 90_000;
  const data = {
    runId: "current",
    latest: {
      readings: [
        {
          sampleTime: "2026-11-19T12:00:30Z",
          ingestionTime: "2026-11-19T12:01:05Z",
        },
      ],
    },
  };
  it("separates remaining simulation time, source age and measured ingestion delay", () => {
    expect(simulationTiming(run, data, now)).toMatchObject({
      active: true,
      remainingSeconds: 510,
      elapsedSeconds: 90,
      lagSeconds: 35,
      sampleAgeSeconds: 60,
      receiptAgeSeconds: 25,
    });
    expect(simulationTiming(run, null, now).lagSeconds).toBeNull();
    expect(simulationTiming(run, { ...data, runId: "previous" }, now).lagSeconds).toBeNull();
    expect(
      simulationTiming(
        run,
        {
          ...data,
          latest: {
            readings: [
              {
                ...data.latest.readings[0],
                receivedAt: data.latest.readings[0].ingestionTime,
                ingestionTime: null,
              },
            ],
          },
        },
        now,
      ).lagSeconds,
    ).toBe(35);
  });
  it("rejects impossible receipts and does not invent remaining time for stopped runs", () => {
    for (const receipt of ["invalid", "2026-11-19T12:00:10Z", "2026-11-19T12:02:00Z"]) {
      expect(
        simulationTiming(
          run,
          {
            runId: "current",
            readings: [{ sampleTime: data.latest.readings[0].sampleTime, receivedAt: receipt }],
          },
          now,
        ).lagSeconds,
      ).toBeNull();
    }
    expect(
      simulationTiming({ ...run, stopRequested: true }, data, now).remainingSeconds,
    ).toBeNull();
    expect(simulationTiming(run, data, now + 600_000).remainingSeconds).toBe(0);
  });
});
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
  it("uses the current continuous run authority for fresh running and stopped line markers", () => {
    const { data, catalog } = withDetail(fixture());
    data.detail.lineStates[1].state = "stopped";
    data.detail.lineStates[1].scheduledRunning = false;
    data.detail.runningLines.value = 2;
    expect(
      validContinuousOverview(data, data.runId, "catalog", data.generation, now, catalog),
    ).toBe(true);
    expect(lineOperatingState(data, "A", "continuous", now)).toBe("running");
    expect(lineOperatingState(data, "B", "continuous", now)).toBe("stopped");
    for (const run of [
      { ...data.run, publisherStatus: "stopped" },
      { ...data.run, stopRequested: true },
      { ...data.run, authorityUntil: new Date(now + continuousClockSkewMs).toISOString() },
      { ...data.run, generation: "foreign" },
      { ...data.run, runId: "foreign" },
    ]) {
      expect(lineOperatingState({ ...data, run }, "A", "continuous", now)).toBe("unknown");
      expect(lineOperatingState({ ...data, run }, "B", "continuous", now)).toBe("unknown");
    }
    expect(lineOperatingState(data, "A", "continuous", now + 196_000)).toBe("unknown");
    expect(
      lineOperatingState({ ...data, asOf: "2026-01-01T11:58:00Z" }, "A", "continuous", now),
    ).toBe("unknown");
  });
  function withSummary(data: ReturnType<typeof fixture>) {
    const definitions = [
      { window: "30m", duration: 30 * 60_000, coverage: 0.966667, status: "OK", value: 2.1502 },
      { window: "2h", duration: 2 * 60 * 60_000, coverage: 0.991667, status: "OK", value: 2.1517 },
      {
        window: "24h",
        duration: 24 * 60 * 60_000,
        coverage: 0.127083,
        status: "INSUFFICIENT_COMMON_COVERAGE",
        value: null,
      },
    ];
    return {
      ...data,
      continuousSummary: {
        plantId: "D01",
        runId: data.runId,
        generation: data.generation,
        catalogVersion: data.catalogVersion,
        sourceContractVersion: "d01-validated-source-v1",
        asOf: data.asOf,
        windows: definitions.map(({ window, duration, coverage, status, value }) => {
          const windowStart = new Date(Date.parse(data.asOf) - duration).toISOString();
          const water = {
            value,
            unit: "m\u00b3/t",
            coverage,
            quality: value === null ? "missing" : "good",
            windowStart,
            windowEnd: data.asOf,
          };
          return {
            window,
            windowStart,
            windowEnd: data.asOf,
            status,
            grossProcessWaterIntensity: water,
            energyIntensity: {
              ...water,
              value: value === null ? null : value * 0.8,
              unit: "kWh/t",
            },
          };
        }),
      },
    };
  }
  it("accepts only pinned scope/generation and never fabricates finite overview evidence", () => {
    const data = fixture();
    expect(validContinuousOverview(data, data.runId, "catalog", "release-1", now)).toBe(true);
    expect(validContinuousOverview(data, data.runId, "catalog", "release-2", now)).toBe(false);
    expect(
      validContinuousOverview(
        { ...data, capabilities: { incidents: true, trends: true } },
        data.runId,
        "catalog",
        "release-1",
        now,
      ),
    ).toBe(true);
    expect(continuousThroughputUsable(data, now)).toBe(true);
    expect(validOverview(data, data.runId, "catalog", data.asOf, false, now)).toBe(false);
  });
  it("allows bounded client-behind skew without extending owner or evidence freshness", () => {
    const { data: detail, catalog } = withDetail(fixture());
    const data = withSummary(detail);
    const tagId = "D01.A.crusher.ore_flow";
    const valuesAvailable = (clientNow: number) => ({
      overview: validContinuousOverview(
        data,
        data.runId,
        "catalog",
        "release-1",
        clientNow,
        catalog,
      ),
      throughput: continuousThroughputUsable(data, clientNow),
      reading: continuousTagReading(data, tagId, clientNow)?.quality,
      lines: continuousRunningLines(data, clientNow),
      summary: continuousSummaryFresh(data, clientNow),
    });
    expect(valuesAvailable(now - 1_400)).toEqual({
      overview: true,
      throughput: true,
      reading: "good",
      lines: 3,
      summary: true,
    });
    expect(valuesAvailable(now - 15_001)).toEqual({
      overview: false,
      throughput: false,
      reading: "unavailable",
      lines: null,
      summary: false,
    });
    expect(valuesAvailable(now + 10_000)).toEqual({
      overview: true,
      throughput: true,
      reading: "good",
      lines: 3,
      summary: true,
    });
    data.run.authorityUntil = new Date(now + 14_999).toISOString();
    expect(valuesAvailable(now)).toMatchObject({
      throughput: false,
      reading: "unavailable",
      lines: null,
      summary: false,
    });
    data.run.authorityUntil = new Date(now + 200_000).toISOString();
    expect(valuesAvailable(now + 30_001)).toMatchObject({ throughput: false, summary: false });
    expect(valuesAvailable(now + 75_001)).toMatchObject({
      overview: false,
      throughput: false,
      reading: "unavailable",
      lines: null,
      summary: false,
    });
    data.detail.lineStates[0].sampleTime = new Date(now - 180_001).toISOString();
    expect(continuousRunningLines(data, now)).toBeNull();
    const reading = data.readings.find((item) => item.tagId === tagId)!;
    reading.latestSampleTime = new Date(now - 90_001).toISOString();
    expect(continuousTagReading(data, tagId, now)).toMatchObject({ quality: "stale", value: null });
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
    expect(moduleStatus(data, "D01.A.crusher", "continuous", catalog, now)).toBe(
      "sensor evidence current",
    );
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
    expect(moduleStatus(data, "D01.A.crusher", "continuous", catalog, now)).toBe(
      "sensor evidence stale",
    );
    data.detail.lineStates[0].quality = "stale";
    data.detail.lineStates[0].sampleTime = new Date(now - 196_000).toISOString();
    data.detail.lineStates[0].ageSeconds = 196;
    Object.assign(data.detail.runningLines, { value: null, quality: "unavailable" });
    expect(validContinuousOverview(data, data.runId, "catalog", "release-1", now, catalog)).toBe(
      true,
    );
    expect(continuousRunningLines(data, now)).toBeNull();
  });
  it("validates current-owner intensity windows and preserves incomplete 24-hour coverage", () => {
    const { data, catalog } = withDetail(fixture());
    const summarized = withSummary(data);
    expect(
      validContinuousOverview(summarized, data.runId, "catalog", "release-1", now, catalog),
    ).toBe(true);
    expect(continuousSummaryFresh(summarized, now)).toBe(true);
    expect(
      continuousSummaryMetric(summarized, "30m", "grossProcessWaterIntensity", now),
    ).toMatchObject({ value: 2.1502, coverage: 0.966667, unit: "m\u00b3/t" });
    expect(continuousSummaryMetric(summarized, "2h", "energyIntensity", now)).toMatchObject({
      value: 2.1517 * 0.8,
      coverage: 0.991667,
    });
    expect(continuousSummaryMetric(summarized, "24h", "energyIntensity", now)).toBeNull();
    expect(validContinuousOverview(data, data.runId, "catalog", "release-1", now, catalog)).toBe(
      true,
    );
  });
  it("rejects malformed, foreign, low-coverage and stale continuous summary evidence", () => {
    const { data, catalog } = withDetail(fixture());
    const summarized = withSummary(data);
    for (const change of [
      { runId: "22222222-2222-4222-8222-222222222222" },
      { asOf: "2026-01-01T11:59:00Z" },
      {
        windows: summarized.continuousSummary.windows.slice(1),
      },
    ]) {
      const invalid = {
        ...summarized,
        continuousSummary: { ...summarized.continuousSummary, ...change },
      };
      expect(
        validContinuousOverview(invalid, data.runId, "catalog", "release-1", now, catalog),
      ).toBe(false);
    }
    for (const change of [
      { unit: "g/t" },
      { coverage: 1.01 },
      { quality: "good", value: 1, coverage: 0.89 },
      { quality: "good", value: Number.NaN },
    ]) {
      const invalid = withSummary(data);
      Object.assign(invalid.continuousSummary.windows[0].grossProcessWaterIntensity, change);
      expect(
        validContinuousOverview(invalid, data.runId, "catalog", "release-1", now, catalog),
      ).toBe(false);
    }
    const expired = withSummary({
      ...data,
      run: { ...data.run, authorityUntil: "2026-01-01T12:05:00Z" },
    });
    expect(continuousSummaryFresh(expired, now + 50_000)).toBe(false);
    expect(
      continuousSummaryMetric(expired, "30m", "grossProcessWaterIntensity", now + 50_000),
    ).toBeNull();
  });
  it("labels module sensor evidence without inferring equipment health or line schedule", () => {
    const { data, catalog } = withDetail(fixture());
    data.detail.lineStates[0].state = "fault";
    data.detail.lineStates[0].scheduledRunning = false;
    expect(moduleStatus(data, "D01.A.crusher", "continuous", catalog, now)).toBe(
      "sensor evidence current",
    );
    const tag = catalog.telemetry_tags.find(
      (item) => item.module_id === "D01.A.crusher" && item.metric === "vibration_rms",
    )!;
    const reading = data.detail.readings.find((item) => item.tagId === tag.id)!;
    reading.sampleTime = new Date(now - 105_000).toISOString();
    reading.receivedAt = new Date(now - 100_000).toISOString();
    reading.ageSeconds = 105;
    expect(moduleStatus(data, "D01.A.crusher", "continuous", catalog, now + 1)).toBe(
      "sensor evidence stale",
    );
    reading.quality = "bad";
    reading.value = null;
    expect(moduleStatus(data, "D01.A.crusher", "continuous", catalog, now)).toBe(
      "sensor evidence flagged",
    );
    reading.quality = "missing";
    expect(moduleStatus(data, "D01.A.crusher", "continuous", catalog, now)).toBe(
      "sensor evidence incomplete",
    );
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
      continuousSummaryFresh: (value: object, at: number) => continuousSummaryFresh(value, at),
      continuousSummaryMetric: (value: object, window: string, metric: string, at: number) =>
        continuousSummaryMetric(value, window, metric, at),
      $: element,
      text: (id: string, value: string) => rendered.set(id, value),
      timestamp: formatTimestamp,
      coverage: String,
      number: String,
      preciseNumber: String,
      units: ["t/h", "lines", "m\u00b3/t", "kWh/t"],
      node: () => ({}),
      kpis: ["throughput", "runningLines", "grossProcessWaterIntensity", "energyIntensity"],
      drawPlant() {},
      drawDrawer() {},
      drawShift() {},
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
describe("retrospective continuous advisory presentation", () => {
  it("accepts only current-window evidence without durable incident identities or timestamps", () => {
    const now = Date.parse("2026-01-01T12:00:00.000Z");
    const runId = "11111111-1111-4111-8111-111111111111";
    const catalog = readCatalog();
    const asOf = new Date(now - 60_000).toISOString();
    const windowStart = new Date(Date.parse(asOf) - 20 * 60_000).toISOString();
    const sourceObservedAt = new Date(now).toISOString();
    const valid = {
      assessmentKind: "rolling-event-time-advisory",
      plantId: "D01",
      catalogVersion: "catalog",
      runId,
      generation: "release-1",
      windowStart,
      asOf,
      sourceObservedAt,
      totalAdvisories: 1,
      advisories: [
        {
          ruleId: "crusher-vibration",
          scopeId: "B",
          severity: "warning",
          verification: "verified",
          evidenceWindow: { start: windowStart, end: asOf },
          evidence: [
            {
              tagId: catalog.telemetry_tags[0].id,
              value: 1,
              unit: catalog.telemetry_tags[0].unit,
              sampleTime: new Date(Date.parse(asOf) - 30_000).toISOString(),
              quality: "good",
            },
          ],
          stateEvidence: [],
        },
      ],
    };
    const args = [runId, "catalog", "release-1", now, catalog] as const;
    expect(validContinuousAdvisories(valid, ...args)).toBe(true);
    expect(
      validContinuousAdvisories(
        { ...valid, advisories: [{ ...valid.advisories[0], incidentId: "invented" }] },
        ...args,
      ),
    ).toBe(false);
    expect(
      validContinuousAdvisories(
        {
          ...valid,
          advisories: [
            {
              ...valid.advisories[0],
              evidence: [
                {
                  ...valid.advisories[0].evidence[0],
                  sampleTime: new Date(now + 1_000).toISOString(),
                },
              ],
            },
          ],
        },
        ...args,
      ),
    ).toBe(false);
    expect(
      validContinuousAdvisories(
        { ...valid, sourceObservedAt: new Date(now + 16_000).toISOString() },
        ...args,
      ),
    ).toBe(false);
    expect(validContinuousAdvisories({ ...valid, generation: "another-owner" }, ...args)).toBe(
      false,
    );
    expect(validContinuousAdvisories({ ...valid, totalAdvisories: 0 }, ...args)).toBe(false);
  });
});
describe("cross-run chart validation", () => {
  it("discards pending line charts after a selection change and requests only scoped families", async () => {
    const source = readFileSync(new URL("../src/ui/public/mining/app.js", import.meta.url), "utf8");
    const tree = ts.createSourceFile(
      "app.js",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const fn = tree.statements.find(
      (statement) =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "refreshContextualTrends",
    );
    if (!fn) throw new Error("Missing contextual trend refresh");
    const params = {
      plantId: "D01",
      runId: "11111111-1111-4111-8111-111111111111",
      start: "2026-01-01T12:00:00.000Z",
      end: "2026-01-01T12:01:00.000Z",
      asOf: "2026-01-01T12:01:10.000Z",
      binMinutes: "1",
      maxRows: "1000",
    };
    const controls: Record<string, any> = {
      "line-scope": { value: "A" },
      "diagnostic-asset": { value: "" },
      diagnostic: { value: "water-energy" },
      "feed-chart": {},
      "line-chart": {
        replaceChildren: vi.fn(),
        prepend: vi.fn(),
      },
      "diagnostic-extra": { replaceChildren: vi.fn(), append: vi.fn() },
    };
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = vi.fn(async (_path, request) => {
      if (request.moduleId.includes(".A.")) await pending;
      return { rows: [], windowStart: params.start, windowEnd: params.end, binMinutes: 1 };
    });
    const chart = vi.fn();
    const sandbox: any = {
      contextualGeneration: 0,
      requestEpoch: 0,
      document: { hidden: false },
      context: { readAvailable: true, mode: "finite", approvedRun: { runId: params.runId } },
      query: () => params,
      $: (id: string) => controls[id],
      text: vi.fn(),
      node: () => ({}),
      reads: { read },
      seriesQuery,
      validSeries: () => true,
      usable,
      chart,
      catalog: {},
      catalogVersion: "catalog",
    };
    runInNewContext(`${fn.getText(tree)}; this.run = refreshContextualTrends;`, sandbox);
    const older = sandbox.run("diagnostic");
    controls["line-scope"].value = "B";
    await sandbox.run("diagnostic");
    release();
    await older;
    expect(chart).toHaveBeenCalledTimes(1);
    const requests = read.mock.calls.map((call) => call[1]);
    expect(requests.map((request) => [request.moduleId, request.metric])).toEqual([
      ["D01.A.crusher", "feed"],
      ["D01.A.sorter", "sorter-feed"],
      ["D01.B.crusher", "feed"],
      ["D01.B.sorter", "sorter-feed"],
    ]);
    expect(requests[0].asOf).toBeUndefined();
    expect(requests[1].asOf).toBe(params.asOf);
  });
  it("uses only fresh explicit line state and never treats flow or a fault as running", () => {
    const now = Date.parse("2026-01-01T12:01:00.000Z");
    const state = {
      scopeId: "A",
      state: "running",
      scheduledRunning: true,
      sampleTime: "2026-01-01T12:00:30.000Z",
    };
    const overview = { asOf: "2026-01-01T12:01:00.000Z", latest: { lineStates: [state] } };
    expect(lineOperatingState(overview, "A", "finite", now)).toBe("running");
    expect(lineOperatingState(overview, "A", "finite", now + 196_000)).toBe("unknown");
    expect(
      lineOperatingState(
        { ...overview, latest: { lineStates: [{ ...state, state: "stopped" }] } },
        "A",
        "finite",
        now,
      ),
    ).toBe("stopped");
    expect(
      lineOperatingState(
        { ...overview, latest: { lineStates: [{ ...state, state: "fault" }] } },
        "A",
        "finite",
        now,
      ),
    ).toBe("unknown");
    expect(
      lineOperatingState(
        { ...overview, latest: { lineStates: [state, state] } },
        "A",
        "finite",
        now,
      ),
    ).toBe("unknown");
    expect(lineOperatingState(overview, "B", "finite", now)).toBe("unknown");
    expect(lineOperatingState(overview, "A", "finite", now + 196_000, true)).toBe("running");
  });
  it("keeps keyboard source order aligned with the workspace journey", () => {
    const html = readFileSync(
      new URL("../src/ui/public/mining/index.html", import.meta.url),
      "utf8",
    );
    const ids = [
      "run-start",
      "kpi-throughput",
      "line-scope",
      "object-disclosure",
      "asset-detail",
      "diagnostics",
    ];
    const offsets = ids.map((id) => html.indexOf(`id="${id}"`));
    expect(offsets.every((offset) => offset >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });
  it("offers only the live Mining view without replay controls", () => {
    const html = readFileSync(new URL("../src/ui/public/mining/index.html", import.meta.url), "utf8");
    const source = readFileSync(new URL("../src/ui/public/mining/app.js", import.meta.url), "utf8");
    expect(html).not.toMatch(/id="(?:mode|replay-time|replay-label)"/);
    expect(source).not.toMatch(/\$\("(?:mode|replay-time|replay-label)"\)/);
    expect(source).toContain('const mode = "live"');
  });
  it.each(["bounded", "continuous", "unavailable"])(
    "shows the preparation notice only for a verified bounded status: %s",
    async (mode) => {
      const source = readFileSync(new URL("../src/ui/public/mining/app.js", import.meta.url), "utf8");
      const tree = ts.createSourceFile("app.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const update = tree.statements.find(
        (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "updateDemoStatus",
      );
      if (!update) throw new Error("Missing demo status function");
      const elements: Record<string, { hidden?: boolean; disabled?: boolean }> = {};
      const sandbox = {
        demoBusy: false, demoStatusEpoch: 0, demoRun: null,
        nativeDemoLive: false, fastDemoStatus: false, fabricDemoSignal: false,
        document: { hidden: false }, context: null, catalog: null,
        demoRequest: mode === "unavailable"
          ? vi.fn().mockRejectedValue(new Error("offline"))
          : vi.fn().mockResolvedValue({ plantId: "D01", mode, run: null }),
        $: (id: string) => (elements[id] ??= {}),
        activePublisher: () => false, text: vi.fn(),
        drawStartupPreview: vi.fn(), drawDemoRunStatus: vi.fn(),
        updateDemoStatus: undefined as undefined | (() => Promise<void>),
      };
      runInNewContext(`${update.getText(tree)}; this.updateDemoStatus = updateDemoStatus;`, sandbox);
      await sandbox.updateDemoStatus!();
      expect(elements["run-warmup"].hidden).toBe(mode !== "bounded");
    },
  );
  it("keeps compact latest readings before closed provenance and supplemental plots after primary plots", () => {
    const html = readFileSync(
      new URL("../src/ui/public/mining/index.html", import.meta.url),
      "utf8",
    );
    expect(html).toMatch(
      /id="latest-readings"[\s\S]*?<details>\s*<summary>Sensor readings and provenance<\/summary>/,
    );
    expect(html).toMatch(
      /id="diagnostic-chart"><\/div>\s*<\/article>\s*<div id="diagnostic-extra"/,
    );
    expect(html).toMatch(/<details class="kpi-details">\s*<summary>Indicator details<\/summary>/);
  });
  it("shows validated latest values and never exposes a stale reading as current", () => {
    const source = readFileSync(new URL("../src/ui/public/mining/app.js", import.meta.url), "utf8");
    const tree = ts.createSourceFile(
      "app.js",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const fn = tree.statements.find(
      (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "drawDrawer",
    );
    if (!fn) throw new Error("Missing equipment drawer");
    const elements: Record<string, any> = {};
    const element = (id: string) =>
      (elements[id] ??= {
        children: [],
        get childNodes() {
          return this.children;
        },
        replaceChildren(...children: any[]) {
          this.children = children;
        },
        append(...children: any[]) {
          this.children.push(...children);
        },
      });
    const tag = (metric: string) => ({ id: metric, metric, equipment_id: "e", unit: "t/h" });
    const tags = [tag("ore_flow"), tag("stale_flow"), tag("medium_density")];
    const sandbox: any = {
      catalog: { modules: [{ id: "D01.A.crusher", kind: "crusher", label: "Crusher" }] },
      selected: "D01.A.crusher",
      selectedIncident: null,
      context: { mode: "finite" },
      overview: {
        quality: "good",
        latest: {
          readings: [
            {
              tagId: "ore_flow",
              moduleId: "D01.A.crusher",
              equipmentId: "e",
              unit: "t/h",
              quality: "good",
              value: 42,
              sampleTime: "2026-01-01T00:00:00Z",
            },
            {
              tagId: "stale_flow",
              moduleId: "D01.A.crusher",
              equipmentId: "e",
              unit: "t/h",
              quality: "stale",
              value: 99,
              sampleTime: "2026-01-01T00:00:00Z",
            },
          ],
        },
      },
      $: element,
      text: vi.fn(),
      relevantTags: () => tags,
      moduleStatus: () => "current",
      usable,
      number: (value: number) => String(value),
      timestamp: () => "time",
      unknownQuality,
      connections: () => [],
      drawIncidentEvidence: vi.fn(),
      node: (_type: string, value?: string) => ({
        value,
        children: [],
        append(...children: any[]) {
          this.children.push(...children);
        },
      }),
    };
    runInNewContext(`${fn.getText(tree)}; drawDrawer();`, sandbox);
    expect(elements["latest-readings"].children.map((item: any) => item.value)).toEqual([
      "ore flow: 42 t/h",
      "stale flow: Unknown t/h",
      "medium density: Unknown t/h",
    ]);
    sandbox.context.capabilities = { connectionFlow: true };
    sandbox.overview.quality = "missing";
    sandbox.mode = "live";
    sandbox.catalog.streams = [];
    sandbox.connectionFlow = null;
    sandbox.catalogVersion = "pinned";
    sandbox.validConnectionFlow = () => false;
    runInNewContext(`${fn.getText(tree)}; drawDrawer();`, sandbox);
    expect(elements["latest-readings"].children.map((item: any) => item.value)).toEqual([
      "ore flow: 42 t/h",
      "stale flow: Unknown t/h",
      "medium density: Not simulated",
    ]);
    sandbox.context.capabilities.connectionFlow = false;
    runInNewContext(`${fn.getText(tree)}; drawDrawer();`, sandbox);
    expect(elements["latest-readings"].children[0].value).toBe("ore flow: Unknown t/h");
    expect(elements["latest-readings"].children[2].value).toBe("medium density: Unknown t/h");
  });
  it("accepts observed evidence and fails closed on foreign ownership, samples and statuses", () => {
    const catalog = readCatalog();
    const tag = catalog.telemetry_tags.find((item) => item.id === "D01.A.crusher.ore_flow")!;
    const runId = "11111111-1111-4111-8111-111111111111";
    const owner = { runId, generation: "release-1" };
    const start = "2026-01-01T12:00:00.000Z";
    const end = "2026-01-01T12:01:00.000Z";
    const params = { start, end, metric: "feed", binMinutes: "1" };
    const point = {
      runId,
      seriesId: tag.id,
      moduleId: tag.module_id,
      equipmentId: tag.equipment_id,
      metric: tag.metric,
      unit: tag.unit,
      binStart: start,
      firstSampleTime: start,
      lastSampleTime: "2026-01-01T12:00:30.000Z",
      firstReceivedAt: "2026-01-01T12:00:01.000Z",
      lastReceivedAt: "2026-01-01T12:00:31.000Z",
      sampleTimes: [start, "2026-01-01T12:00:30.000Z"],
      sampleCount: 2,
      coverage: 1,
      quality: "good",
      status: "OBSERVED",
      value: 42,
      coverageComplete: true,
      ambiguousOwner: false,
      cadenceConflict: false,
      segmentId: `${runId}:${tag.id}:${start}`,
    };
    const data = {
      ...params,
      binMinutes: 1,
      asOf: "2026-01-01T12:01:01.000Z",
      catalogVersion: "catalog",
      profileVersion: "d01-publish-profile-v1",
      owner: { ...owner, authorityUntil: "2026-01-01T12:02:00.000Z" },
      points: [point],
    };
    const now = Date.parse("2026-01-01T12:01:02.000Z");
    const validate = (candidate: typeof data) =>
      crossRunChartData(candidate, params, "catalog", catalog, owner, now);
    expect(validate(data)?.rows[0]).toMatchObject({ runId, timestamp: start, value: 42 });
    expect(validate({ ...data, owner: { ...data.owner, generation: "other" } })).toBeNull();
    expect(validate({ ...data, points: [point, point] })).toBeNull();
    expect(validate({ ...data, points: [{ ...point, status: "AMBIGUOUS_OWNER" }] })).toBeNull();
    expect(validate({ ...data, points: [{ ...point, sampleTimes: [start] }] })).toBeNull();
    expect(validate({ ...data, points: [{ ...point, unit: "kg/m3" }] })).toBeNull();
    expect(validate({ ...data, points: [] })?.rows).toEqual([]);
    const sorter = catalog.telemetry_tags.find((item) => item.id === "D01.A.sorter.ore_flow")!;
    const sorterPoint = {
      ...point,
      seriesId: sorter.id,
      moduleId: sorter.module_id,
      equipmentId: sorter.equipment_id,
      metric: sorter.metric,
      unit: sorter.unit,
      segmentId: `${runId}:${sorter.id}:${start}`,
    };
    const finiteParams = {
      ...params,
      metric: "sorter-feed",
      runId,
      moduleId: sorter.module_id,
      asOf: data.asOf,
      maxRows: "1000",
    };
    const finite = {
      ...data,
      ...finiteParams,
      plantId: "D01",
      binMinutes: 1,
      windowStart: start,
      windowEnd: end,
      points: [sorterPoint],
      rows: [{ ...sorterPoint, timestamp: start }],
    };
    expect(validSeries(finite, finiteParams, "catalog", catalog)).toBe(true);
    expect(validSeries({ ...finite, asOf: end }, finiteParams, "catalog", catalog)).toBe(false);
    expect(
      validSeries(
        { ...finite, points: [{ ...sorterPoint, runId: "22222222-2222-4222-8222-222222222222" }] },
        finiteParams,
        "catalog",
        catalog,
      ),
    ).toBe(false);
    expect(
      validSeries({ ...finite, moduleId: "D01.B.sorter" }, finiteParams, "catalog", catalog),
    ).toBe(false);
    expect(
      crossRunChartData(data, params, "catalog", catalog, owner, Date.parse(data.asOf) - 1_400),
    ).not.toBeNull();
    expect(
      crossRunChartData(data, params, "catalog", catalog, owner, Date.parse(data.asOf) - 15_001),
    ).toBeNull();
    expect(
      crossRunChartData(data, params, "catalog", catalog, owner, Date.parse(data.asOf) + 10_000),
    ).not.toBeNull();
    expect(
      crossRunChartData(data, params, "catalog", catalog, owner, Date.parse(data.asOf) + 75_001),
    ).toBeNull();
    expect(
      validate({
        ...data,
        owner: { ...data.owner, authorityUntil: new Date(now + 15_000).toISOString() },
      }),
    ).toBeNull();
  });
});
describe("mining chart legends", () => {
  it("breaks cross-run charts on ownership, gaps and non-observed bins and marks singletons", () => {
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
    const run1 = "run-one";
    const run2 = "run-two";
    const entries = [
      [0, run1, "segment-a", "OBSERVED", 10],
      [1, run1, "segment-a", "OBSERVED", 11],
      [2, run2, "segment-b", "OBSERVED", 12],
      [3, run2, null, "AMBIGUOUS_OWNER", null],
      [4, run2, "segment-c", "OBSERVED", 14],
      [6, run2, "segment-c", "OBSERVED", 16],
    ];
    const rows = entries.map(([minute, runId, segmentId, status, value]) => ({
      timestamp: `2026-11-15T20:0${minute}:00.000Z`,
      firstSampleTime: `2026-11-15T20:0${minute}:05.000Z`,
      lastSampleTime: `2026-11-15T20:0${minute}:35.000Z`,
      seriesId: "A",
      unit: "t/h",
      quality: "good",
      coverage: 1,
      runId,
      segmentId,
      status,
      value,
    }));
    const context = {
      catalog: { telemetry_tags: [{ id: "A", unit: "t/h" }] },
      usable,
      number: String,
      timestamp: formatTimestamp,
      coverage: String,
      node: (tag: string, content?: string) => new Element(tag, content),
      document: { createElementNS: (_namespace: string, tag: string) => new Element(tag) },
      chart: undefined as undefined | ((container: Element, data: object) => void),
    };
    runInNewContext(`${chart.getText(tree)}; this.chart = chart;`, context);
    const container = new Element("div");
    context.chart!(container, {
      crossRun: true,
      binMinutes: 1,
      windowStart: "2026-11-15T20:00:00.000Z",
      windowEnd: "2026-11-15T20:07:00.000Z",
      rows,
    });
    const shapes = container.children[0].children.filter((shape) =>
      ["polyline", "circle"].includes(shape.tag),
    );
    expect(shapes.map((shape) => shape.tag)).toEqual(["polyline", "circle", "circle", "circle"]);
    expect(shapes[0].attributes.points.split(" ")).toHaveLength(2);
    const table = container.children.find((child) => child.tag === "details")!;
    const contents = JSON.stringify(table);
    expect(contents).toContain("run-two");
    expect(contents).toContain("AMBIGUOUS_OWNER");
    expect(contents).toContain("2026-11-15T20:02:05.000Z");
    expect(JSON.stringify(container)).toContain("missing rows mean no bin was returned");
  });
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
    const curves = container.children[0].children.filter((shape) => shape.tag === "polyline");
    expect(curves).toHaveLength(4);
    expect(curves[0].attributes.points).toBe("40,165");
    expect(curves[1].attributes.points).toBe(`400,${165 - (10 / 210) * 120}`);
    expect(curves[3].attributes.points).toBe(`40,${165 - (190 / 210) * 120} 220,45`);
    expect(JSON.stringify(data)).toBe(original);
    const gapContainer = new Element("div");
    context.chart(gapContainer, {
      ...data,
      rows: rows.filter((row) => row.seriesId === "A" && row.quality === "good"),
    });
    expect(
      gapContainer.children[0].children.filter((shape) => shape.tag === "polyline"),
    ).toHaveLength(2);
  });
});
describe("mining request lifecycle", () => {
  it("keeps continuous chart windows behind the server under bounded client-ahead skew", () => {
    const source = readFileSync(new URL("../src/ui/public/mining/app.js", import.meta.url), "utf8");
    const tree = ts.createSourceFile(
      "app.js",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const query = tree.statements.find(
      (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "query",
    );
    if (!query) throw new Error("Missing query function");
    const serverNow = Date.parse("2026-01-01T12:00:07.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(serverNow + continuousClockSkewMs);
    const sandbox = {
      Date,
      mode: "live",
      context: { mode: "continuous", approvedRun: { runId: "owner" } },
      demoRun: null,
      continuousClockSkewMs,
      $: () => ({ value: "30" }),
      query: undefined as undefined | (() => { end: string }),
    };
    runInNewContext(`${query.getText(tree)}; this.query = query;`, sandbox);
    expect(Date.parse(sandbox.query!().end)).toBeLessThanOrEqual(serverNow);
    sandbox.context.mode = "bounded";
    expect(Date.parse(sandbox.query!().end)).toBe(
      Math.floor((serverNow + continuousClockSkewMs) / 15_000) * 15_000,
    );
  });
  it.each(["status failure", "generation change"])(
    "withdraws trends and invalidates pending reads on %s",
    async (scenario) => {
      const source = readFileSync(
        new URL("../src/ui/public/mining/app.js", import.meta.url),
        "utf8",
      );
      const tree = ts.createSourceFile(
        "app.js",
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      );
      const update = tree.statements.find(
        (statement) =>
          ts.isFunctionDeclaration(statement) && statement.name?.text === "updateDemoStatus",
      );
      if (!update) throw new Error("Missing demo status function");
      const runId = "44444444-4444-4444-8444-444444444444";
      const clearReadState = vi.fn();
      const invalidate = vi.fn();
      const reset = vi.fn();
      const context = {
        demoBusy: false,
        demoStatusEpoch: 0,
        nativeDemoLive: false,
        fastDemoStatus: false,
        fabricDemoSignal: false,
        document: { hidden: false },
        demoRun: null,
        context: { mode: "continuous", approvedRun: { runId, generation: "g1" } },
        continuousOverview: { runId },
        catalog: {},
        demoRequest:
          scenario === "status failure"
            ? vi.fn().mockRejectedValue(new Error("offline"))
            : vi.fn().mockResolvedValue({
                plantId: "D01",
                mode: "continuous",
                run: { runId, generation: "g2", publisherStatus: "running", stopRequested: false },
              }),
        $: () => ({}),
        text: vi.fn(),
        clearReadState,
        invalidate,
        reads: { reset },
        drawOverview: vi.fn(),
        drawDemoRunStatus: vi.fn(),
        drawStartupPreview: vi.fn(),
        loadContext: vi.fn(),
        updateDemoStatus: undefined as undefined | (() => Promise<void>),
      };
      runInNewContext(
        `${update.getText(tree)}; this.updateDemoStatus = updateDemoStatus;`,
        context,
      );
      await context.updateDemoStatus!();
      expect(invalidate).toHaveBeenCalled();
      expect(reset).toHaveBeenCalled();
      expect(clearReadState).toHaveBeenCalledWith(expect.stringContaining("withdrawn"));
    },
  );
  it("loads continuous chart requests without a run filter and retains separate owner validation", async () => {
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
    const params = {
      start: "2026-11-15T18:37:00.000Z",
      end: "2026-11-15T19:07:00.000Z",
      binMinutes: "1",
    };
    const read = vi.fn(async (path: string) =>
      path === "overview" ? { evidence: true } : { path },
    );
    const chart = vi.fn();
    const adapt = vi.fn((data) => ({ data, rows: [] }));
    const context = {
      context: {
        mode: "continuous",
        readAvailable: true,
        approvedRun: { runId: "owner", generation: "g1" },
        capabilities: { incidents: false, trends: true },
      },
      requestEpoch: 0,
      document: { hidden: false },
      reads: { read },
      catalog: {},
      catalogVersion: "catalog",
      continuousOverview: null,
      overview: null,
      incidents: [],
      query: () => params,
      validContinuousOverview: () => true,
      validContinuousAdvisories: () => false,
      crossRunChartData: adapt,
      drawOverview: vi.fn(),
      clearReadState: vi.fn(),
      drawContinuousAdvisories: vi.fn(),
      drawDiagnosticScope: vi.fn(),
      text: vi.fn(),
      chart,
      $: (id: string) =>
        id === "diagnostic"
          ? { value: "density" }
          : id === "diagnostic-asset"
            ? { value: "D01.A.dms" }
            : id === "incidents"
              ? { replaceChildren: vi.fn() }
              : id,
      refresh: undefined as undefined | ((scope: string) => Promise<void>),
    };
    runInNewContext(`${refresh.getText(tree)}; this.refresh = refresh;`, context);
    await context.refresh!("all");
    const trendCalls = read.mock.calls.filter(([path]) => path === "cross-run-trends");
    expect(trendCalls).toHaveLength(2);
    expect(trendCalls.map(([, query]) => query)).toEqual([
      { plantId: "D01", ...params, metric: "feed" },
      { plantId: "D01", ...params, metric: "density" },
    ]);
    expect(adapt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "catalog",
      context.catalog,
      { runId: "owner", generation: "g1" },
    );
    expect(chart).toHaveBeenCalledTimes(2);
    context.context.capabilities.incidents = true;
    read.mockClear();
    chart.mockClear();
    context.drawOverview.mockClear();
    context.drawContinuousAdvisories.mockClear();
    await context.refresh!("all");
    expect(read.mock.calls.map(([path]) => path)).toContain("incidents");
    expect(context.drawOverview).toHaveBeenCalledOnce();
    expect(context.drawContinuousAdvisories).toHaveBeenCalledWith(
      expect.stringContaining("Rolling advisory evidence is invalid"),
    );
    expect(chart).toHaveBeenCalledTimes(2);
    read.mockClear();
    chart.mockClear();
    context.context.capabilities.trends = false;
    context.context.capabilities.incidents = false;
    await context.refresh!("all");
    expect(read.mock.calls.map(([path]) => path)).toEqual(["overview"]);
    expect(chart).toHaveBeenCalledWith("feed-chart", null);
    expect(chart).toHaveBeenCalledWith("diagnostic-chart", null);
  });
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
      drawPlant: vi.fn(),
      drawOverview: vi.fn(),
      clearReadState: vi.fn(),
      drawContinuousAdvisories: vi.fn(),
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
  it("explains unsupported density and incidents without reporting an outage for flow runs", async () => {
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
    const read = vi.fn(async (_path: string) => ({}));
    const diagnostic = { value: "density" };
    const asset = { value: "D01.A.dms" };
    const graph = { append: vi.fn() };
    const context = {
      mode: "live",
      incidents: [],
      incidentAsOf: null,
      incidentAssessment: null,
      selectedIncident: null,
      requestEpoch: 0,
      document: { hidden: false },
      context: {
        readAvailable: true,
        approvedRun: { runId: "approved" },
        capabilities: { connectionFlow: true },
      },
      query: () => ({ plantId: "D01", runId: "approved" }),
      reads: { read },
      currentIncidentQuery,
      seriesQuery,
      validSeries: () => true,
      catalog: {},
      catalogVersion: "pinned",
      drawIncidents: vi.fn(),
      drawDrawer: vi.fn(),
      drawPlant: vi.fn(),
      drawContinuousAdvisories: vi.fn(),
      drawDiagnosticScope: vi.fn(),
      chart: vi.fn(),
      node: (_tag: string, value: string) => value,
      $: (id: string) =>
        id === "diagnostic" ? diagnostic : id === "diagnostic-asset" ? asset : graph,
      refresh: undefined as undefined | ((scope: string) => Promise<void>),
    };
    runInNewContext(`${refresh.getText(tree)}; this.refresh = refresh;`, context);
    await context.refresh!("detail");
    expect(read.mock.calls.map(([path]) => path)).toEqual(["compare-lines"]);
    expect(graph.append).toHaveBeenCalledWith("Density is not simulated in this flow profile.");
    expect(context.drawIncidents).toHaveBeenCalledWith(
      "Incident assessments are not available for this flow simulation.",
    );
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
      plantId: "D01",
      runId: "approved",
      catalogVersion: "pinned",
      run: { plantId: "D01", runId: "approved", catalogVersion: "pinned" },
      asOf: "2026-01-01T12:00:20.000Z",
      latest: { modules: Array(24).fill({}), readings: Array(56).fill({}) },
    };
    expect(validOverview(data, "approved", "pinned", requested, false, received)).toBe(true);
    expect(validOverview(data, "approved", "pinned", requested, true, received)).toBe(false);
    expect(
      validOverview(
        {
          ...data,
          asOf: "2026-01-01T11:58:54.000Z",
        },
        "approved",
        "pinned",
        requested,
        false,
        received,
      ),
    ).toBe(false);
    expect(
      validOverview(
        {
          ...data,
          asOf: "2026-01-01T12:00:41.000Z",
        },
        "approved",
        "pinned",
        requested,
        false,
        received,
      ),
    ).toBe(false);
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
  it("labels connection verification as a cutoff and flags later changes", () => {
    const run = { runId: "approved" };
    const overview = {
      run,
      connectionIngestion: {
        status: "complete",
        provenance: "fabric-connection-reconciliation-v1",
        asOf: "2026-01-01T12:00:00.000Z",
        checkedAt: "2026-01-01T12:01:00.000Z",
      },
    };
    expect(verifiedRunIngestion(overview, run)).toMatch(/^complete as of .*row counts checked/);
    expect(
      verifiedRunIngestion(
        {
          ...overview,
          connectionIngestion: { ...overview.connectionIngestion, status: "changed" },
        },
        run,
      ),
    ).toMatch(/^changed after verification/);
    expect(verifiedRunIngestion(overview, { runId: "other" })).toBe("unknown");
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
    await expect(reads.read("context")).rejects.toThrow("Live readings unavailable");
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
      validIncidentAssociation({ moduleId: null, metric: null, affectedModuleIds: [] }, catalog),
    ).toBe(true);
    expect(
      validIncidentAssociation({ moduleId: null, metric: "feed", affectedModuleIds: [] }, catalog),
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
      render(scene: THREE.Scene, camera: THREE.Camera) {
        renders.push({ scene, camera });
      }
      dispose() {}
    }
    class Controls {
      target = new THREE.Vector3();
      enabled = true;
      constructor(private readonly camera: THREE.Camera) {}
      update() {
        this.camera.lookAt(this.target);
      }
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
      dispose() {
        disposeSplat();
      }
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
      ...(await vi.importActual<typeof import("three")>("three")),
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
      if (!camera) throw new Error("Missing rendered camera");
      camera.position.set(200, 200, 200);
      viewer.fit();
      camera.updateMatrixWorld(true);
      const projected = catalog.modules.flatMap((module) =>
        [-1, 1].flatMap((x) =>
          [-1, 1].flatMap((y) =>
            [-1, 1].map((z) =>
              new THREE.Vector3(
                (x * module.size[0]) / 2,
                (y * module.size[1]) / 2,
                (z * module.size[2]) / 2,
              )
                .applyEuler(new THREE.Euler(...module.rotation))
                .add(new THREE.Vector3(...module.position))
                .project(camera),
            ),
          ),
        ),
      );
      expect(projected.every((point) => Math.abs(point.x) < 1 && Math.abs(point.y) < 1)).toBe(true);
      const span = (axis: "x" | "y") =>
        Math.max(...projected.map((point) => point[axis])) -
        Math.min(...projected.map((point) => point[axis]));
      expect(Math.max(span("x"), span("y"))).toBeGreaterThan(1.2);
      const selectedBox = renders
        .at(-1)
        ?.scene.children.find((child) => child instanceof THREE.BoxHelper && child.visible);
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
    expect(() => validateAppearanceBundle(catalog, invalidMetadata, scene, files, quality)).toThrow(
      /outside the pinned plant path/,
    );
    expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);

    const invalidQuality = structuredClone(quality);
    invalidQuality.assets[source.sha256].render_bounds.max[0] =
      invalidQuality.assets[source.sha256].render_bounds.min[0];
    expect(() => validateAppearanceBundle(catalog, metadata, scene, files, invalidQuality)).toThrow(
      /quality record/,
    );
  });

  it("bounds response reads and requires review-only display for screened assets", async () => {
    await expect(readBoundedBytes(new Response(new Uint8Array(5)), 4)).rejects.toThrow(
      /size limit/,
    );
    await expect(readBoundedBytes(new Response(new Uint8Array([1, 2, 3])), 3)).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
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
    const clean = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3), new THREE.MeshBasicMaterial());
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
