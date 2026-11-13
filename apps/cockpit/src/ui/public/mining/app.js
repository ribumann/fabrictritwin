import {
  MiningReads,
  MiningPolling,
  usable,
  normalizeReading,
  unknownQuality,
  validIncidentWindows,
  refreshedIncidentSelection,
  sameScope,
  moduleStatus,
  validOverview,
  validAsOf,
  validSeries,
} from "./data.js";
import { visibleModules, connections, relevantTags, renderTop, createPlant3D } from "./plant.js";

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
const timestamp = (value) =>
  Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : "unknown";
const coverage = (value) =>
  Number.isFinite(value) && value >= 0 && value <= 1 ? `${Math.round(value * 100)}%` : "unknown";
const reads = new MiningReads();
let catalog,
  catalogVersion,
  context,
  overview,
  selected,
  plant3d,
  requestEpoch = 0,
  selectedIncident = null;
let incidents = [];
let mode = "live";
let replayTime = null;
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
}
function query() {
  const asOf =
    mode === "replay"
      ? replayTime
      : new Date(Math.floor(Date.now() / 15_000) * 15_000).toISOString();
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
  const statuses = new Map(
    catalog.modules.map((module) => [module.id, moduleStatus(overview, module.id)]),
  );
  const topology = new Set(selectedIncident?.affectedModuleIds ?? []);
  renderTop($("plant-top"), catalog, lines, utilities, selected, select, statuses, topology);
  const list = $("object-list");
  list.replaceChildren();
  for (const module of visibleModules(catalog, lines)) {
    const item = node("li"),
      button = node(
        "button",
        `${module.label} · ${moduleStatus(overview, module.id)}${topology.has(module.id) ? " · topology context (not proven cause)" : ""}`,
      );
    button.dataset.status = moduleStatus(overview, module.id);
    button.type = "button";
    button.setAttribute("aria-pressed", String(module.id === selected));
    button.addEventListener("click", () => select(module.id));
    item.append(button);
    list.append(item);
  }
  plant3d?.update(lines, utilities, selected, statuses, topology);
}
function drawOverview() {
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
}
function drawDrawer() {
  if (!catalog || !selected) return;
  const module = catalog.modules.find((item) => item.id === selected);
  text("asset-heading", module.label);
  text("asset-id", selected);
  text("asset-status", `Status: ${moduleStatus(overview, selected)}`);
  text("diagnostic-scope", `Selected module: ${selected} · 30-minute default trend`);
  const readings = $("readings");
  readings.replaceChildren();
  const tags = relevantTags(catalog, selected);
  if (!tags.length)
    readings.append(
      node("p", "No numeric sensor is authored for this equipment. No value is inferred."),
    );
  for (const tag of tags) {
    const reading = overview?.latest?.readings?.find(
      (item) =>
        item.tagId === tag.id &&
        item.moduleId === selected &&
        item.equipmentId === tag.equipment_id &&
        item.unit === tag.unit,
    );
    const good =
      overview?.quality === "good" &&
      usable(reading) &&
      reading.sampleTime &&
      Number.isFinite(Date.parse(reading.sampleTime));
    const article = node("article");
    article.append(node("h3", tag.metric.replaceAll("_", " ")));
    const details = node("dl");
    for (const [label, value] of [
      ["Reading", good ? `${number(reading.value)} ${tag.unit}` : `Unknown ${tag.unit}`],
      ["Quality", good ? "good" : unknownQuality(reading?.quality)],
      ["Sample (UTC)", timestamp(reading?.sampleTime)],
      ["Ingested (UTC)", timestamp(reading?.ingestionTime)],
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
  text(
    "incident-evidence",
    selectedIncident
      ? `${selectedIncident.title} · rule ${selectedIncident.ruleId} · scope ${selectedIncident.scopeId} · ${selectedIncident.verification} · raised ${timestamp(selectedIncident.raisedAt)}. Hold: ${selectedIncident.holdWindowStart === null ? "no current qualifying hold" : `${timestamp(selectedIncident.holdWindowStart)} to ${timestamp(selectedIncident.holdWindowEnd)}`}; evidence: ${timestamp(selectedIncident.evidenceWindowStart)} to ${timestamp(selectedIncident.evidenceWindowEnd)}. ${selectedIncident.evidence.map((reading) => `${reading.tagId}: ${usable(reading) ? number(reading.value) : "Unknown"} ${reading.unit}, ${reading.quality}, ${timestamp(reading.sampleTime)}`).join("; ")}${selectedIncident.affectedModuleIds.length ? ` · Topology context: ${selectedIncident.affectedModuleIds.join(", ")} (not proven causation).` : ""}`
      : "",
  );
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
  if (incident) $("diagnostic").value = incident.metric === "feed" ? "vibration" : incident.metric;
  else
    $("diagnostic").value =
      module.kind === "dms" ? "density" : module.kind === "water" ? "water-energy" : "vibration";
  drawPlant();
  drawDrawer();
  if (context?.readAvailable && context?.approvedRun && !document.hidden) refresh("diagnostic");
}
function drawIncidents() {
  const container = $("incidents");
  container.replaceChildren();
  text(
    "incident-status",
    incidents.length
      ? "Top three active incidents · advisory only"
      : "No active incidents reported at the query time.",
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
      `${incident.severity.toUpperCase()} · ${incident.title} · ${incident.moduleId} · ${duration} min · ${incident.verification}${incident.acknowledgedAt ? " · acknowledged (not cleared)" : ""}`,
    );
    button.addEventListener("click", () => select(incident.moduleId, incident));
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
  const unitRanges = new Map();
  for (const row of rows.filter(usable)) {
    const range = unitRanges.get(row.unit) ?? [row.value, row.value];
    unitRanges.set(row.unit, [Math.min(range[0], row.value), Math.max(range[1], row.value)]);
  }
  groups.forEach((group, index) => {
    const items = rows
      .filter((row) => `${row.seriesId} (${row.unit})` === group)
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const values = items.filter(usable).map((row) => row.value);
    if (!values.length) return;
    const [low, high] = unitRanges.get(items[0].unit);
    const span = high - low || 1;
    let points = [];
    const flush = () => {
      if (points.length) {
        const line = document.createElementNS(svg.namespaceURI, "polyline");
        line.setAttribute("points", points.join(" "));
        line.setAttribute("stroke", colors[index % colors.length]);
        line.setAttribute("stroke-dasharray", index === 1 ? "6 3" : index === 2 ? "2 3" : "none");
        svg.append(line);
        points = [];
      }
    };
    let previous = null;
    for (const row of items) {
      if (
        !usable(row) ||
        (previous !== null && Date.parse(row.timestamp) - previous > data.binMinutes * 60_000 * 1.5)
      )
        flush();
      if (usable(row))
        points.push(
          `${40 + ((Date.parse(row.timestamp) - start) / (end - start)) * 540},${165 - ((row.value - low) / span) * 120}`,
        );
      previous = Date.parse(row.timestamp);
    }
    flush();
    const label = node(
      "p",
      `${group}: ${number(low)} – ${number(high)} · ${index === 0 ? "solid" : index === 1 ? "dashed" : "dotted"} line${groups.some((other) => !other.endsWith(`(${items[0].unit})`)) ? " · independent unit scale" : ""}`,
    );
    container.append(label);
  });
  container.prepend(svg);
  container.append(
    node(
      "p",
      `${timestamp(data.windowStart)} to ${timestamp(data.windowEnd)} · ${data.binMinutes}-minute bins. Gaps and non-good-quality samples are not connected.`,
    ),
  );
  const details = node("details"),
    summary = node("summary", "Read chart data"),
    wrap = node("div"),
    table = node("table");
  wrap.className = "mining-chart-table";
  const head = node("tr");
  ["Time (UTC)", "Series", "Value / unit", "Quality / coverage"].forEach((label) =>
    head.append(node("th", label)),
  );
  const thead = node("thead");
  thead.append(head);
  table.append(thead);
  const tbody = node("tbody");
  for (const row of rows) {
    const tr = node("tr");
    [
      timestamp(row.timestamp),
      row.seriesId,
      `${usable(row) ? number(row.value) : "Unknown"} ${row.unit}`,
      `${row.quality} / ${coverage(row.coverage)}`,
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
  incidents = [];
  selectedIncident = null;
  text("connection", message);
  drawOverview();
  text("incident-status", "Unknown — incident source unavailable.");
  $("incidents").replaceChildren();
  chart($("feed-chart"), null);
  chart($("diagnostic-chart"), null);
}
async function refresh(scope = "all") {
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
              ? `REPLAY · evaluated at ${params.asOf}`
              : "Authorized Fabric mining read · simulation provenance is provided by the backend.",
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
  if (scope === "all" || scope === "detail")
    tasks.push(
      (async () => {
        try {
          const data = await reads.read("incidents", {
            plantId: params.plantId,
            runId: params.runId,
            ...(mode === "replay" ? { asOf: params.asOf } : {}),
          });
          if (!current()) return;
          if (
            !sameScope(data, params.runId, catalogVersion) ||
            !validAsOf(data.asOf, params.asOf, mode === "replay") ||
            !Array.isArray(data.incidents) ||
            data.incidents.length > 20 ||
            data.incidents.some(
              (item) =>
                !catalog.modules.some((module) => module.id === item.moduleId) ||
                !Array.isArray(item.evidence) ||
                !Array.isArray(item.affectedModuleIds) ||
                !["feed", "density", "vibration", "water-energy"].includes(item.metric) ||
                !["warning", "high"].includes(item.severity) ||
                !["verified", "unverified"].includes(item.verification) ||
                typeof item.ruleId !== "string" ||
                typeof item.scopeId !== "string" ||
                !Number.isFinite(Date.parse(item.raisedAt)) ||
                !validIncidentWindows(item) ||
                item.affectedModuleIds.some(
                  (id) => !catalog.modules.some((module) => module.id === id),
                ) ||
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
          selectedIncident = refreshedIncidentSelection(selectedIncident, incidents);
          drawIncidents();
          drawDrawer();
        } catch (error) {
          if (current()) {
            incidents = [];
            selectedIncident = null;
            $("incidents").replaceChildren();
            text("incident-status", error.message);
            drawDrawer();
          }
        }
      })(),
      (async () => {
        try {
          const data = await reads.read("compare-lines", { ...params, metric: "feed" });
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
          const data = await reads.read("trends", { ...params, moduleId, metric });
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
    if (
      context.approvedRun &&
      !sameScope(context.approvedRun, context.approvedRun.runId, catalogVersion)
    )
      throw new Error("Approved run does not match the selected plant/catalog.");
    const url = authorizedFabricUrl(context.assistant.fabricUrl);
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
  reads.abort();
  polling.stop();
}
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
    text(
      "geometry-status",
      `3D unavailable: ${error.message} Top view and object list remain available.`,
    );
  }
} catch (error) {
  text("geometry-status", error.message);
  clearReadState("Mining catalog prerequisite unavailable. No telemetry or equipment is invented.");
}
