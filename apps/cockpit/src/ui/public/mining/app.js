import { collectPreview, collectReceipt, drawStreamCharts, streamWindow } from "./stream.js";
import {
  buildupObservation,
  connectionReadingState,
  diagnosticAssets,
  investigationPrompt,
  latestFeedTotal,
  plantEvidence,
  possibleBuildup,
  usableConnectionReading,
} from "./supervisor.js";
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
  validConnectionFlow,
  validConnectionTrend,
  moduleStatus,
  lineOperatingState,
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
let connectionFlow = null;
let flowTrendGeneration = 0;
let flowExpiryTimer;
let incidents = [];
let incidentAsOf = null;
let incidentAssessment = null;
let continuousAdvisoryData = null;
const mode = "live";
const replayTime = null;
let appearanceMode = "clean";
let showScreenedOut = false;
let appearanceBundle = null;
let appearanceBundlePromise = null;
let appearanceController = null;
let appearanceGeneration = 0;
let answerController = null;
let contextualGeneration = 0;
const lines = new Set(["A", "B", "C", "shared"]);
const polling = new MiningPolling((scope) => refreshAll(scope));
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
    connected:
      !!context?.readAvailable &&
      (!!context?.approvedRun || context?.capabilities?.unpinnedFlow === true),
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
  $("asset-ask").disabled = !canAsk || !(selected || selectedIncident);
}
function query() {
  const finishedAt =
    mode === "live" &&
    context?.mode !== "continuous" &&
    demoRun?.runId === context?.approvedRun?.runId &&
    demoRun?.publisherStatus === "publisher_complete"
      ? Date.parse(demoRun.stopAt)
      : NaN;
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
  const trendEnd =
    Number.isFinite(finishedAt) && finishedAt < Date.parse(asOf)
      ? new Date(finishedAt).toISOString()
      : asOf;
  return {
    plantId: "D01",
    runId: context.approvedRun.runId,
    asOf,
    start: new Date(Date.parse(trendEnd) - minutes * 60_000).toISOString(),
    end: trendEnd,
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
      context?.mode !== "continuous" &&
      mode === "live" &&
      incidentAssessment &&
      validIncidentAssessment(incidentAssessment) &&
      incidents.some((incident) => incident.moduleId === module.id && incident.severity === "high")
        ? "high"
        : context?.mode !== "continuous" &&
            mode === "live" &&
            incidentAssessment &&
            validIncidentAssessment(incidentAssessment) &&
            incidents.some(
              (incident) => incident.moduleId === module.id && incident.severity === "warning",
            )
          ? "warning"
          : moduleStatus(statusOverview, module.id, context?.mode, catalog),
    ]),
  );
  const topology = new Set(selectedIncident?.affectedModuleIds ?? []);
  const evidence = $("plant-telemetry").checked
    ? plantEvidence(
        catalog,
        (id) => {
          const row =
            context?.mode === "continuous"
              ? continuousTagReading(continuousOverview, id)
              : (overview?.quality === "good" ||
                  (context?.capabilities?.connectionFlow === true &&
                    overview?.quality === "missing")) &&
                overview.latest.readings.find((reading) => reading.tagId === id);
          return usable(row) ? row : null;
        },
        number,
        selected,
        context?.capabilities?.connectionFlow === true && mode === "live"
          ? validConnectionFlow(connectionFlow, context.approvedRun?.runId, catalogVersion, catalog)
            ? connectionFlow.readings
            : []
          : undefined,
      )
    : { readings: new Map(), measuredRoutes: new Map() };
  evidence.lineStates = new Map(
    ["A", "B", "C"].map((line) => [
      line,
      lineOperatingState(statusOverview, line, context?.mode, Date.now(), mode === "replay"),
    ]),
  );
  renderTop(
    $("plant-top"),
    catalog,
    lines,
    utilities,
    selected,
    select,
    statuses,
    topology,
    evidence,
  );
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
  plant3d?.update(lines, utilities, selected, statuses, topology, evidence);
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
  drawShift();
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
  const valid =
    overview?.quality === "good" ||
    (context?.capabilities?.connectionFlow === true && overview?.quality === "missing");
  text(
    "quality",
    `Quality: ${overview?.quality === "good" ? "good" : valid ? "partial" : unknownQuality(overview?.quality)}`,
  );
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
    const observedFeed =
      index === 0 &&
      !good &&
      context?.capabilities?.unpinnedFlow === true &&
      validConnectionFlow(connectionFlow, context?.approvedRun?.runId, catalogVersion, catalog)
        ? latestFeedTotal(connectionFlow.readings)
        : null;
    if (observedFeed) {
      text(
        `kpi-${key}`,
        `${observedFeed.count < 3 ? `Partial ${observedFeed.count}/3 · ` : ""}${number(observedFeed.value)} t/h`,
      );
      text(
        `meta-${key}`,
        `Latest observed feed · ${observedFeed.count}/3 lines${observedFeed.delayed ? " · delayed" : ""} · oldest sample ${timestamp(observedFeed.oldestSampleTime)}`,
      );
      return;
    }
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
let buildup = [];

function drawShift() {
  if (!catalog) return;
  const continuous = context?.mode === "continuous";
  const data = continuous ? continuousOverview : overview;
  const observation =
    !continuous &&
    mode === "live" &&
    (data?.quality === "good" ||
      (context?.capabilities?.connectionFlow === true && data?.quality === "missing")) &&
    demoRun?.publisherStatus === "running" &&
    !demoRun.stopRequested &&
    demoRun.runId === context?.approvedRun?.runId
      ? buildupObservation(data.latest.readings, data.asOf)
      : null;
  if (!observation) buildup = [];
  else if (observation.time > (buildup.at(-1)?.time ?? 0))
    buildup = [...buildup, observation].slice(-2);
  const [previous, current] = buildup;
  text(
    "buildup-status",
    possibleBuildup(previous, current)
      ? `Possible upstream buildup · hopper ${number(previous.level)}% → ${number(current.level)}%; combined line feed ${number(previous.feed)} → ${number(current.feed)} t/h at ${timestamp(new Date(current.time).toISOString())}. Check feed and inventory before diagnosing a blockage.`
      : current
        ? "Buildup: latest comparable readings do not meet the demo advisory rule."
        : "Buildup: waiting for two comparable live samples.",
  );
}

function configureDiagnostic(preferred, strict = false) {
  const metric = $("diagnostic").value;
  const assets = diagnosticAssets(catalog, metric);
  const picker = $("diagnostic-asset");
  const id = (strict ? [preferred] : [preferred, picker.value, assets[0]?.id]).find((candidate) =>
    assets.some((asset) => asset.id === candidate),
  );
  picker.replaceChildren(
    ...(!id && strict
      ? [Object.assign(node("option", "Selected equipment has no supported trend"), { value: "" })]
      : []),
    ...assets.map((asset) => {
      const option = node("option", asset.label);
      option.value = asset.id;
      return option;
    }),
  );
  picker.disabled = !assets.length;
  if (id) picker.value = id;
  drawDiagnosticScope();
}

function drawDiagnosticScope() {
  const picker = $("diagnostic-asset");
  text(
    "diagnostic-scope",
    picker.value
      ? `${picker.selectedOptions[0].textContent} · ${mode === "replay" ? "replay at " + timestamp(replayTime) : context?.mode === "continuous" ? "cross-run observed averages" : demoRun?.publisherStatus === "publisher_complete" && demoRun?.runId === context?.approvedRun?.runId ? "completed run ending " + timestamp(demoRun.stopAt) : "approved run trend"} · ${$("window").selectedOptions[0].textContent}`
      : "No compatible diagnostic equipment is available.",
  );
}

function drawDrawer() {
  if (!catalog) return;
  $("asset-ask").disabled = $("mining-question").disabled || !(selected || selectedIncident);
  $("asset-diagnostic").hidden = !selected;
  if (!selected) {
    text(
      "asset-next",
      selectedIncident
        ? "Review the evidence below, then compare the affected lines."
        : "Select equipment on the twin or use the equipment list.",
    );
    text("asset-heading", selectedIncident?.title ?? "No module selected");
    text("asset-id", selectedIncident ? `Scope ${selectedIncident.scopeId}` : "No module selected");
    text(
      "asset-status",
      selectedIncident
        ? `Status: ${selectedIncident.verification} · no single module association`
        : "Status: unknown",
    );
    $("readings").replaceChildren(
      node(
        "p",
        selectedIncident
          ? "No single equipment module is identified for this assessment."
          : "Select an equipment module to inspect its readings.",
      ),
    );
    $("latest-readings").replaceChildren();
    for (const direction of ["upstream", "downstream"])
      $(direction).replaceChildren(node("p", "No single module is associated."));
    drawIncidentEvidence();
    return;
  }
  const module = catalog.modules.find((item) => item.id === selected);
  const next = {
    crusher: "Compare feed across lines, then check vibration against operating load.",
    dms:
      context?.capabilities?.connectionFlow === true
        ? "Compare feed pressure and upstream flows. Density is not simulated in this profile."
        : "Check the density trend with feed pressure before interpreting a change.",
    water: "Compare tank level and delivered flow, then check whether multiple lines slowed.",
    hopper: "Compare inventory and line feed before treating a rise as congestion.",
    sorter:
      "Compare sorter feed with upstream feed. This is concentrate feed, not diamond recovery.",
  }[module.kind];
  text(
    "asset-next",
    selectedIncident
      ? "Start with the assessment evidence below. Use trends to check whether the signal persists."
      : (next ?? "Check upstream and downstream readings to put this asset in context."),
  );
  $("asset-diagnostic").textContent = ["crusher", "dms", "water"].includes(module.kind)
    ? "Open diagnostic trend"
    : "Compare line feeds";
  $("asset-diagnostic").href = ["crusher", "dms", "water"].includes(module.kind)
    ? "#diagnostics"
    : "#feed-chart";
  text("asset-heading", module.label);
  text("asset-id", selected);
  const continuous = context?.mode === "continuous";
  text(
    "asset-status",
    continuous
      ? `Status: ${moduleStatus(continuousOverview, selected, "continuous", catalog)}; sensor freshness/quality only, not equipment operating status`
      : `Status: ${moduleStatus(overview, selected)}`,
  );
  const readings = $("readings");
  readings.replaceChildren();
  const latestReadings = $("latest-readings");
  latestReadings.replaceChildren();
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
  if (!tags.length) latestReadings.append(node("p", "No direct sensor readings."));
  for (const tag of tags) {
    const notSimulated =
      context?.capabilities?.connectionFlow === true && tag.metric === "medium_density";
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
      : (overview?.quality === "good" ||
          (context?.capabilities?.connectionFlow === true && overview?.quality === "missing")) &&
        usable(reading) &&
        reading.sampleTime &&
        Number.isFinite(Date.parse(reading.sampleTime));
    latestReadings.append(
      node(
        "p",
        `${tag.metric.replaceAll("_", " ")}: ${notSimulated ? "Not simulated" : good ? `${number(reading.value)} ${tag.unit}` : `Unknown ${tag.unit}`}`,
      ),
    );
    const article = node("article");
    article.append(node("h3", tag.metric.replaceAll("_", " ")));
    const details = node("dl");
    for (const [label, value] of [
      [
        "Reading",
        notSimulated
          ? "Not simulated"
          : good
            ? `${number(reading.value)} ${tag.unit}`
            : `Unknown ${tag.unit}`,
      ],
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
    if (context?.capabilities?.connectionFlow === true && mode === "live") {
      const endpoint = direction === "upstream" ? "target" : "source";
      const other = direction === "upstream" ? "source" : "target";
      const valid = validConnectionFlow(
        connectionFlow,
        context.approvedRun?.runId,
        catalogVersion,
        catalog,
      );
      for (const stream of catalog.streams.filter(
        (item) => item[endpoint].module_id === selected,
      )) {
        const components = valid
          ? connectionFlow.readings.filter((item) => item.streamId === stream.id)
          : [];
        const rates = components.map((item) => {
          const label =
            item.quantity === "dry_solids_mass_flow"
              ? "solids"
              : item.quantity === "water_volume_flow"
                ? "water"
                : "medium";
          const state = connectionReadingState(item);
          return `${label} ${state !== "unavailable" ? `${number(item.value)} ${item.unit}${state === "delayed" ? ` (delayed · sampled ${timestamp(item.sampleTime)})` : ""}` : "unknown"}`;
        });
        const button = node("button", stream[other].module_id);
        button.type = "button";
        button.addEventListener("click", () => select(stream[other].module_id));
        const trendButton = node(
          "button",
          `${rates.length ? rates.join(" · ") : "Flow unknown"} · trend`,
        );
        trendButton.type = "button";
        trendButton.disabled = !valid;
        trendButton.addEventListener("click", () => showConnectionTrend(stream));
        container.append(button, trendButton);
      }
      if (!container.childNodes.length) container.append(node("p", "No authored connection."));
      continue;
    }
    for (const id of connections(catalog, selected, direction)) {
      const button = node("button", id);
      button.type = "button";
      button.addEventListener("click", () => select(id));
      container.append(button);
    }
    if (!container.childNodes.length) container.append(node("p", "No authored connection."));
  }
  drawIncidentEvidence();
}
function select(id, incident = null) {
  if (!catalog.modules.some((module) => module.id === id)) return;
  flowTrendGeneration++;
  $("flow-trend-details").hidden = true;
  selected = id;
  selectedIncident = incident;
  const module = catalog.modules.find((item) => item.id === id);
  if (["A", "B", "C"].includes(module.line)) $("line-scope").value = module.line;
  lines.add(module.line);
  document.querySelectorAll('input[name="line"]').forEach((input) => {
    input.checked = lines.has(input.value);
  });
  if (incident?.metric)
    $("diagnostic").value = incident.metric === "feed" ? "vibration" : incident.metric;
  else if (["dms", "water", "crusher", "sorter"].includes(module.kind))
    $("diagnostic").value =
      module.kind === "dms"
        ? "density"
        : module.kind === "water"
          ? "water-energy"
          : module.kind === "sorter"
            ? "sorter-feed"
            : "vibration";
  configureDiagnostic(id, true);
  chart($("diagnostic-chart"), null);
  drawPlant();
  drawDrawer();
  if (!document.hidden) refreshAll("diagnostic");
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
    button.addEventListener("click", () => {
      selectIncident(incident);
      $("asset-detail").focus();
    });
    item.append(button);
    container.append(item);
  }
}
function drawContinuousAdvisories(message) {
  const container = $("continuous-advisories");
  container.replaceChildren();
  if (!continuousAdvisoryData) {
    text("continuous-advisory-status", message);
    return;
  }
  const data = continuousAdvisoryData;
  text(
    "continuous-advisory-status",
    `${data.advisories.length} retrospective ${data.advisories.length === 1 ? "advisory" : "advisories"} from ${timestamp(data.windowStart)} to ${timestamp(data.asOf)} · source captured ${timestamp(data.sourceObservedAt)}. Empty results are not proof of health or completeness.`,
  );
  for (const advisory of data.advisories) {
    const ages = advisory.evidence.map(
      (row) =>
        `${row.tagId}: ${row.value} ${row.unit} at ${timestamp(row.sampleTime)} · ${Math.max(0, Math.floor((Date.parse(data.sourceObservedAt) - Date.parse(row.sampleTime)) / 1000))}s old`,
    );
    const states = advisory.stateEvidence.map(
      (row) => `${row.scopeId} ${row.state} at ${timestamp(row.sampleTime)}`,
    );
    const item = node(
      "li",
      `${advisory.severity.toUpperCase()} · ${advisory.ruleId} · ${advisory.scopeId} · ${advisory.verification} · event window ${timestamp(advisory.evidenceWindow.start)}–${timestamp(advisory.evidenceWindow.end)}${ages.length ? ` · ${ages.join("; ")}` : ""}${states.length ? ` · ${states.join("; ")}` : ""}`,
    );
    container.append(item);
  }
}
function chart(container, data) {
  container.replaceChildren();
  if (!data || !Array.isArray(data.rows) || data.rows.length > 1000 || !data.rows.length) {
    container.append(node("p", "Unknown — no covered trend is available."));
    return;
  }
  const binSeconds = data.connectionFlow ? data.windowSeconds : data.binMinutes * 60;
  if (
    (data.connectionFlow ? ![30, 60].includes(binSeconds) : ![1, 5].includes(data.binMinutes)) ||
    data.rows.some((row) =>
      data.connectionFlow
        ? !connectionFlow?.readings.some(
            (item) => item.measurementTagId === row.seriesId && item.unit === row.unit,
          )
        : !catalog.telemetry_tags.some((tag) => tag.id === row.seriesId && tag.unit === row.unit),
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
  const axisText = (x, y, value, anchor = "middle") => {
    const label = document.createElementNS(svg.namespaceURI, "text");
    label.setAttribute("x", x);
    label.setAttribute("y", y);
    label.setAttribute("text-anchor", anchor);
    label.setAttribute("class", "chart-tick");
    label.textContent = value;
    svg.append(label);
  };
  for (const fraction of [0, 0.5, 1]) {
    axisText(
      40 + fraction * 540,
      200,
      new Date(start + (end - start) * fraction).toISOString().slice(11, 16),
    );
    if (unitRanges.size === 1) {
      const [low, high] = [...unitRanges.values()][0];
      const y = 165 - fraction * 120;
      const grid = document.createElementNS(svg.namespaceURI, "line");
      for (const [key, value] of Object.entries({ x1: 40, x2: 580, y1: y, y2: y }))
        grid.setAttribute(key, value);
      grid.setAttribute("class", "chart-axis");
      svg.append(grid);
      axisText(36, y + 4, number(low + (high - low) * fraction), "end");
    }
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
            : Date.parse(row.timestamp) - Date.parse(previous.timestamp) > binSeconds * 1000 * 1.5))
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
      `${timestamp(data.windowStart)} to ${timestamp(data.windowEnd)} · ${data.connectionFlow ? `${binSeconds}-second` : `${data.binMinutes}-minute`} bins`,
    ),
  );
  const details = node("details"),
    summary = node("summary", "Chart data and provenance"),
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
  details.append(
    summary,
    node(
      "p",
      `${data.crossRun ? "Observed bin averages; runs remain separate. " : ""}Gaps and non-good-quality samples are not connected.${data.crossRun ? " Within the selected window, missing rows mean no bin was returned, not zero or an unrequested interval." : ""}`,
    ),
    wrap,
  );
  container.append(details);
}

async function showConnectionTrend(stream) {
  const owner = context?.approvedRun?.runId;
  const liveStream = context?.capabilities?.unpinnedFlow === true;
  if (!validConnectionFlow(connectionFlow, owner, catalogVersion, catalog)) return;
  const quantities = new Set(
    connectionFlow.readings
      .filter((item) => item.streamId === stream.id)
      .map((item) => item.quantity),
  );
  const sharesQuantity = (candidate) =>
    connectionFlow.readings.some(
      (item) => item.streamId === candidate.id && quantities.has(item.quantity),
    );
  const related = [
    stream,
    catalog.streams.find(
      (item) => item.target.module_id === stream.source.module_id && sharesQuantity(item),
    ),
    catalog.streams.find(
      (item) => item.source.module_id === stream.target.module_id && sharesQuantity(item),
    ),
  ].filter(Boolean);
  const streamIds = [...new Set(related.map((item) => item.id))];
  const end = connectionFlow.asOf;
  const start = new Date(
    liveStream
      ? Date.parse(end) - 15 * 60_000
      : Math.max(Date.parse(connectionFlow.runStartedAt), Date.parse(end) - 15 * 60_000),
  ).toISOString();
  if (start === end) {
    $("flow-trend-details").hidden = false;
    $("flow-trend-details").open = true;
    text("flow-trend-heading", `Connection trend · ${stream.id}`);
    $("flow-trend").replaceChildren(node("p", "Waiting for the first trend window."));
    return;
  }
  const request = { runId: owner, catalogVersion, streamIds, start, end, windowSeconds: 30 };
  const generation = ++flowTrendGeneration;
  const moduleId = selected;
  const current = () =>
    generation === flowTrendGeneration &&
    mode === "live" &&
    selected === moduleId &&
    context?.approvedRun?.runId === owner;
  $("flow-trend-details").hidden = false;
  $("flow-trend-details").open = true;
  text("flow-trend-heading", `Connection trend · ${stream.id}`);
  $("flow-trend").replaceChildren(node("p", "Loading connection trends…"));
  try {
    const data = await reads.read("connection-trend", {
      plantId: "D01",
      ...(liveStream ? {} : { runId: owner }),
      streamIds: streamIds.join(","),
      start,
      end,
      windowSeconds: "30",
    });
    if (!current()) return;
    if (!validConnectionTrend(data, request, connectionFlow)) {
      throw new Error("Connection trend evidence is unavailable or incomplete.");
    }
    chart($("flow-trend"), {
      connectionFlow: true,
      windowSeconds: request.windowSeconds,
      windowStart: start,
      windowEnd: end,
      rows: data.points.map((point) => ({
        seriesId: point.measurementTagId,
        unit: point.unit,
        timestamp: point.windowStart,
        value: point.value,
        quality: point.complete ? "good" : point.quality === "good" ? "partial" : point.quality,
        coverage: point.coverage,
      })),
    });
    $("flow-trend").append(
      node("p", "Nearby modeled connections can differ because of splits and transit time."),
    );
  } catch {
    if (current())
      $("flow-trend").replaceChildren(node("p", "Connection trends unavailable. Try again."));
  }
}

function clearReadState(message) {
  contextualGeneration++;
  buildup = [];
  overview = null;
  continuousOverview = null;
  continuousAdvisoryData = null;
  incidents = [];
  incidentAsOf = null;
  incidentAssessment = null;
  selectedIncident = null;
  drawOverview();
  text("connection", message);
  text("incident-status", "Unknown — incident source unavailable.");
  $("incidents").replaceChildren();
  drawContinuousAdvisories("Unknown — bounded rolling advisory evidence is unavailable.");
  chart($("feed-chart"), null);
  chart($("diagnostic-chart"), null);
  $("line-chart").replaceChildren();
  $("diagnostic-extra").replaceChildren();
}
async function refreshContextualTrends(scope) {
  if (!["all", "detail", "diagnostic"].includes(scope)) return;
  const generation = ++contextualGeneration;
  const epoch = requestEpoch;
  const line = $("line-scope").value;
  const asset = $("diagnostic-asset").value;
  const family = $("diagnostic").value;
  const owner = context?.approvedRun;
  const continuous = context?.mode === "continuous";
  $("feed-chart").hidden = line !== "all";
  $("line-chart").hidden = line === "all";
  text(
    "feed-heading",
    line === "all" ? "A / B / C crusher feed" : `Line ${line} · crusher feed and sorter input`,
  );
  $("diagnostic-extra").replaceChildren();
  if (line !== "all") $("line-chart").replaceChildren(node("p", "Loading line readings…"));
  if (
    !owner ||
    !context?.readAvailable ||
    document.hidden ||
    (continuous && context.capabilities?.trends !== true)
  ) {
    if (line !== "all")
      $("line-chart").replaceChildren(
        node("p", "Line trend unavailable. Retry when readings are available."),
      );
    return;
  }
  let params;
  try {
    params = query();
  } catch {
    return;
  }
  const current = () =>
    generation === contextualGeneration &&
    epoch === requestEpoch &&
    !document.hidden &&
    context?.approvedRun?.runId === owner.runId &&
    context?.approvedRun?.generation === owner.generation &&
    $("line-scope").value === line &&
    $("diagnostic-asset").value === asset &&
    $("diagnostic").value === family;
  const load = async (metric, moduleId) => {
    if (continuous) {
      const request = {
        plantId: "D01",
        start: params.start,
        end: params.end,
        metric,
        binMinutes: params.binMinutes,
      };
      const data = await reads.read("cross-run-trends", request);
      const result = crossRunChartData(data, request, catalogVersion, catalog, owner);
      if (!result) throw new Error("Trend evidence unavailable.");
      result.rows = result.rows.filter((row) => row.moduleId === moduleId);
      return result;
    }
    const request = seriesQuery(params, metric, moduleId);
    const data = await reads.read("trends", request);
    if (!validSeries(data, { ...params, metric, moduleId }, catalogVersion, catalog))
      throw new Error("Trend evidence unavailable.");
    return data;
  };
  const tasks = [];
  if (line !== "all")
    tasks.push(
      (async () => {
        try {
          const [feed, sorter] = await Promise.all([
            load("feed", `D01.${line}.crusher`),
            load("sorter-feed", `D01.${line}.sorter`),
          ]);
          if (!current()) return;
          // The legacy finite feed is already run-scoped. Preserve gaps when combining it
          // with segmented validated sorter points on the same t/h axis.
          const rows = [feed, sorter].flatMap((data) =>
            data.crossRun
              ? data.rows
              : data.rows.map((row) => ({
                  ...row,
                  runId: params.runId,
                  status: usable(row) ? "OBSERVED" : "GAP",
                  segmentId: usable(row) ? `${params.runId}:${row.seriesId}:finite` : null,
                })),
          );
          const target = $("line-chart");
          chart(target, {
            crossRun: true,
            rows,
            binMinutes: Number(params.binMinutes),
            windowStart: params.start,
            windowEnd: params.end,
          });
          target.prepend(node("p", "Crusher feed and sorter input · t/h"));
        } catch (error) {
          if (current())
            $("line-chart").replaceChildren(node("p", "Line trend unavailable. Try again."));
        }
      })(),
    );
  const extras = !asset
    ? []
    : family === "vibration"
      ? [
          ["Crusher feed", "feed"],
          ["Bearing temperature", "bearing-temperature"],
          ["Motor current", "motor-current"],
        ]
      : family === "density"
        ? [
            ["Feed pressure", "feed-pressure"],
            ["Motor current", "motor-current"],
          ]
        : family === "sorter-feed"
          ? [["Motor current", "motor-current"]]
          : [];
  tasks.push(
    ...extras.map(async ([label, metric]) => {
      try {
        const data = await load(metric, asset);
        return { label, data };
      } catch {
        return { label, data: null };
      }
    }),
  );
  const results = await Promise.all(tasks);
  if (!current()) return;
  for (const result of results.filter(Boolean)) {
    const section = node("section");
    section.append(node("h3", result.label));
    const plot = node("div");
    section.append(plot);
    $("diagnostic-extra").append(section);
    chart(plot, result.data);
  }
}
async function refreshAll(scope = "all") {
  await Promise.all([refresh(scope), refreshContextualTrends(scope), refreshConnectionFlow(scope)]);
}

function scheduleFlowExpiry(data) {
  clearTimeout(flowExpiryTimer);
  const now = Date.now();
  const deadlines = [
    Date.parse(data.asOf) + 30_001,
    ...data.readings
      .filter((reading) => usableConnectionReading(reading, now))
      .flatMap((reading) => [
        Date.parse(reading.sampleTime) + 15_000,
        Date.parse(reading.sampleTime) + 120_001,
      ]),
  ].filter((deadline) => Number.isFinite(deadline) && deadline > now);
  if (!deadlines.length) return;
  flowExpiryTimer = setTimeout(
    () => {
      if (connectionFlow !== data) return;
      drawOverview();
      if (
        !validConnectionFlow(data, context?.approvedRun?.runId, catalogVersion, catalog) ||
        !data.readings.some((reading) => usableConnectionReading(reading))
      ) {
        text("flow-status", "Waiting for validated connection flows.");
        return;
      }
      text("flow-status", connectionFlowStatus(data));
      scheduleFlowExpiry(data);
    },
    Math.min(...deadlines) - now,
  );
}

function connectionFlowStatus(data) {
  const readings = data.readings.filter((reading) => usableConnectionReading(reading));
  if (!readings.length) return "Waiting for validated connection flows.";
  const times = readings.map((reading) => Date.parse(reading.sampleTime));
  const first = Math.min(...times);
  const last = Math.max(...times);
  const timeRange =
    first === last
      ? timestamp(new Date(first).toISOString())
      : `${timestamp(new Date(first).toISOString())} – ${timestamp(new Date(last).toISOString())}`;
  const delayed = readings.some((reading) => connectionReadingState(reading) === "delayed");
  return `Synthetic flows${delayed ? " · delayed" : ""} · sampled ${timeRange}`;
}

async function refreshConnectionFlow(scope) {
  const enabled =
    mode === "live" &&
    context?.capabilities?.connectionFlow === true &&
    context?.readAvailable &&
    (context?.capabilities?.unpinnedFlow === true || context?.approvedRun);
  $("flow-status").hidden = !enabled;
  text(
    "flow-legend",
    enabled ? "Solids flow (synthetic)" : "Measured inlet rate (not equipment health)",
  );
  if (!enabled) {
    clearTimeout(flowExpiryTimer);
    connectionFlow = null;
    flowTrendGeneration++;
    $("flow-trend-details").hidden = true;
    return;
  }
  if (document.hidden || !["all", "overview"].includes(scope)) return;
  const runId = context.approvedRun?.runId;
  const liveStream = context?.capabilities?.unpinnedFlow === true;
  const epoch = requestEpoch;
  const current = () =>
    epoch === requestEpoch && !document.hidden && context?.approvedRun?.runId === runId;
  try {
    const data = await reads.read("connection-latest", {
      plantId: "D01",
      ...(liveStream ? {} : { runId }),
    });
    if (!current()) return;
    if (!validConnectionFlow(data, runId, catalogVersion, catalog)) {
      throw new Error("Flow readings are unavailable or out of date.");
    }
    connectionFlow = data;
    scheduleFlowExpiry(data);
    text("flow-status", connectionFlowStatus(data));
  } catch (cause) {
    if (!current()) return;
    clearTimeout(flowExpiryTimer);
    connectionFlow = null;
    flowTrendGeneration++;
    $("flow-trend-details").hidden = true;
    text(
      "flow-status",
      cause?.category === "waiting"
        ? "Waiting for the first connection flow samples."
        : "Connection flows unavailable. Plant layout remains available.",
    );
  }
  drawOverview();
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
      text("incident-status", "Continuous mode has no durable active-incident history.");
      $("incidents").replaceChildren();
      if (scope === "all" || scope === "detail") {
        if (context.capabilities?.incidents !== true) {
          continuousAdvisoryData = null;
          drawContinuousAdvisories(
            "Unavailable — rolling advisory evidence is not enabled for this owner.",
          );
        } else {
          try {
            const advisory = await reads.read("incidents", { plantId: "D01", runId });
            if (!current()) return;
            if (
              !validContinuousAdvisories(
                advisory,
                runId,
                catalogVersion,
                generation,
                Date.now(),
                catalog,
              )
            ) {
              throw new Error("Rolling advisory evidence is invalid, stale or from another owner.");
            }
            continuousAdvisoryData = advisory;
            drawContinuousAdvisories();
          } catch (error) {
            if (!current()) return;
            continuousAdvisoryData = null;
            drawContinuousAdvisories(
              `Unavailable — ${error.message} No health or completeness conclusion is implied.`,
            );
          }
        }
      }
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
      const asset = $("diagnostic-asset").value;
      const matching = () =>
        current() &&
        (target !== "diagnostic-chart" ||
          ($("diagnostic").value === metric && $("diagnostic-asset").value === asset));
      try {
        const request = {
          plantId: "D01",
          start: params.start,
          end: params.end,
          metric,
          binMinutes: params.binMinutes,
        };
        const data = await reads.read("cross-run-trends", request);
        if (!matching()) return;
        const chartData = crossRunChartData(data, request, catalogVersion, catalog, {
          runId,
          generation,
        });
        if (!chartData) throw new Error("Cross-run trend evidence is invalid or unavailable.");
        if (target === "diagnostic-chart" && metric !== "water-energy")
          chartData.rows = chartData.rows.filter((row) => row.moduleId === asset);
        chart($(target), chartData);
        if (target === "diagnostic-chart") drawDiagnosticScope();
      } catch (error) {
        if (matching()) {
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
  if (context?.mode !== "continuous") {
    continuousAdvisoryData = null;
    drawContinuousAdvisories("Not applicable to finite-run incident assessments.");
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
  const flowProfile = context?.capabilities?.connectionFlow === true;
  if ((scope === "all" || scope === "detail") && incidentQuery && flowProfile) {
    incidents = [];
    incidentAsOf = null;
    incidentAssessment = null;
    selectedIncident = null;
    drawIncidents("Incident assessments are not available for this flow simulation.");
    drawDrawer();
    drawPlant();
  }
  if ((scope === "all" || scope === "detail") && incidentQuery && !flowProfile)
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
          drawPlant();
        } catch (error) {
          if (current()) {
            incidents = [];
            incidentAsOf = null;
            incidentAssessment = null;
            selectedIncident = null;
            drawIncidents(error.message);
            drawDrawer();
            drawPlant();
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
  if (
    $("diagnostic-asset").value &&
    (scope === "all" || scope === "detail" || scope === "diagnostic")
  ) {
    const moduleId = $("diagnostic-asset").value,
      metric = $("diagnostic").value;
    const diagnosticCurrent = () =>
      current() && $("diagnostic-asset").value === moduleId && $("diagnostic").value === metric;
    if (flowProfile && metric === "density") {
      chart($("diagnostic-chart"), null);
      $("diagnostic-chart").append(node("p", "Density is not simulated in this flow profile."));
      drawDiagnosticScope();
    } else
      tasks.push(
        (async () => {
          try {
            const data = await reads.read("trends", seriesQuery(params, metric, moduleId));
            if (!validSeries(data, { ...params, moduleId, metric }, catalogVersion, catalog))
              throw new Error(
                "Trend response does not match the requested module, time, metric or catalog.",
              );
            if (diagnosticCurrent()) chart($("diagnostic-chart"), data);
            if (diagnosticCurrent()) drawDiagnosticScope();
          } catch (error) {
            if (diagnosticCurrent()) {
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
    else await refreshAll();
  } catch (error) {
    if (epoch === requestEpoch) {
      context = null;
      clearReadState(error.message);
    }
  }
  configurePolling();
}
function invalidate() {
  requestEpoch++;
  clearTimeout(flowExpiryTimer);
  connectionFlow = null;
  flowTrendGeneration++;
  $("flow-trend-details").hidden = true;
  answerController?.abort();
  answerController = null;
  text("mining-answer", "");
  text("mining-answer-status", "");
  text("mining-answer-source", "");
  $("mining-answer-evidence").hidden = true;
  if (stripInvestigation($("mining-question"))) {
    text("assistant-draft-context", "Investigation context removed because the view changed.");
  }
  reads.abort();
  polling.stop();
}
let insertedInvestigation = "";
function stripInvestigation(field) {
  if (!insertedInvestigation) return false;
  if (!field.value.endsWith(insertedInvestigation)) {
    insertedInvestigation = "";
    text(
      "assistant-draft-context",
      "The view changed. Check the context in your edited draft before sending.",
    );
    return false;
  }
  field.value = field.value.slice(0, -insertedInvestigation.length).trimEnd();
  insertedInvestigation = "";
  return true;
}
$("asset-ask").addEventListener("click", () => {
  const field = $("mining-question");
  if (field.disabled) return;
  const prompt = investigationPrompt({
    moduleId: selected,
    incident: selectedIncident,
    asOf: (context?.mode === "continuous" ? continuousOverview : overview)?.asOf,
  });
  if (!prompt) return;
  const existing = (
    insertedInvestigation && field.value.endsWith(insertedInvestigation)
      ? field.value.slice(0, -insertedInvestigation.length)
      : field.value
  ).trim();
  const combined = existing ? `${existing}\n\n${prompt}` : prompt;
  if (combined.length > field.maxLength) {
    text(
      "assistant-draft-context",
      "Shorten your existing draft before adding investigation context.",
    );
  } else {
    field.value = combined;
    insertedInvestigation = prompt;
    text(
      "assistant-draft-context",
      "Investigation context added. Review the draft before sending.",
    );
  }
  field.focus();
});
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
    const evidenceValid =
      context.mode === "continuous"
        ? data.evidence?.mode === "continuous" &&
          data.evidence.owner?.runId === runId &&
          data.evidence.owner?.generation === context.approvedRun.generation &&
          validContinuousOverview(
            data.evidence.overview,
            runId,
            catalogVersion,
            context.approvedRun.generation,
            Date.now(),
            catalog,
          ) &&
          validContinuousAdvisories(
            data.evidence.advisories,
            runId,
            catalogVersion,
            context.approvedRun.generation,
            Date.now(),
            catalog,
          )
        : sameScope(data.evidence, runId, catalogVersion) &&
          validAsOf(data.evidence.asOf, new Date().toISOString(), false);
    if (
      !sameScope(data, runId, catalogVersion) ||
      data.kind !== "bounded-fabric-evidence" ||
      data.nativeDataAgentInvoked !== false ||
      typeof data.answer !== "string" ||
      !data.answer.trim() ||
      data.answer.length > 12_000 ||
      !evidenceValid
    )
      throw new Error("The answer did not match the current run. Refresh and ask again.");
    renderAnswer(data.answer);
    text(
      "mining-answer-status",
      context.mode === "continuous"
        ? `Generated interpretation for run ${runId}. Rolling event-time evidence ${timestamp(data.evidence.advisories.asOf)}; source captured ${timestamp(data.evidence.advisories.sourceObservedAt)}. Empty advisories are not proof of health or completeness. Not a native Data Agent answer.`
        : `Generated interpretation for run ${runId}. Evidence cutoff ${timestamp(data.evidence.asOf)}; evidence quality ${data.evidence.quality}. Not a native Data Agent answer.`,
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
let requestedSimulation = null;
let demoStatusTimer;
let demoStatusClosed = false;
let nativeDemoLive = false;
let fastDemoStatus = false;
let fabricDemoSignal = false;
let streamRunId;
let streamReceipts = [];
let streamPreview = [];
let renderedStream;
let previousSignalMode;

function drawStream() {
  const panel = $("stream-panel");
  panel.hidden = mode !== "live" || !demoRun || (!fastDemoStatus && !nativeDemoLive);
  $("stream-empty").hidden = !panel.hidden;
  text(
    "stream-empty",
    mode === "replay"
      ? "Live receipts are excluded from replay. Use diagnostics for the selected time."
      : "No live receipt history is available for this run.",
  );
  if (panel.hidden) return;
  if (streamRunId !== demoRun.runId || previousSignalMode !== fabricDemoSignal) {
    streamRunId = demoRun.runId;
    previousSignalMode = fabricDemoSignal;
    streamReceipts = [];
    streamPreview = [];
  }
  streamReceipts = collectReceipt(streamReceipts, demoRun);
  if (demoRun.publisherStatus === "running" && !demoRun.stopRequested) {
    const points = collectPreview(demoRun, fabricDemoSignal);
    if (points.length) streamPreview = points;
  }
  const revision = JSON.stringify([streamRunId, fabricDemoSignal, streamReceipts, streamPreview]);
  if (revision !== renderedStream) {
    drawStreamCharts(streamReceipts, streamPreview, $, number, fabricDemoSignal);
    renderedStream = revision;
  }
  drawStreamWindow();
}

function drawStreamWindow() {
  const element = $("stream-window");
  const window =
    nativeDemoLive && !$("stream-panel").hidden ? streamWindow(demoRun, streamReceipts) : null;
  element.hidden = !window;
  text(
    "shift-data",
    mode === "replay"
      ? "Data: historical read at the selected time."
      : window?.state === "overdue"
        ? "Data gap: an expected Fabric batch is overdue."
        : window?.state === "arriving"
          ? "Data: numeric window closed; awaiting Fabric."
          : window
            ? "Data: collecting the next numeric window."
            : "Data: no active batch countdown; see run and receipt status.",
  );
  $("buildup-status").hidden = mode === "replay" || window?.state === "overdue";
  if (!window) return;
  element.dataset.state = window.state;
  $("stream-progress").value = window.progress;
  text(
    "stream-phase",
    window.state === "overdue"
      ? "Overdue · expected Fabric batch not observed"
      : window.state === "arriving"
        ? "Window closed · awaiting Fabric receipt"
        : `Collecting readings · next batch in ${window.remaining}s`,
  );
}

function drawStartupPreview() {
  drawStream();
  const receipt = demoRun?.nativeReceipt;
  const liveElement = $("run-native-receipt");
  const confirmed =
    demoRun?.publisherStatus === "running" &&
    receipt?.runId === demoRun.runId &&
    Number.isFinite(Date.parse(receipt.receivedAt)) &&
    Number.isSafeInteger(receipt.stateCount) &&
    Number.isSafeInteger(receipt.telemetryCount);
  const reading = receipt?.reading;
  liveElement.hidden = !confirmed;
  liveElement.dataset.runId = confirmed ? receipt.runId : "";
  liveElement.dataset.telemetryCount = confirmed ? String(receipt.telemetryCount) : "0";
  liveElement.textContent = confirmed
    ? `Fabric live · ${reading ? `${reading.tagId}: ${number(reading.value)} ${reading.unit}. ` : ""}${receipt.stateCount} state and ${receipt.telemetryCount} telemetry events validated at ${timestamp(receipt.receivedAt)}.`
    : "";
  const preview = demoRun?.startupPreview;
  const element = $("run-startup-preview");
  const valid =
    demoRun?.publisherStatus === "running" &&
    preview?.runId === demoRun.runId &&
    Number.isFinite(Date.parse(preview.sampleTime)) &&
    Number.isFinite(preview.hopperTonnes) &&
    preview.hopperTonnes >= 0;
  element.textContent = valid
    ? `Simulator startup · Hopper: ${number(preview.hopperTonnes)} t at ${timestamp(preview.sampleTime)}. Plant state sent. Hopper preview only; not Fabric-validated.`
    : "";
  element.dataset.runId = valid ? preview.runId : "";
  element.hidden = !valid;
}
function renderAnswer(answer) {
  const container = $("mining-answer");
  container.replaceChildren();
  for (const paragraph of answer.split(/\n\s*\n/)) {
    const block = node("p");
    for (const [index, line] of paragraph.split("\n").entries()) {
      if (index) block.append(node("br"));
      for (const part of line.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g)) {
        block.append(
          part.startsWith("**") && part.endsWith("**")
            ? node("strong", part.slice(2, -2))
            : part.startsWith("`") && part.endsWith("`")
              ? node("code", part.slice(1, -1))
              : node("span", part),
        );
      }
    }
    container.append(block);
  }
}
function drawArrival() {
  if (document.hidden) return;
  drawStreamWindow();
  const data = mode === "live" ? (continuousOverview ?? overview) : null;
  const timing = simulationTiming(demoRun, data);
  const seconds = (value) => `${Math.round(value)}s`;
  const remaining = timing.remainingSeconds;
  text(
    "simulation-clock",
    remaining !== null
      ? remaining > 0
        ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")} left`
        : "Finishing"
      : timing.active
        ? "Continuous"
        : ["preparing", "scheduled"].includes(demoRun?.publisherStatus)
          ? "Preparing"
          : demoRun?.publisherStatus === "publisher_complete"
            ? "Complete"
            : demoRun?.publisherStatus === "stopping" || demoRun?.stopRequested
              ? "Stopping / stopped"
              : demoRun
                ? "Ready to start"
                : "Status unavailable",
  );
  const hasReceipt = timing.lagSeconds !== null;
  if (hasReceipt && requestedSimulation && requestedSimulation.runId === demoRun?.runId) {
    requestedSimulation.firstVisibleSeconds ??= (Date.now() - requestedSimulation.at) / 1000;
  }
  text(
    "arrival-status",
    mode === "replay"
      ? "Historical replay"
      : hasReceipt
        ? `Receipt ${seconds(timing.receiptAgeSeconds)} ago`
        : timing.active
          ? `Waiting ${seconds(timing.elapsedSeconds ?? 0)}`
          : "No live receipt",
  );
  text("arrival-lag", hasReceipt ? seconds(timing.lagSeconds) : "Not measured yet");
  const first =
    requestedSimulation &&
    requestedSimulation.runId === demoRun?.runId &&
    requestedSimulation.firstVisibleSeconds !== undefined
      ? ` First visible in this tab after ${seconds(requestedSimulation.firstVisibleSeconds)}.`
      : "";
  text(
    "arrival-detail",
    hasReceipt
      ? `Latest observed sample is ${seconds(timing.sampleAgeSeconds)} old. Delay measures its sample-to-Eventhouse receipt, not browser refresh time.${first}`
      : timing.active
        ? "Waiting for this run's confirmed Fabric receipts; readings refresh every 30 seconds."
        : "Start a simulation to measure real data-arrival delay. Missing data is never shown as zero.",
  );
}
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
    "A shared ten-minute simulation sends synthetic D01 data through Fabric. Reopening this page never starts another run.",
  );
  const status = demoRun
    ? `Publisher: ${demoRun.publisherStatus.replaceAll("_", " ")}${demoRun.stopRequested ? " · stop requested" : ""} · Fabric ingestion: ${verifiedRunIngestion(overview, demoRun)}. Shared by all visitors.`
    : "Ready when you are. A shared cooldown prevents repeated starts.";
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
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Simulation status unavailable. Retry.");
  }
  if (!response.ok) {
    const messages = {
      mining_demo_busy: "A simulation is active or cooling down.",
      mining_demo_rate_limited: "Too many requests. Try again later.",
      mining_demo_disabled: "Simulation controls are not enabled.",
      mining_demo_configuration: "Simulation controls are not configured.",
    };
    const code = data?.error?.code;
    throw new Error(
      (Object.hasOwn(messages, code) && messages[code]) ||
        "Simulation request unavailable. Check status and retry.",
    );
  }
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
    nativeDemoLive = data.nativeLive === true && data.mode === "bounded";
    fastDemoStatus = data.previewCadenceSeconds === 5 && data.mode === "bounded";
    fabricDemoSignal = data.fabricSignal === true && data.mode === "bounded";
    drawStartupPreview();
    const managed = data.mode === "continuous";
    $("run-warmup").hidden = data.mode !== "bounded";
    const active = activePublisher(demoRun);
    $("run-start").disabled = managed || !!active;
    $("run-cancel").disabled = managed || !active || demoRun.stopRequested;
    $("window").disabled = managed && context?.capabilities?.trends !== true;
    if (managed) {
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
    if (catalog && demoContextChanged(context, demoRun, managed)) {
      invalidate();
      reads.reset();
      await loadContext();
    }
  } catch (error) {
    if (epoch !== demoStatusEpoch || demoBusy) return;
    demoRun = null;
    nativeDemoLive = false;
    fastDemoStatus = false;
    fabricDemoSignal = false;
    $("run-warmup").hidden = true;
    drawStartupPreview();
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
function scheduleDemoStatus() {
  clearTimeout(demoStatusTimer);
  if (demoStatusClosed) return;
  const waitingForStartup =
    requestedSimulation &&
    Date.now() - requestedSimulation.at < 20_000 &&
    (demoRun?.runId !== requestedSimulation.runId ||
      (demoRun.publisherStatus === "running" && !demoRun.startupPreview));
  demoStatusTimer = setTimeout(
    () => void updateDemoStatus().finally(scheduleDemoStatus),
    waitingForStartup ||
      ["preparing", "scheduled"].includes(demoRun?.publisherStatus) ||
      ((nativeDemoLive || fastDemoStatus) && demoRun?.publisherStatus === "running")
      ? 2_000
      : 15_000,
  );
}
async function demoAction(action) {
  demoBusy = true;
  clearTimeout(demoStatusTimer);
  demoStatusEpoch++;
  $("run-start").disabled = true;
  $("run-cancel").disabled = true;
  let notice = "";
  try {
    const body =
      action === "cancel" ? { plantId: "D01", runId: demoRun.runId } : { plantId: "D01" };
    const result = await demoRequest(action, body);
    if (action === "start") requestedSimulation = { runId: result.runId, at: Date.now() };
    text(
      "run-control-status",
      `${action === "start" ? (result.publisherStatus === "preparing" ? "Preparing" : "Started") : "Stop requested"}: ${result.runId}. Fabric ingestion is not yet confirmed.`,
    );
  } catch (error) {
    notice = `${error.message} Check the run status before retrying. `;
  } finally {
    demoBusy = false;
    await updateDemoStatus(notice).finally(scheduleDemoStatus);
  }
}
$("run-start").addEventListener("click", () => void demoAction("start"));
$("run-cancel").addEventListener("click", () => void demoAction("cancel"));
void updateDemoStatus().finally(scheduleDemoStatus);
const arrivalTimer = setInterval(drawArrival, 1_000);
$("refresh").addEventListener("click", async () => {
  invalidate();
  await loadContext();
});
$("window").addEventListener("change", () => {
  drawDiagnosticScope();
  invalidate();
  if (context?.mode === "continuous") {
    $("feed-chart").replaceChildren(node("p", "Loading cross-run trend…"));
    $("diagnostic-chart").replaceChildren(node("p", "Loading cross-run trend…"));
  }
  refreshAll("detail");
  configurePolling();
});
$("diagnostic").addEventListener("change", () => {
  configureDiagnostic(selected);
  chart($("diagnostic-chart"), null);
  refreshAll("diagnostic");
});
$("diagnostic-asset").addEventListener("change", () => {
  if ($("diagnostic-asset").value) {
    select($("diagnostic-asset").value);
    return;
  }
  drawDiagnosticScope();
  chart($("diagnostic-chart"), null);
  refreshAll("diagnostic");
});
$("view").addEventListener("change", () => {
  $("plant-top").toggleAttribute("hidden", $("view").value !== "top");
  $("plant-3d").hidden = $("view").value !== "3d";
  if ($("view").value === "list") $("object-disclosure").open = true;
  configurePolling();
});
$("line-scope").addEventListener("change", () => {
  const line = $("line-scope").value;
  if (line !== "all") select(`D01.${line}.crusher`);
  else refreshAll("detail");
});
$("plant-fit").addEventListener("click", () => plant3d?.fit());
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
$("plant-telemetry").addEventListener("change", drawPlant);
document.addEventListener("visibilitychange", () => {
  invalidate();
  configurePolling();
  if (!document.hidden) {
    clearReadState("Refreshing after hidden-tab pause…");
    if (context) refreshAll();
    else loadContext();
  }
});
addEventListener("pagehide", () => {
  invalidate();
  demoStatusClosed = true;
  clearTimeout(demoStatusTimer);
  clearInterval(arrivalTimer);
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
  configureDiagnostic(selected);
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
