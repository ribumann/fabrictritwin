import {
  MiningReads,
  MiningPolling,
  usable,
  formatTimestamp,
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
  validIncidentAssessment,
  incidentAssessmentLabel,
  validSeries,
  crossRunChartData,
  seriesQuery,
  verifiedRunIngestion,
  validContinuousOverview,
  continuousThroughputUsable,
  continuousTagReading,
  continuousRunningLines,
  continuousSummaryFresh,
  continuousSummaryMetric,
  continuousClockSkewMs,
} from "./data.js";
import { visibleModules, connections, relevantTags, renderTop, createPlant3D } from "./plant.js";
import {
  APPEARANCE_RELEASE,
  readBoundedBytes,
  sha256Hex,
  splatIssue,
  validateAppearanceBundle,
} from "./appearance.js";

const $ = (id) => document.getElementById(id);
const text = (id, value) => {
  $(id).textContent = value;
};
const node = (tag, content) => {
  const element = document.createElement(tag);
  if (content !== undefined) element.textContent = content;
  return element;
};
const number = (value) =>
  Number.isFinite(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : "Unknown";
const preciseNumber = (value) =>
  Number.isFinite(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: 4 })
    : "Unknown";
const timestamp = formatTimestamp;
const coverage = (value) =>
  Number.isFinite(value) && value >= 0 && value <= 1 ? `${Math.round(value * 100)}%` : "unknown";
const reads = new MiningReads();
let catalog,
  catalogVersion,
  context,
  overview,
  continuousOverview,
  selected,
  plant3d,
  requestEpoch = 0,
  selectedIncident = null;
let incidents = [];
let incidentAsOf = null;
let incidentAssessment = null;
let mode = "live";
let replayTime = null;
let appearanceMode = "clean";
let showScreenedOut = false;
let appearanceBundle = null;
let appearanceBundlePromise = null;
let appearanceController = null;
let appearanceGeneration = 0;
let answerController = null;
const lines = new Set(["A", "B", "C", "shared"]);
const polling = new MiningPolling((scope) => refresh(scope));
const kpis = ["throughput", "runningLines", "grossProcessWaterIntensity", "energyIntensity"];
const units = ["t/h", "lines", "m³/t", "kWh/t"];

function authorizedFabricUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "app.fabric.microsoft.com" &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
function configurePolling() {
  polling.update({
    mode,
    hidden: document.hidden,
    connected: !!context?.readAvailable && !!context?.approvedRun,
  });
  plant3d?.setEnabled(!document.hidden && $("view").value === "3d");
  const canAsk =
    mode === "live" &&
    context?.assistant?.available &&
    context?.assistant?.kind === "bounded-fabric-evidence" &&
    context?.approvedRun &&
    !answerController;
  $("mining-question").disabled = !canAsk;
  $("mining-ask-submit").disabled = !canAsk;
}
function query() {
  const asOf =
    mode === "replay"
      ? replayTime
      : new Date(
          Math.floor(
            (Date.now() - (context?.mode === "continuous" ? continuousClockSkewMs : 0)) / 15_000,
          ) * 15_000,
        ).toISOString();
  if (!asOf || !Number.isFinite(Date.parse(asOf)))
    throw new Error("Choose a valid UTC replay time.");
  const minutes = Number($("window").value);
  return {
    plantId: "D01",
    runId: context.approvedRun.runId,
    asOf,
    start: new Date(Date.parse(asOf) - minutes * 60_000).toISOString(),
    end: asOf,
    binMinutes: minutes > 30 ? "5" : "1",
    maxRows: "1000",
  };
}
function drawPlant() {
  if (!catalog) return;
  const utilities = $("utilities").checked;
  const statusOverview = context?.mode === "continuous" ? continuousOverview : overview;
  const statuses = new Map(
    catalog.modules.map((module) => [
      module.id,
      moduleStatus(statusOverview, module.id, context?.mode, catalog),
    ]),
  );
  const topology = new Set(selectedIncident?.affectedModuleIds ?? []);
  renderTop($("plant-top"), catalog, lines, utilities, selected, select, statuses, topology);
  const list = $("object-list");
  list.replaceChildren();
  for (const module of visibleModules(catalog, lines)) {
    const binding = appearanceBundle?.moduleBindings.get(module.id);
    const issue =
      appearanceMode === "reconstructed"
        ? binding
          ? splatIssue(binding.asset, module)
          : "Reconstructed appearance unavailable."
        : null;
    const appearanceNote = issue
      ? ` · ${issue}${showScreenedOut && binding?.asset.quality.status === "excluded" ? " Review only." : ""}`
      : "";
    const item = node("li"),
      status = statuses.get(module.id) ?? "unknown",
      button = node(
        "button",
        `${module.label} · ${status}${context?.mode === "continuous" ? " · sensor evidence only" : ""}${topology.has(module.id) ? " · topology context (not proven cause)" : ""}${appearanceNote}`,
      );
    button.dataset.status = status.replaceAll(" ", "-");
    if (context?.mode === "continuous")
      button.title =
        "Sensor freshness and quality only; equipment operating status is not reported.";
    button.type = "button";
    button.setAttribute("aria-pressed", String(module.id === selected));
    button.addEventListener("click", () => select(module.id));
    item.append(button);
    list.append(item);
  }
  plant3d?.update(lines, utilities, selected, statuses, topology);
}
async function loadAppearanceBundle() {
  const sourceRoot = "/mining/plant/reconstructed/source/";
  const sources = {
    files: ["files.json", APPEARANCE_RELEASE.sourceHashes.files],
    metadata: ["metadata.json", APPEARANCE_RELEASE.sourceHashes.metadata],
    scene: ["D01.json", APPEARANCE_RELEASE.sourceHashes.scene],
    quality: ["quality.json", APPEARANCE_RELEASE.sourceHashes.quality],
  };
  const documents = {};
  for (const [key, [file, expectedHash]] of Object.entries(sources)) {
    const response = await fetch(`${sourceRoot}${file}`, {
      credentials: "same-origin",
      cache: "force-cache",
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(`Pinned appearance manifest request failed (${response.status}).`);
    const bytes = await readBoundedBytes(response, 1_048_576);
    if ((await sha256Hex(bytes)) !== expectedHash)
      throw new Error(`Pinned appearance manifest integrity check failed: ${file}.`);
    documents[key] = JSON.parse(new TextDecoder().decode(bytes));
  }
  return validateAppearanceBundle(
    catalog,
    documents.metadata,
    documents.scene,
    documents.files,
    documents.quality,
  );
}
function getAppearanceBundle() {
  if (!appearanceBundlePromise) {
    appearanceBundlePromise = loadAppearanceBundle()
      .then((bundle) => {
        appearanceBundle = bundle;
        return bundle;
      })
      .catch((error) => {
        appearanceBundlePromise = null;
        throw error;
      });
  }
  return appearanceBundlePromise;
}
async function applyAppearance() {
  const generation = ++appearanceGeneration;
  appearanceController?.abort();
  appearanceController = null;
  if (!plant3d) return;
  if (appearanceMode === "clean") {
    text("geometry-status", "Loading Clean authored geometry…");
    try {
      await plant3d.setVisualMode("clean");
      if (generation !== appearanceGeneration) return;
      text(
        "geometry-status",
        "Clean · 24 authored module instances in metres. Equipment, selection, filters and operating state are unchanged by appearance.",
      );
      drawPlant();
    } catch (error) {
      if (generation === appearanceGeneration)
        text("geometry-status", `Clean appearance unavailable: ${error.message}`);
    }
    return;
  }
  const controller = new AbortController();
  appearanceController = controller;
  text(
    "geometry-status",
    "Loading pinned reconstructed appearance; operational data is unchanged…",
  );
  try {
    const bundle = appearanceBundle ?? (await getAppearanceBundle());
    if (generation !== appearanceGeneration || controller.signal.aborted) return;
    await plant3d.setVisualMode("reconstructed", bundle, showScreenedOut, controller.signal);
    if (generation !== appearanceGeneration || controller.signal.aborted) return;
    const screenedPlacements = [...bundle.moduleBindings.values()].filter(
      ({ asset }) => asset.quality.status === "excluded",
    ).length;
    text(
      "geometry-status",
      `Reconstructed · verified local PLY bytes for ${plant3d.renderedModuleCount} placements. ${screenedPlacements} screened catalog modules remain selectable; screened assets are ${showScreenedOut ? "shown for review only" : "hidden by default"}.`,
    );
    drawPlant();
  } catch (error) {
    if (generation !== appearanceGeneration || controller.signal.aborted) return;
    text(
      "geometry-status",
      `Reconstructed appearance unavailable: ${error.message} Select Clean to recover; the top view and object list remain available.`,
    );
  }
}
function drawOverview() {
  const continuous = context?.mode === "continuous";
  $("continuous-evidence").hidden = !continuous;
  if (continuous) {
    const data = continuousOverview;
    const runningLines = continuousRunningLines(data);
    const hasLineStateDetail = Array.isArray(data?.detail?.lineStates);
    const good =
      continuousThroughputUsable(data) &&
      demoRun?.runId === data?.runId &&
      demoRun.publisherStatus === "running" &&
      !demoRun.stopRequested;
    text(
      "connection",
      good
        ? "Real validated Fabric throughput read succeeded."
        : "Continuous source has insufficient, stale or unusable critical feed evidence; throughput unavailable.",
    );
    text("quality", `Quality: ${good ? "good" : "unavailable / warming up, stale or stopped"}`);
    text(
      "freshness",
      `Request UTC: ${timestamp(data?.asOf)} · common cutoff: ${timestamp(data?.watermark)}`,
    );
    text(
      "run",
      context.approvedRun
        ? `Continuous ${context.approvedRun.runId} · publisher: ${demoRun?.publisherStatus ?? "unknown"} · ingestion completion: not applicable`
        : "Continuous source waiting for a healthy owner",
    );
    kpis.forEach((key, index) => {
      if (index === 0) {
        text(`kpi-${key}`, good ? `${number(data.throughput.value)} t/h` : "Unavailable");
        text(
          `meta-${key}`,
          `Five-minute mean · coverage ${coverage(data?.throughput?.coverage)} · source lag ${number(data?.watermarkLagSeconds)} seconds`,
        );
      } else if (index === 1) {
        text(`kpi-${key}`, runningLines === null ? "Unavailable" : `${runningLines} / 3 lines`);
        text(
          `meta-${key}`,
          !hasLineStateDetail
            ? "Line-state detail is unavailable from this backend release"
            : runningLines === null
              ? "Requires all three fresh simulator-reported A/B/C states; not a physical snapshot"
              : "Validated simulator-reported A/B/C states; latest events are not a simultaneous physical snapshot",
        );
      } else {
        const now = Date.now();
        const candidates = ["30m", "2h", "24h"].map((window) => ({
          window,
          value: continuousSummaryMetric(data, window, key, now),
        }));
        const displayed = candidates.find((candidate) => candidate.value);
        const unit = units[index];
        text(
          `kpi-${key}`,
          displayed
            ? `${preciseNumber(displayed.value.value)} ${unit} · ${displayed.window}`
            : "Unavailable",
        );
        const windows = data?.continuousSummary?.windows;
        const details = Array.isArray(windows)
          ? ["30m", "2h", "24h"]
              .map((window) => {
                const evidence = windows.find((item) => item.window === window);
                const value = evidence?.[key];
                if (!evidence || !value) return `${window}: unavailable`;
                if (!continuousSummaryFresh(data, now)) {
                  return `${window}: stale or owner unavailable${value.coverage === null ? "" : ` · ${coverage(value.coverage)} common coverage`}`;
                }
                if (value.quality === "good" && Number.isFinite(value.value))
                  return `${window}: ${preciseNumber(value.value)} ${value.unit} · ${coverage(value.coverage)} common coverage`;
                const status =
                  {
                    INSUFFICIENT_COMMON_COVERAGE: "insufficient common coverage",
                    STATE_COVERAGE_INCOMPLETE: "state coverage incomplete",
                    FEED_BELOW_10_TPH: "feed below 10 t/h",
                    SOURCE_REJECTED: "source rejected the window",
                    QUERY_UNAVAILABLE: "summary query unavailable",
                    NO_DATA: "no supported data",
                  }[evidence.status] ?? `${value.quality} source quality`;
                return `${window}: unavailable (${status}${value.coverage === null ? "" : ` · ${coverage(value.coverage)} common coverage`})`;
              })
              .join(" · ")
          : "These rolling summary windows are unavailable from this backend release";
        text(
          `meta-${key}`,
          `${details} · current publisher run only; no cross-run history is stitched`,
        );
      }
    });
    text(
      "continuous-source",
      `Live source: ${context.source?.workspace ?? "unknown"} / ${context.source?.database ?? "unknown"} · generation ${context.approvedRun?.generation ?? "unknown"}`,
    );
    text(
      "continuous-window",
      `Window: ${timestamp(data?.windowStart)} to ${timestamp(data?.windowEnd)} · freshness is measured against request UTC, not the older cutoff.`,
    );
    const evidence = $("throughput-readings");
    evidence.replaceChildren();
    for (const reading of data?.readings ?? []) {
      evidence.append(
        node(
          "li",
          `${reading.tagId}: ${number(reading.value)} ${reading.unit} at ${timestamp(reading.sampleTime)}, received ${timestamp(reading.receivedAt)}; latest ${timestamp(reading.latestSampleTime)}, received ${timestamp(reading.latestReceivedAt)}, age ${number(reading.ageSeconds)}s at request; ${reading.quality}, coverage ${coverage(reading.coverage)}. Event ${reading.eventId ?? "unavailable"}.`,
        ),
      );
    }
    const lineEvidence = $("line-state-readings");
    lineEvidence.replaceChildren();
    for (const state of data?.detail?.lineStates ?? []) {
      const currentAge =
        state.sampleTime === null ? null : (Date.now() - Date.parse(state.sampleTime)) / 1000;
      const quality = state.quality === "good" && currentAge > 195 ? "stale" : state.quality;
      lineEvidence.append(
        node(
          "li",
          `Line ${state.scopeId}: ${state.state ?? "unknown"}; scheduled running ${state.scheduledRunning === null ? "unknown" : state.scheduledRunning ? "yes" : "no"}; measured ${timestamp(state.sampleTime)}, received ${timestamp(state.receivedAt)}; age ${number(state.ageSeconds)}s at request UTC; ${quality}.`,
        ),
      );
    }
    if (!lineEvidence.childNodes.length)
      lineEvidence.append(
        node("li", "Line-state evidence is unavailable from this backend response."),
      );
    drawPlant();
    drawDrawer();
    if (demoRun) drawDemoRunStatus();
    return;
  }
  const valid = overview?.quality === "good";
  text("quality", `Quality: ${valid ? "good" : unknownQuality(overview?.quality)}`);
  text("freshness", `Last refresh: ${timestamp(overview?.refreshedAt)}`);
  const run = overview?.run ?? context?.approvedRun;
  text(
    "run",
    run
      ? `Run ${run.runId} · publisher: ${run.publisherStatus} · ingestion: ${run.ingestionStatus}`
      : "Approved run: unavailable",
  );
  kpis.forEach((key, index) => {
    const kpi = overview?.summary?.[key];
    const ratio = index >= 2;
    const good = valid && usable(kpi) && (!ratio || kpi.coverage >= 0.9);
    text(`kpi-${key}`, good ? `${number(kpi.value)} ${kpi.unit}` : "Unknown");
    text(
      `meta-${key}`,
      `${kpi?.unit ?? units[index]} · ${timestamp(kpi?.windowStart)} to ${timestamp(kpi?.windowEnd)} · coverage ${coverage(kpi?.coverage)}`,
    );
  });
  drawPlant();
  drawDrawer();
  if (demoRun) drawDemoRunStatus();
}
function drawIncidentEvidence() {
  if (!selectedIncident) {
    text("incident-evidence", "");
    return;
  }
  const hold =
    selectedIncident.holdWindowStart === null
      ? "no current qualifying hold"
      : `${timestamp(selectedIncident.holdWindowStart)} to ${timestamp(selectedIncident.holdWindowEnd)}`;
  const evidence = selectedIncident.evidence.length
    ? selectedIncident.evidence
        .map(
          (reading) =>
            `${reading.tagId}: ${usable(reading) ? number(reading.value) : "Unknown"} ${reading.unit}, ${reading.quality}, ${timestamp(reading.sampleTime)}`,
        )
        .join("; ")
    : "No numeric readings are present in this incident DTO.";
  const moduleContext = selectedIncident.affectedModuleIds.length
    ? ` · Module context: ${selectedIncident.affectedModuleIds.join(", ")} (not proven causation).`
    : "";
  text(
    "incident-evidence",
    `${selectedIncident.title} · rule ${selectedIncident.ruleId} · scope ${selectedIncident.scopeId} · ${selectedIncident.verification} · ${incidentAssessmentLabel(incidentAssessment)} · raised ${timestamp(selectedIncident.raisedAt)} · acknowledged ${selectedIncident.acknowledgedAt ? timestamp(selectedIncident.acknowledgedAt) : "not acknowledged"} (separate from assessment time). Current hold: ${hold}; evidence window: ${timestamp(selectedIncident.evidenceWindowStart)} to ${timestamp(selectedIncident.evidenceWindowEnd)}. ${evidence}${moduleContext}`,
  );
}
function drawDrawer() {
  if (!catalog) return;
  if (!selected) {
    text("asset-heading", selectedIncident?.title ?? "No module selected");
    text("asset-id", selectedIncident ? `Scope ${selectedIncident.scopeId}` : "No module selected");
    text(
      "asset-status",
      selectedIncident
        ? `Status: ${selectedIncident.verification} · no single module association`
        : "Status: unknown",
    );
    text(
      "diagnostic-scope",
      selectedIncident
        ? "No module-level trend is associated with this assessment."
        : "Select a module for its diagnostic trend.",
    );
    $("readings").replaceChildren(
      node(
        "p",
        selectedIncident
          ? "No single equipment module is identified for this assessment."
          : "Select an equipment module to inspect its readings.",
      ),
    );
    for (const direction of ["upstream", "downstream"])
      $(direction).replaceChildren(node("p", "No single module is associated."));
    if (selectedIncident) chart($("diagnostic-chart"), null);
    drawIncidentEvidence();
    return;
  }
  const module = catalog.modules.find((item) => item.id === selected);
  text("asset-heading", module.label);
  text("asset-id", selected);
  const continuous = context?.mode === "continuous";
  text(
    "asset-status",
    continuous
      ? `Status: ${moduleStatus(continuousOverview, selected, "continuous", catalog)}; sensor freshness/quality only, not equipment operating status`
      : `Status: ${moduleStatus(overview, selected)}`,
  );
  text(
    "diagnostic-scope",
    continuous
      ? context.capabilities?.trends === true
        ? "Cross-run sensor trends are shown by metric; module operating state is not directly reported."
        : "Continuous trend reads are unavailable; module operating state is not directly reported."
      : selectedIncident?.metric === null
        ? "No supported trend metric is associated with this incident; choose a diagnostic to inspect a separate series."
        : `Selected module: ${selected} · 30-minute default trend`,
  );
  const readings = $("readings");
  readings.replaceChildren();
  const tags = relevantTags(catalog, selected);
  if (continuous && !continuousOverview?.detail)
    readings.append(
      node(
        "p",
        "Direct tag and line-state details are unavailable from this backend release; module operating status is not directly reported.",
      ),
    );
  if (!tags.length)
    readings.append(
      node("p", "No numeric sensor is authored for this equipment. No value is inferred."),
    );
  for (const tag of tags) {
    const reading = continuous
      ? continuousTagReading(continuousOverview, tag.id)
      : overview?.latest?.readings?.find(
          (item) =>
            item.tagId === tag.id &&
            item.moduleId === selected &&
            item.equipmentId === tag.equipment_id &&
            item.unit === tag.unit,
        );
    const good = continuous
      ? reading?.quality === "good" && usable(reading)
      : overview?.quality === "good" &&
        usable(reading) &&
        reading.sampleTime &&
        Number.isFinite(Date.parse(reading.sampleTime));
    const article = node("article");
    article.append(node("h3", tag.metric.replaceAll("_", " ")));
    const details = node("dl");
    for (const [label, value] of [
      ["Reading", good ? `${number(reading.value)} ${tag.unit}` : `Unknown ${tag.unit}`],
      [
        "Quality",
        continuous
          ? (reading?.quality ?? "missing")
          : good
            ? "good"
            : unknownQuality(reading?.quality),
      ],
      [continuous ? "Measured (UTC)" : "Sample (UTC)", timestamp(reading?.sampleTime)],
      [
        continuous ? "Received (UTC)" : "Ingested (UTC)",
        timestamp(continuous ? reading?.receivedAt : reading?.ingestionTime),
      ],
      ...(continuous ? [["Age at request UTC", `${number(reading?.ageSeconds)}s`]] : []),
      [
        "Normal demo band",
        Array.isArray(reading?.normalBand) && reading.normalBand.length === 2
          ? `${reading.normalBand.map(number).join(" – ")} ${tag.unit}`
          : "unknown (not an operating limit)",
      ],
      ["Equipment ID", tag.equipment_id],
      ["Tag ID", tag.id],
    ])
      details.append(node("dt", label), node("dd", value));
    article.append(details);
    readings.append(article);
  }
  for (const direction of ["upstream", "downstream"]) {
    const container = $(direction);
    container.replaceChildren();
    for (const id of connections(catalog, selected, direction)) {
      const button = node("button", id);
      button.type = "button";
      button.addEventListener("click", () => select(id));
      container.append(button);
    }
    if (!container.childNodes.length) container.append(node("p", "No authored connection."));
  }
  if (selectedIncident?.metric === null) chart($("diagnostic-chart"), null);
  drawIncidentEvidence();
}
function select(id, incident = null) {
  if (!catalog.modules.some((module) => module.id === id)) return;
  selected = id;
  selectedIncident = incident;
  const module = catalog.modules.find((item) => item.id === id);
  lines.add(module.line);
  document.querySelectorAll('input[name="line"]').forEach((input) => {
    input.checked = lines.has(input.value);
  });
  if (incident?.metric)
    $("diagnostic").value = incident.metric === "feed" ? "vibration" : incident.metric;
  else if (!incident)
    $("diagnostic").value =
      module.kind === "dms" ? "density" : module.kind === "water" ? "water-energy" : "vibration";
  drawPlant();
  drawDrawer();
  if (
    context?.readAvailable &&
    context?.approvedRun &&
    !document.hidden &&
    (!incident || incident.metric !== null)
  )
    refresh("diagnostic");
}
function selectIncident(incident) {
  if (incident.moduleId) {
    select(incident.moduleId, incident);
    return;
  }
  selected = null;
  selectedIncident = incident;
  drawPlant();
  drawDrawer();
}
function drawIncidents(emptyMessage = "Unknown - incident assessment unavailable.") {
  const container = $("incidents");
  container.replaceChildren();
  text(
    "incident-status",
    incidentAsOf
      ? `${incidents.length ? "Top three active incidents" : "No active incidents"} · ${incidentAssessmentLabel(incidentAssessment)}`
      : emptyMessage,
  );
  for (const incident of incidents.slice(0, 3)) {
    const item = node("li");
    const duration = Math.max(
      0,
      Math.floor(
        (Date.parse(mode === "replay" ? replayTime : new Date().toISOString()) -
          Date.parse(incident.raisedAt)) /
          60_000,
      ),
    );
    const button = node(
      "button",
      `${incident.severity.toUpperCase()} · ${incident.title} · ${incident.moduleId ?? incident.scopeId} · ${duration} min · ${incident.verification}${incident.acknowledgedAt ? " · acknowledged (not cleared)" : ""}`,
    );
    button.addEventListener("click", () => selectIncident(incident));
    item.append(button);
    container.append(item);
  }
}
function chart(container, data) {
  container.replaceChildren();
  if (!data || !Array.isArray(data.rows) || data.rows.length > 1000 || !data.rows.length) {
    container.append(node("p", "Unknown — no covered trend is available."));
    return;
  }
  if (
    ![1, 5].includes(data.binMinutes) ||
    data.rows.some(
      (row) =>
        !catalog.telemetry_tags.some((tag) => tag.id === row.seriesId && tag.unit === row.unit),
    )
  ) {
    container.append(
      node("p", "Unknown — trend does not match canonical tags, units or bin limits."),
    );
    return;
  }
  const rows = data.rows.filter(
    (row) => row && typeof row.seriesId === "string" && Number.isFinite(Date.parse(row.timestamp)),
  );
  if (!rows.length) {
    container.append(node("p", "Unknown — invalid trend timestamps."));
    return;
  }
  const groups = [...new Set(rows.map((row) => `${row.seriesId} (${row.unit})`))];
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 600 220");
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    "Time series; exact timestamps, values, units and coverage in the data table below.",
  );
  const start = Date.parse(data.windowStart),
    end = Date.parse(data.windowEnd);
  if (!(end > start) || end - start > 86_400_000) {
    container.append(node("p", "Unknown — invalid trend window."));
    return;
  }
  const colors = ["#4338ca", "#0f766e", "#b45309"];
  const drawable = (row) =>
    usable(row) &&
    (!data.crossRun ||
      (row.status === "OBSERVED" &&
        typeof row.runId === "string" &&
        typeof row.segmentId === "string"));
  const unitRanges = new Map();
  for (const row of rows.filter(drawable)) {
    const range = unitRanges.get(row.unit) ?? [row.value, row.value];
    unitRanges.set(row.unit, [Math.min(range[0], row.value), Math.max(range[1], row.value)]);
  }
  groups.forEach((group, index) => {
    const items = rows
      .filter((row) => `${row.seriesId} (${row.unit})` === group)
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const values = items.filter(drawable).map((row) => row.value);
    if (!values.length) return;
    const [low, high] = unitRanges.get(items[0].unit);
    const span = high - low || 1;
    let points = [];
    const flush = () => {
      if (points.length) {
        if (data.crossRun && points.length === 1) {
          const dot = document.createElementNS(svg.namespaceURI, "circle");
          const [x, y] = points[0].split(",");
          dot.setAttribute("cx", x);
          dot.setAttribute("cy", y);
          dot.setAttribute("r", "3");
          dot.setAttribute("fill", colors[index % colors.length]);
          svg.append(dot);
        } else {
          const line = document.createElementNS(svg.namespaceURI, "polyline");
          line.setAttribute("points", points.join(" "));
          line.setAttribute("stroke", colors[index % colors.length]);
          line.setAttribute("stroke-dasharray", index === 1 ? "6 3" : index === 2 ? "2 3" : "none");
          svg.append(line);
        }
        points = [];
      }
    };
    let previous = null;
    for (const row of items) {
      if (
        !drawable(row) ||
        (previous !== null &&
          (data.crossRun
            ? row.runId !== previous.runId ||
              row.segmentId !== previous.segmentId ||
              Date.parse(row.timestamp) - Date.parse(previous.timestamp) !==
                data.binMinutes * 60_000
            : Date.parse(row.timestamp) - Date.parse(previous.timestamp) >
              data.binMinutes * 60_000 * 1.5))
      )
        flush();
      if (drawable(row))
        points.push(
          `${40 + (Math.max(0, Date.parse(row.timestamp) - start) / (end - start)) * 540},${165 - ((row.value - low) / span) * 120}`,
        );
      previous = row;
    }
    flush();
    const label = node(
      "p",
      `${group}: ${number(Math.min(...values))} – ${number(Math.max(...values))} · ${index === 0 ? "solid" : index === 1 ? "dashed" : "dotted"} line${groups.some((other) => !other.endsWith(`(${items[0].unit})`)) ? " · independent unit scale" : ""}`,
    );
    container.append(label);
  });
  container.prepend(svg);
  if (data.crossRun && !rows.some(drawable))
    container.append(node("p", "Unknown — no fully observed trend averages are available."));
  container.append(
    node(
      "p",
      `${timestamp(data.windowStart)} to ${timestamp(data.windowEnd)} · ${data.binMinutes}-minute bins${data.crossRun ? " · observed bin averages; runs remain separate" : ""}. Gaps and non-good-quality samples are not connected.${data.crossRun ? " Within the selected window, missing rows mean no bin was returned, not zero or an unrequested interval." : ""}`,
    ),
  );
  const details = node("details"),
    summary = node("summary", "Read chart data"),
    wrap = node("div"),
    table = node("table");
  wrap.className = "mining-chart-table";
  const head = node("tr");
  (data.crossRun
    ? [
        "Bin start (UTC)",
        "Series",
        "Bin average / unit",
        "Status / coverage",
        "Run ID",
        "First / last sample (UTC)",
      ]
    : ["Time (UTC)", "Series", "Value / unit", "Quality / coverage"]
  ).forEach((label) => head.append(node("th", label)));
  const thead = node("thead");
  thead.append(head);
  table.append(thead);
  const tbody = node("tbody");
  for (const row of rows) {
    const tr = node("tr");
    [
      timestamp(row.timestamp),
      row.seriesId,
      `${drawable(row) ? number(row.value) : "Unknown"} ${row.unit}`,
      `${data.crossRun ? `${row.status} · ` : ""}${row.quality} / ${coverage(row.coverage)}`,
      ...(data.crossRun
        ? [row.runId, `${timestamp(row.firstSampleTime)} / ${timestamp(row.lastSampleTime)}`]
        : []),
    ].forEach((value) => tr.append(node("td", value)));
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);
  details.append(summary, wrap);
  container.append(details);
}
function clearReadState(message) {
  overview = null;
  continuousOverview = null;
  incidents = [];
  incidentAsOf = null;
  incidentAssessment = null;
  selectedIncident = null;
  drawOverview();
  text("connection", message);
  text("incident-status", "Unknown — incident source unavailable.");
  $("incidents").replaceChildren();
  chart($("feed-chart"), null);
  chart($("diagnostic-chart"), null);
}
async function refresh(scope = "all") {
  if (context?.mode === "continuous") {
    if (document.hidden || !context.readAvailable || !context.approvedRun) return;
    const runId = context.approvedRun.runId;
    const generation = context.approvedRun.generation;
    const epoch = requestEpoch;
    const current = () =>
      epoch === requestEpoch &&
      !document.hidden &&
      context?.approvedRun?.runId === runId &&
      context?.approvedRun?.generation === generation;
    try {
      const data = await reads.read("overview", { plantId: "D01", runId });
      if (!current()) return;
      if (
        !validContinuousOverview(
          data,
          runId,
          catalogVersion,
          context.approvedRun.generation,
          Date.now(),
          catalog,
        )
      ) {
        throw new Error("Invalid or foreign continuous evidence; values are unavailable.");
      }
      continuousOverview = data;
      overview = null;
      drawOverview();
      text("incident-status", "Unavailable: live incident processing is not supported.");
      $("incidents").replaceChildren();
    } catch (error) {
      if (current()) clearReadState(error.message);
      return;
    }
    if (!current()) return;
    if (context.capabilities?.trends !== true) {
      chart($("feed-chart"), null);
      chart($("diagnostic-chart"), null);
      text("diagnostic-scope", "Continuous trend reads are unavailable.");
      return;
    }
    const params = query();
    const loadTrend = async (target, metric) => {
      try {
        const request = {
          plantId: "D01",
          start: params.start,
          end: params.end,
          metric,
          binMinutes: params.binMinutes,
        };
        const data = await reads.read("cross-run-trends", request);
        if (!current() || (target === "diagnostic-chart" && $("diagnostic").value !== metric))
          return;
        const chartData = crossRunChartData(data, request, catalogVersion, catalog, {
          runId,
          generation,
        });
        if (!chartData) throw new Error("Cross-run trend evidence is invalid or unavailable.");
        chart($(target), chartData);
        if (target === "diagnostic-chart")
          text(
            "diagnostic-scope",
            "Observed cross-run sensor averages; module state is not inferred.",
          );
      } catch (error) {
        if (current() && (target !== "diagnostic-chart" || $("diagnostic").value === metric)) {
          chart($(target), null);
          $(target).append(node("p", error.message));
        }
      }
    };
    const tasks = [];
    if (scope === "all" || scope === "detail") tasks.push(loadTrend("feed-chart", "feed"));
    if (scope === "all" || scope === "detail" || scope === "diagnostic")
      tasks.push(loadTrend("diagnostic-chart", $("diagnostic").value));
    await Promise.all(tasks);
    return;
  }
  if (mode === "replay") {
    incidents = [];
    incidentAsOf = null;
    incidentAssessment = null;
    selectedIncident = null;
    drawIncidents(
      "Incident assessments are current-only; historical assessments are unavailable in replay.",
    );
    drawDrawer();
  }
  if (document.hidden || !context?.readAvailable || !context?.approvedRun) return;
  const epoch = requestEpoch;
  let params;
  try {
    params = query();
  } catch (error) {
    clearReadState(error.message);
    return;
  }
  const current = () =>
    epoch === requestEpoch && !document.hidden && context?.approvedRun?.runId === params.runId;
  const tasks = [];
  if (scope === "all" || scope === "overview")
    tasks.push(
      (async () => {
        try {
          const data = await reads.read("overview", {
            plantId: params.plantId,
            runId: params.runId,
            asOf: mode === "replay" ? params.asOf : undefined,
          });
          if (!current()) return;
          if (!validOverview(data, params.runId, catalogVersion, params.asOf, mode === "replay"))
            throw new Error("Invalid, foreign-run or stale mining overview; values are unknown.");
          if (
            new Set(data.latest.modules.map((item) => item.moduleId)).size !== 24 ||
            data.latest.modules.some(
              (item) => !catalog.modules.some((module) => module.id === item.moduleId),
            ) ||
            new Set(data.latest.readings.map((item) => item.tagId)).size !== 56 ||
            data.latest.readings.some(
              (item) =>
                !catalog.telemetry_tags.some(
                  (tag) =>
                    tag.id === item.tagId &&
                    tag.module_id === item.moduleId &&
                    tag.equipment_id === item.equipmentId &&
                    tag.unit === item.unit,
                ),
            )
          )
            throw new Error("Mining overview does not match the canonical catalog.");
          data.latest.readings = data.latest.readings.map((reading) =>
            normalizeReading(reading, data.asOf),
          );
          overview = data;
          text(
            "connection",
            mode === "replay"
              ? `REPLAY · evaluated at ${params.asOf} · publisher provenance is not verified.`
              : "Fabric read succeeded · pinned catalog is the approved expected scope; publisher provenance is not verified.",
          );
          drawOverview();
        } catch (error) {
          if (current()) {
            overview = null;
            drawOverview();
            text("connection", error.message);
          }
        }
      })(),
    );
  const incidentQuery = currentIncidentQuery(mode, params);
  if ((scope === "all" || scope === "detail") && incidentQuery)
    tasks.push(
      (async () => {
        try {
          const data = await reads.read("incidents", incidentQuery);
          if (!current()) return;
          if (
            !sameScope(data, params.runId, catalogVersion) ||
            !validIncidentAssessment(data) ||
            !Array.isArray(data.incidents) ||
            data.incidents.length > 20 ||
            data.incidents.some(
              (item) =>
                !Array.isArray(item.evidence) ||
                !validIncidentAssociation(item, catalog) ||
                !["warning", "high"].includes(item.severity) ||
                !["verified", "unverified"].includes(item.verification) ||
                typeof item.ruleId !== "string" ||
                typeof item.scopeId !== "string" ||
                typeof item.title !== "string" ||
                item.title.trim().length === 0 ||
                !Number.isFinite(Date.parse(item.raisedAt)) ||
                (item.clearedAt !== null && !Number.isFinite(Date.parse(item.clearedAt))) ||
                (item.acknowledgedAt !== null &&
                  !Number.isFinite(Date.parse(item.acknowledgedAt))) ||
                !validIncidentWindows(item) ||
                item.evidence.some(
                  (reading) =>
                    !catalog.telemetry_tags.some(
                      (tag) =>
                        tag.id === reading.tagId &&
                        tag.unit === reading.unit &&
                        tag.module_id === reading.moduleId &&
                        tag.equipment_id === reading.equipmentId,
                    ),
                ),
            )
          )
            throw new Error("Invalid or foreign-run incident response.");
          incidents = data.incidents.filter((item) => !item.clearedAt);
          incidentAsOf = data.asOf;
          incidentAssessment = data;
          selectedIncident = refreshedIncidentSelection(selectedIncident, incidents);
          drawIncidents();
          drawDrawer();
        } catch (error) {
          if (current()) {
            incidents = [];
            incidentAsOf = null;
            incidentAssessment = null;
            selectedIncident = null;
            drawIncidents(error.message);
            drawDrawer();
          }
        }
      })(),
    );
  if (scope === "all" || scope === "detail")
    tasks.push(
      (async () => {
        try {
          const data = await reads.read("compare-lines", seriesQuery(params, "feed"));
          if (!validSeries(data, { ...params, metric: "feed" }, catalogVersion, catalog))
            throw new Error(
              "Trend response does not match the requested run, time, metric or catalog.",
            );
          if (current()) chart($("feed-chart"), data);
        } catch (error) {
          if (current()) {
            chart($("feed-chart"), null);
            $("feed-chart").append(node("p", error.message));
          }
        }
      })(),
    );
  if (selected && (scope === "all" || scope === "detail" || scope === "diagnostic")) {
    const moduleId = selected,
      metric = $("diagnostic").value;
    tasks.push(
      (async () => {
        try {
          const data = await reads.read("trends", seriesQuery(params, metric, moduleId));
          if (!validSeries(data, { ...params, moduleId, metric }, catalogVersion, catalog))
            throw new Error(
              "Trend response does not match the requested module, time, metric or catalog.",
            );
          if (current() && selected === moduleId && $("diagnostic").value === metric)
            chart($("diagnostic-chart"), data);
        } catch (error) {
          if (current() && selected === moduleId && $("diagnostic").value === metric) {
            chart($("diagnostic-chart"), null);
            $("diagnostic-chart").append(node("p", error.message));
          }
        }
      })(),
    );
  }
  await Promise.all(tasks);
}
async function loadContext() {
  const epoch = requestEpoch;
  try {
    const data = await reads.read("context");
    if (epoch !== requestEpoch || document.hidden) return;
    context = data;
    if (
      context.plantId !== "D01" ||
      !context.assistant ||
      typeof context.readAvailable !== "boolean"
    )
      throw new Error("Invalid mining context.");
    if (context.catalogVersion !== catalogVersion)
      throw new Error("Backend and geometry catalog versions differ; mining reads are gated.");
    $("window").disabled = context.mode === "continuous" && context.capabilities?.trends !== true;
    if (
      context.approvedRun &&
      !sameScope(context.approvedRun, context.approvedRun.runId, catalogVersion)
    )
      throw new Error("Approved run does not match the selected plant/catalog.");
    const url = authorizedFabricUrl(context.assistant.fabricUrl);
    text(
      "assistant-state",
      context.assistant.available && context.assistant.kind === "bounded-fabric-evidence"
        ? "Read-only Foundry answers use bounded, server-read Fabric evidence from the current public run. Questions are not saved as a conversation."
        : "The Mining evidence assistant is unavailable. No question is sent while disabled.",
    );
    if (context.assistant.available && url) {
      $("fabric-agent").href = url;
      $("fabric-agent").hidden = false;
      text(
        "assistant-state",
        "Open the approved grounded data agent under your own Fabric permissions. Sharing this link does not grant data access.",
      );
    }
    if (context.queries) {
      $("queries").replaceChildren();
      for (const [name, query] of Object.entries(context.queries)) {
        if (
          ![
            "PlantLatest",
            "PlantSummary",
            "AssetTrend",
            "ActiveIncidents",
            "CompareLines",
          ].includes(name) ||
          typeof query.text !== "string"
        )
          continue;
        const details = node("details");
        details.append(node("summary", name), node("pre", query.text));
        const link = authorizedFabricUrl(query.fabricUrl);
        if (link) {
          const anchor = node("a", "Open query in Fabric");
          anchor.href = link;
          anchor.target = "_blank";
          anchor.rel = "noopener noreferrer";
          details.append(anchor);
        }
        $("queries").append(details);
      }
    }
    if (!context.readAvailable || !context.approvedRun)
      clearReadState(
        context.unavailableReason ??
          "No approved mining run is available. The catalog is viewable; telemetry, incidents and KPIs are unknown.",
      );
    else await refresh();
  } catch (error) {
    if (epoch === requestEpoch) {
      context = null;
      clearReadState(
        `${error.message} Configure the mining backend and approved run; no live twin is claimed.`,
      );
    }
  }
  configurePolling();
}
function invalidate() {
  requestEpoch++;
  answerController?.abort();
  answerController = null;
  text("mining-answer", "");
  text("mining-answer-status", "");
  text("mining-answer-source", "");
  $("mining-answer-evidence").hidden = true;
  reads.abort();
  polling.stop();
}
$("mining-ask").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (
    mode !== "live" ||
    !context?.assistant?.available ||
    !context?.approvedRun ||
    answerController
  )
    return;
  const question = $("mining-question").value.trim();
  if (!question || question.length > 1000) return;
  const epoch = requestEpoch;
  const runId = context.approvedRun.runId;
  const controller = new AbortController();
  answerController = controller;
  const timer = setTimeout(() => controller.abort(), 10_000);
  text("mining-answer", "");
  text("mining-answer-status", "Reading Fabric evidence and generating an interpretation...");
  $("mining-answer-evidence").hidden = true;
  configurePolling();
  try {
    const response = await fetch("/api/mining/demo/assistant", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plantId: "D01", question }),
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(
        response.status === 429
          ? "The shared assistant is busy. Wait a minute and try again."
          : `The evidence assistant is unavailable (HTTP ${response.status}). Refresh the run and try again.`,
      );
    const data = await response.json();
    if (
      epoch !== requestEpoch ||
      runId !== context?.approvedRun?.runId ||
      controller.signal.aborted
    )
      return;
    if (
      !sameScope(data, runId, catalogVersion) ||
      !sameScope(data.evidence, runId, catalogVersion) ||
      data.kind !== "bounded-fabric-evidence" ||
      data.nativeDataAgentInvoked !== false ||
      typeof data.answer !== "string" ||
      !data.answer.trim() ||
      data.answer.length > 12_000 ||
      !validAsOf(data.evidence.asOf, new Date().toISOString(), false)
    )
      throw new Error("The answer did not match the current run. Refresh and ask again.");
    text("mining-answer", data.answer);
    text(
      "mining-answer-status",
      `Generated interpretation for run ${runId}. Evidence cutoff ${timestamp(data.evidence.asOf)}; evidence quality ${data.evidence.quality}. Not a native Data Agent answer.`,
    );
    text("mining-answer-source", JSON.stringify(data.evidence, null, 2));
    $("mining-answer-evidence").hidden = false;
  } catch (error) {
    if (epoch === requestEpoch)
      text(
        "mining-answer-status",
        controller.signal.aborted
          ? "The answer timed out. No answer is retained; try again."
          : error.message,
      );
  } finally {
    clearTimeout(timer);
    if (answerController === controller) {
      answerController = null;
      configurePolling();
    }
  }
});
let demoRun = null;
let demoBusy = false;
let demoStatusEpoch = 0;
function drawDemoRunStatus(notice = "") {
  if (context?.mode === "continuous") {
    text(
      "run-control-help",
      "Continuous publishing has no fixed five-minute run duration; it is operator-managed and public start/stop is disabled. Reopening this view never starts a publisher.",
    );
    text(
      "run-control-status",
      `${notice}Continuous publishing is operator-managed; public start/stop is disabled. Publisher: ${demoRun?.publisherStatus ?? "unavailable"}${demoRun?.stopRequested ? " · generation held" : ""}.`,
    );
    return;
  }
  text(
    "run-control-help",
    "Finite public D01 demo runs last up to five minutes. A shared cooldown limits repeated starts. Reopening this view never starts a run. Publisher completion is not Fabric ingestion completion; stop requested is not stopped.",
  );
  const status = demoRun
    ? `Run ${demoRun.runId}: ${demoRun.publisherStatus}${demoRun.stopRequested ? " · stop requested" : ""} · Fabric ingestion ${verifiedRunIngestion(overview, demoRun)}.`
    : "No active public demo run.";
  text("run-control-status", `${notice}${status}`);
}
async function demoRequest(path, body) {
  const response = await fetch(`/api/mining/demo/runs/${path}`, {
    ...(body
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message ?? "Demo request failed.");
  return data;
}
async function updateDemoStatus(notice = "") {
  if (demoBusy || document.hidden) return;
  const epoch = ++demoStatusEpoch;
  try {
    const data = await demoRequest("status");
    if (epoch !== demoStatusEpoch || demoBusy) return;
    if (data.plantId !== "D01" || (data.run && !/^[0-9a-f-]{36}$/.test(data.run.runId)))
      throw new Error("Invalid demo status.");
    demoRun = data.run;
    const managed = data.mode === "continuous";
    const active = demoRun && ["running", "stopping"].includes(demoRun.publisherStatus);
    $("run-start").disabled = managed || !!active;
    $("run-cancel").disabled = managed || !active || demoRun.stopRequested;
    $("mode").disabled = managed;
    $("window").disabled = managed && context?.capabilities?.trends !== true;
    if (managed) {
      mode = "live";
      $("mode").value = "live";
      $("replay-label").hidden = true;
      if (context?.mode === "continuous") {
        if (
          !demoRun ||
          demoRun.publisherStatus !== "running" ||
          demoRun.stopRequested ||
          continuousOverview?.runId !== demoRun.runId ||
          context.approvedRun?.generation !== demoRun.generation
        ) {
          invalidate();
          reads.reset();
          clearReadState("Continuous owner is unavailable; previous trends withdrawn.");
        }
        drawOverview();
      }
    }
    drawDemoRunStatus(notice);
    if (
      catalog &&
      ((context?.approvedRun?.runId ?? null) !== (demoRun?.runId ?? null) ||
        (managed && (context?.approvedRun?.generation ?? null) !== (demoRun?.generation ?? null)))
    ) {
      invalidate();
      reads.reset();
      await loadContext();
    }
  } catch (error) {
    if (epoch !== demoStatusEpoch || demoBusy) return;
    demoRun = null;
    $("run-start").disabled = true;
    $("run-cancel").disabled = true;
    text("run-control-status", error.message);
    if (context?.mode === "continuous") {
      invalidate();
      reads.reset();
      clearReadState("Continuous run status unavailable; previous values withdrawn.");
    }
  }
}
async function demoAction(action) {
  demoBusy = true;
  demoStatusEpoch++;
  $("run-start").disabled = true;
  $("run-cancel").disabled = true;
  let notice = "";
  try {
    const body =
      action === "cancel" ? { plantId: "D01", runId: demoRun.runId } : { plantId: "D01" };
    const result = await demoRequest(action, body);
    text(
      "run-control-status",
      `${action === "start" ? "Started" : "Stop requested"}: ${result.runId}. Fabric ingestion is not yet confirmed.`,
    );
  } catch (error) {
    notice = `${error.message} Check the run status before retrying. `;
  } finally {
    demoBusy = false;
    await updateDemoStatus(notice);
  }
}
$("run-start").addEventListener("click", () => void demoAction("start"));
$("run-cancel").addEventListener("click", () => void demoAction("cancel"));
void updateDemoStatus();
const demoStatusTimer = setInterval(() => void updateDemoStatus(), 15_000);
$("refresh").addEventListener("click", async () => {
  invalidate();
  await loadContext();
});
$("mode").addEventListener("change", async () => {
  invalidate();
  mode = $("mode").value;
  $("replay-label").hidden = mode !== "replay";
  text("mode-label", mode.toUpperCase());
  if (mode === "replay") {
    $("replay-time").value ||= new Date().toISOString().slice(0, 16);
    replayTime = new Date(`${$("replay-time").value}Z`).toISOString();
  }
  clearReadState("Loading selected time mode…");
  await refresh();
  configurePolling();
});
$("replay-time").addEventListener("change", async () => {
  invalidate();
  const value = Date.parse(`${$("replay-time").value}Z`);
  replayTime = Number.isFinite(value) ? new Date(value).toISOString() : null;
  clearReadState("Loading replay time…");
  await refresh();
  configurePolling();
});
$("window").addEventListener("change", () => {
  invalidate();
  if (context?.mode === "continuous") {
    $("feed-chart").replaceChildren(node("p", "Loading cross-run trend…"));
    $("diagnostic-chart").replaceChildren(node("p", "Loading cross-run trend…"));
  }
  refresh("detail");
  configurePolling();
});
$("diagnostic").addEventListener("change", () => {
  chart($("diagnostic-chart"), null);
  refresh("diagnostic");
});
$("view").addEventListener("change", () => {
  $("plant-top").toggleAttribute("hidden", $("view").value !== "top");
  $("plant-3d").hidden = $("view").value !== "3d";
  configurePolling();
});
$("appearance-mode").addEventListener("change", () => {
  appearanceMode = $("appearance-mode").value;
  $("include-screened").disabled = appearanceMode !== "reconstructed";
  void applyAppearance();
});
$("include-screened").addEventListener("change", () => {
  showScreenedOut = $("include-screened").checked;
  void applyAppearance();
});
document.querySelectorAll('input[name="line"]').forEach((input) =>
  input.addEventListener("change", () => {
    if (input.checked) lines.add(input.value);
    else lines.delete(input.value);
    drawPlant();
  }),
);
$("utilities").addEventListener("change", drawPlant);
document.addEventListener("visibilitychange", () => {
  invalidate();
  configurePolling();
  if (!document.hidden) {
    clearReadState("Refreshing after hidden-tab pause…");
    if (context) refresh();
    else loadContext();
  }
});
addEventListener("pagehide", () => {
  invalidate();
  clearInterval(demoStatusTimer);
  appearanceGeneration++;
  appearanceController?.abort();
  plant3d?.dispose();
});

chart($("feed-chart"), null);
chart($("diagnostic-chart"), null);
try {
  const response = await fetch("/mining/catalog.json");
  if (!response.ok) throw new Error("Pinned canonical plant catalog is unavailable.");
  catalog = await response.json();
  const receiptResponse = await fetch("/mining/catalog-receipt.json");
  if (!receiptResponse.ok) throw new Error("Canonical asset receipt is unavailable.");
  const receipt = await receiptResponse.json();
  catalogVersion = `sha256:${receipt.catalog.sha256}`;
  text("catalog-scope", `APPROVED EXPECTED catalog scope: ${catalogVersion}`);
  if (
    catalog.modules?.length !== 24 ||
    !Array.isArray(catalog.streams) ||
    !Array.isArray(catalog.telemetry_tags)
  )
    throw new Error("Invalid canonical plant package.");
  drawPlant();
  selected = catalog.modules.find((module) => module.kind === "dms")?.id;
  drawDrawer();
  await loadContext();
  try {
    plant3d = await createPlant3D($("plant-3d"), catalog, select);
    $("appearance-mode").disabled = false;
    text(
      "geometry-status",
      "24 authored module instances · metres · right-handed Y-up. Status labels are available in the object list.",
    );
    drawPlant();
    configurePolling();
  } catch (error) {
    $("view").value = "top";
    $("plant-3d").hidden = true;
    $("plant-top").removeAttribute("hidden");
    $("appearance-mode").disabled = true;
    $("include-screened").disabled = true;
    text(
      "geometry-status",
      `3D unavailable: ${error.message} Top view and object list remain available.`,
    );
  }
} catch (error) {
  text("geometry-status", error.message);
  clearReadState("Mining catalog prerequisite unavailable. No telemetry or equipment is invented.");
}
