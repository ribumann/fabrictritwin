import { readFileSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";
import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  validSeries,
} from "../src/ui/public/mining/data.js";
import { connections, createPlant3D, relevantTags, visibleModules } from "../src/ui/public/mining/plant.js";
import {
  APPEARANCE_RELEASE,
  fitModelToNode,
  fitSplatToNode,
  localSplatPath,
  readBoundedBytes,
  splatFit,
  validateAppearanceBundle,
} from "../src/ui/public/mining/appearance.js";

const reconstructedSource = new URL("../src/ui/public/mining/plant/reconstructed/source/", import.meta.url);
const readJson = (path: string) =>
  JSON.parse(readFileSync(new URL(path, reconstructedSource), "utf8"));
const readCatalog = () =>
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
describe("mining request lifecycle", () => {
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
