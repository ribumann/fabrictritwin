const elements = {
  athleteIdInput: document.getElementById("athlete-id"),
  raceIdInput: document.getElementById("race-id"),
  contextForm: document.getElementById("context-form"),
  banner: document.getElementById("banner"),
  streamStatus: document.getElementById("stream-status"),
  assistantPanelChip: document.getElementById("assistant-panel-chip"),
  mcpPanelChip: document.getElementById("mcp-panel-chip"),
  reportStatus: document.getElementById("report-status"),
  reportMessage: document.getElementById("powerbi-message"),
  reportContainer: document.getElementById("powerbi-container"),
  analysesStatus: document.getElementById("analyses-status"),
  analysesList: document.getElementById("analyses-list"),
  alertsStatus: document.getElementById("alerts-status"),
  alertsList: document.getElementById("alerts-list"),
  telemetryStatus: document.getElementById("telemetry-status"),
  telemetryList: document.getElementById("telemetry-list"),
  raceLiveStatus: document.getElementById("race-live-status"),
  raceLiveList: document.getElementById("race-live-list"),
  raceLiveSplits: document.getElementById("race-live-splits"),
  raceSummaryStatus: document.getElementById("race-summary-status"),
  raceSummaryList: document.getElementById("race-summary-list"),
  assistantStatus: document.getElementById("assistant-status"),
  assistantNote: document.getElementById("assistant-note"),
  assistantTranscript: document.getElementById("assistant-transcript"),
  assistantForm: document.getElementById("assistant-form"),
  assistantQuestionInput: document.getElementById("assistant-question"),
  assistantSubmit: document.getElementById("assistant-submit"),
  mcpStatus: document.getElementById("mcp-status"),
  mcpNote: document.getElementById("mcp-note"),
  mcpForm: document.getElementById("mcp-form"),
  mcpToolSelect: document.getElementById("mcp-tool"),
  mcpParams: document.getElementById("mcp-params"),
  mcpSubmit: document.getElementById("mcp-submit"),
  mcpOutput: document.getElementById("mcp-output"),
  provenance: document.getElementById("provenance"),
  simulationPanel: document.getElementById("simulation-panel"),
  simulationForm: document.getElementById("simulation-form"),
  simulationStatus: document.getElementById("simulation-status"),
  simulationNote: document.getElementById("simulation-note"),
  simulationFeedback: document.getElementById("simulation-feedback"),
  simulationCooldown: document.getElementById("simulation-cooldown"),
  simulationProgress: document.getElementById("simulation-progress"),
  simulationDiscipline: document.getElementById("simulation-discipline"),
  startSession: document.getElementById("start-session"),
  startRace: document.getElementById("start-race"),
  cancelSimulation: document.getElementById("cancel-simulation"),
  sessionSummary: document.getElementById("session-summary"),
  historyPanel: document.getElementById("history-panel"),
  historyChart: document.getElementById("history-chart"),
  historyTable: document.getElementById("history-table"),
  historyStatus: document.getElementById("history-status"),
};

const state = {
  athleteId: "",
  raceId: "",
  assistantPanelAvailable: false,
  directMcpPanelAvailable: false,
  stream: null,
  latestMetric: null,
  latestSessionStatus: null,
  recentRaceSplits: [],
  raceSnapshot: null,
  assistantTranscript: [],
  selectedMcpTool: "query_recovery_trend",
  mcpDays: "7",
  mcpRaceId: "",
  synthetic: false,
  runtime: null,
  simulationPending: false,
  retryUntil: 0,
  statusTimer: null,
  previousRunStatus: null,
};

const MCP_TOOL_METADATA = {
  query_recovery_trend: {
    label: "Recovery trend",
  },
  query_training_load: {
    label: "Training load",
  },
  query_active_alerts: {
    label: "Active alerts",
  },
  query_race_splits: {
    label: "Race splits",
  },
};

function setDefinitionList(target, entries) {
  if (!entries.length) {
    target.innerHTML = '<div class="empty-state">No data available.</div>';
    return;
  }

  target.innerHTML = entries
    .map(
      ([label, value]) =>
        `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? "—")}</dd>`,
    )
    .join("");
}

function setList(target, items, emptyText) {
  if (!items.length) {
    target.innerHTML = `<li class="empty-state">${escapeHtml(emptyText)}</li>`;
    return;
  }

  target.innerHTML = items.join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Renders a JSON value as an indented, syntax-colored tree instead of a flat
// JSON.stringify dump, so direct MCP query results are actually readable.
function jsonValueToHtml(value, depth) {
  const pad = "  ".repeat(depth);
  const padInner = "  ".repeat(depth + 1);
  if (value === null) {
    return '<span class="json-null">null</span>';
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return `<span class="json-${typeof value}">${value}</span>`;
  }
  if (typeof value === "string") {
    return `<span class="json-string">"${escapeHtml(value)}"</span>`;
  }
  if (Array.isArray(value)) {
    if (!value.length) {
      return '<span class="json-punct">[]</span>';
    }
    const items = value
      .map((item) => `${padInner}${jsonValueToHtml(item, depth + 1)}`)
      .join('<span class="json-punct">,</span>\n');
    return `<span class="json-punct">[</span>\n${items}\n${pad}<span class="json-punct">]</span>`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (!keys.length) {
      return '<span class="json-punct">{}</span>';
    }
    const entries = keys
      .map(
        (key) =>
          `${padInner}<span class="json-key">"${escapeHtml(key)}"</span><span class="json-punct">: </span>${jsonValueToHtml(
            value[key],
            depth + 1,
          )}`,
      )
      .join('<span class="json-punct">,</span>\n');
    return `<span class="json-punct">{</span>\n${entries}\n${pad}<span class="json-punct">}</span>`;
  }
  return escapeHtml(String(value));
}

function renderJsonOutput(target, value) {
  if (typeof value === "string") {
    target.textContent = value;
    return;
  }
  target.innerHTML = jsonValueToHtml(value, 0);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Domain acronyms that should stay upper-case in a humanized label (e.g. "hrv" ->
// "HRV", not "Hrv").
const MCP_LABEL_ACRONYMS = new Set(["hrv", "acwr", "rpe", "id"]);

// Converts an API field name into a readable label, e.g. "sleepDebtMinutes" ->
// "Sleep debt minutes", "acwr" -> "ACWR".
function humanizeKey(key) {
  const spaced = String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
  const words = spaced
    .split(" ")
    .map((word) => (MCP_LABEL_ACRONYMS.has(word) ? word.toUpperCase() : word));
  return words.join(" ").replace(/^./, (char) => char.toUpperCase());
}

function formatMcpCellValue(value) {
  if (value === null || value === undefined) {
    return "—";
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : formatNumber(value);
  }
  if (typeof value === "string") {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) ? formatTimestamp(value) : value;
  }
  return JSON.stringify(value);
}

function renderMcpTable(records) {
  if (!records.length) {
    return '<div class="empty-state">No rows returned.</div>';
  }
  const columns = [...new Set(records.flatMap((record) => Object.keys(record)))];
  const head = columns.map((column) => `<th>${escapeHtml(humanizeKey(column))}</th>`).join("");
  const rows = records
    .map((record) => {
      const cells = columns
        .map((column) => `<td>${escapeHtml(formatMcpCellValue(record[column]))}</td>`)
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `<table class="mcp-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

function renderMcpKeyValue(entries) {
  if (!entries.length) {
    return "";
  }
  return `<dl class="metric-list mcp-summary">${entries
    .map(
      ([key, value]) =>
        `<dt>${escapeHtml(humanizeKey(key))}</dt><dd>${escapeHtml(formatMcpCellValue(value))}</dd>`,
    )
    .join("")}</dl>`;
}

function renderMcpError(error) {
  const message =
    typeof error === "string" ? error : (error?.message ?? JSON.stringify(error));
  const code = isPlainObject(error) ? error.code : null;
  return `<div class="mcp-error">${
    code ? `<span class="mcp-error-code">${escapeHtml(String(code))}</span>` : ""
  }${escapeHtml(message)}</div>`;
}

// Renders an MCP tool result as a readable table/summary rather than a flat JSON
// dump: scalar fields (e.g. training phase, projected finish) render as a small
// key/value summary, the first array-of-records field renders as a table, and
// error shapes render as a callout. Anything that doesn't fit this pattern falls
// back to the syntax-highlighted JSON tree.
function renderMcpResult(target, value) {
  if (typeof value === "string") {
    target.textContent = value;
    return;
  }

  if (isPlainObject(value) && "error" in value) {
    target.innerHTML = renderMcpError(value.error);
    return;
  }

  if (Array.isArray(value)) {
    target.innerHTML = value.every(isPlainObject)
      ? renderMcpTable(value)
      : `<div class="json-tree">${jsonValueToHtml(value, 0)}</div>`;
    return;
  }

  if (isPlainObject(value)) {
    const listKey = Object.keys(value).find((key) => Array.isArray(value[key]));
    if (listKey) {
      const records = value[listKey];
      const summaryHtml = renderMcpKeyValue(
        Object.entries(value).filter(([key]) => key !== listKey),
      );
      const tableHtml = records.every(isPlainObject)
        ? renderMcpTable(records)
        : `<div class="json-tree">${jsonValueToHtml(records, 0)}</div>`;
      target.innerHTML = `${summaryHtml}${tableHtml}`;
      return;
    }

    const entries = Object.entries(value);
    if (entries.every(([, entryValue]) => !isPlainObject(entryValue) && !Array.isArray(entryValue))) {
      target.innerHTML =
        renderMcpKeyValue(entries) || '<div class="empty-state">No data returned.</div>';
      return;
    }
  }

  target.innerHTML = `<div class="json-tree">${jsonValueToHtml(value, 0)}</div>`;
}

function formatNumber(value, digits = 2) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(digits)
    : "—";
}

function formatPercent(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toFixed(1)}%`
    : "—";
}

function formatSeconds(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "—";
  }

  const rounded = Math.round(value);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;
  return [hours, minutes, seconds]
    .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, "0")))
    .join(":");
}

function formatTimestamp(value) {
  if (!value) {
    return "—";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

async function fetchJson(path) {
  const response = await fetch(path);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      body?.error?.message ??
      `Request to ${path} failed with status ${response.status}.`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function postJson(path, payload, options = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    redirect: options.redirect ?? "follow",
  });
  const rawBody = await response.text();
  let parsedBody = {};
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    parsedBody = rawBody;
  }

  return { response, rawBody, parsedBody };
}

function renderAssistantTranscript() {
  setList(
    elements.assistantTranscript,
    state.assistantTranscript.map((turn) => {
      const groundedOn = Array.isArray(turn.groundedOn)
        ? turn.groundedOn
            .map((source) => `<span class="badge">${escapeHtml(source)}</span>`)
            .join("")
        : "";
      const respondedInMs =
        typeof turn.respondedInMs === "number"
          ? `<small class="muted">${escapeHtml(`${turn.respondedInMs} ms`)}</small>`
          : "";
      return `
        <li>
          <div class="transcript-role">You</div>
          <div class="transcript-message">${escapeHtml(turn.question)}</div>
          <div class="transcript-role">Assistant</div>
          <div class="transcript-message${turn.isError ? " error" : ""}">${escapeHtml(turn.answer)}</div>
          ${
            groundedOn || respondedInMs
              ? `<div class="assistant-meta">${groundedOn}${respondedInMs}</div>`
              : ""
          }
        </li>
      `;
    }),
    "No questions yet.",
  );
  elements.assistantTranscript.scrollTop = elements.assistantTranscript.scrollHeight;
}

function resetAssistantTranscript() {
  state.assistantTranscript = [];
  renderAssistantTranscript();
}

function setAssistantBusy(isBusy) {
  elements.assistantQuestionInput.disabled =
    isBusy || !state.assistantPanelAvailable || !state.athleteId;
  elements.assistantSubmit.disabled =
    isBusy || !state.assistantPanelAvailable || !state.athleteId;
}

function updateAssistantAvailability() {
  const available = state.assistantPanelAvailable;
  elements.assistantPanelChip.textContent = available ? "Available" : "Unavailable";
  elements.assistantStatus.textContent = available
    ? state.athleteId
      ? "Ready"
      : "Athlete ID required"
    : "Unavailable";
  elements.assistantNote.textContent = available
    ? state.athleteId
      ? "Ask the Athlete Assistant a grounded question about the selected athlete."
      : "Select an athlete to ask the Athlete Assistant a grounded question."
    : "Athlete Assistant is not enabled for this cockpit deployment.";
  if (state.synthetic) {
    elements.assistantStatus.textContent = available ? "Deterministic demo" : "Unavailable";
    elements.assistantPanelChip.textContent = available ? "Deterministic demo" : "Unavailable";
    elements.assistantNote.textContent =
      "Deterministic explanation of synthetic data, not a Foundry model or LLM. No medical advice, cloud tools, or live athlete access.";
  }
  elements.assistantForm.hidden = !available;
  elements.assistantTranscript.hidden = !available;
  elements.assistantForm.closest(".card").classList.toggle("panel-disabled", !available);
  setAssistantBusy(false);
}

function renderMcpParameterFields() {
  const tool = state.selectedMcpTool;
  if (tool === "query_recovery_trend") {
    elements.mcpParams.innerHTML = `
      <label class="panel-field">
        Days
        <input id="mcp-days" name="days" type="number" min="1" step="1" value="${escapeHtml(
          state.mcpDays || "7",
        )}" />
      </label>
    `;
    const input = document.getElementById("mcp-days");
    input.addEventListener("input", () => {
      state.mcpDays = input.value;
    });
    return;
  }

  if (tool === "query_race_splits") {
    elements.mcpParams.innerHTML = `
      <label class="panel-field">
        Race ID
        <input
          id="mcp-race-id"
          name="raceId"
          type="text"
          autocomplete="off"
          value="${escapeHtml(state.mcpRaceId || state.raceId || "")}"
        />
      </label>
    `;
    const input = document.getElementById("mcp-race-id");
    input.addEventListener("input", () => {
      state.mcpRaceId = input.value;
    });
    return;
  }

  elements.mcpParams.innerHTML = `
    <div class="empty-state">No additional parameters for ${escapeHtml(
      MCP_TOOL_METADATA[tool].label,
    )}.</div>
  `;
}

function resetMcpOutput() {
  elements.mcpOutput.textContent = "";
}

function setMcpBusy(isBusy) {
  elements.mcpToolSelect.disabled =
    isBusy || !state.directMcpPanelAvailable || !state.athleteId;
  elements.mcpSubmit.disabled =
    isBusy || !state.directMcpPanelAvailable || !state.athleteId;
  const paramInputs = elements.mcpParams.querySelectorAll("input, select");
  paramInputs.forEach((input) => {
    input.disabled = isBusy || !state.directMcpPanelAvailable || !state.athleteId;
  });
}

function updateMcpAvailability() {
  const available = state.directMcpPanelAvailable;
  elements.mcpPanelChip.textContent = available ? "Available" : "Unavailable";
  elements.mcpStatus.textContent = available ? (state.athleteId ? "Ready" : "Athlete ID required") : "Unavailable";
  elements.mcpNote.textContent = available
    ? state.athleteId
      ? `Run a raw MCP tool call for athlete ${state.athleteId}.`
      : "Select an athlete to run a raw MCP tool query."
    : "Direct MCP queries are not enabled for this cockpit deployment.";
  elements.mcpForm.hidden = !available;
  elements.mcpOutput.hidden = !available;
  elements.mcpForm.closest(".card").classList.toggle("panel-disabled", !available);
  renderMcpParameterFields();
  setMcpBusy(false);
}

function readMcpArguments() {
  const tool = state.selectedMcpTool;
  const args = {
    athleteId: state.athleteId,
  };

  if (tool === "query_recovery_trend") {
    const days = Number.parseInt(state.mcpDays || "7", 10);
    if (Number.isFinite(days) && days > 0) {
      args.days = days;
    }
  }

  if (tool === "query_race_splits") {
    const raceId = (state.mcpRaceId || state.raceId || "").trim();
    if (raceId) {
      args.raceId = raceId;
    }
  }

  return args;
}

function validateMcpArguments(args) {
  if (state.selectedMcpTool === "query_race_splits" && !args.raceId) {
    return "Race ID is required for the race splits tool.";
  }

  return null;
}

function describeAssistantFailure(response, parsedBody) {
  if (parsedBody?.error?.code?.startsWith("assistant_") &&
    typeof parsedBody.error.message === "string") {
    return parsedBody.error.message;
  }
  if (response.status === 403) {
    return "Not authorized for this athlete.";
  }

  if (response.status === 503) {
    return "Athlete Assistant is temporarily unavailable right now — core dashboards are unaffected.";
  }
  return (
    parsedBody?.error?.message ??
    `Athlete Assistant request failed with status ${response.status}.`
  );
}

function renderAssistantSignIn(required) {
  let recovery = document.getElementById("assistant-auth-recovery");
  if (!recovery) {
    recovery = document.createElement("p");
    recovery.id = "assistant-auth-recovery";
    recovery.className = "callout";
    recovery.setAttribute("role", "status");
    const signIn = document.createElement("a");
    signIn.textContent = "Sign in again (opens a new tab)";
    signIn.href = "/.auth/login/aad?post_login_redirect_uri=%2F";
    signIn.target = "_blank";
    signIn.rel = "noopener noreferrer";
    recovery.append(signIn, ". Then return here and select Ask. Your question stays in this tab.");
    elements.assistantNote.after(recovery);
  }
  recovery.hidden = !required;
}

function setQueryParameters() {
  const url = new URL(window.location.href);
  if (state.athleteId) {
    url.searchParams.set("athleteId", state.athleteId);
  } else {
    url.searchParams.delete("athleteId");
  }
  if (state.raceId) {
    url.searchParams.set("raceId", state.raceId);
  } else {
    url.searchParams.delete("raceId");
  }
  window.history.replaceState({}, "", url);
}

async function loadContext() {
  const params = new URLSearchParams(window.location.search);
  const query = new URLSearchParams();
  if (params.get("athleteId")) {
    query.set("athleteId", params.get("athleteId"));
  }
  if (params.get("raceId")) {
    query.set("raceId", params.get("raceId"));
  }

  const context = await fetchJson(
    `/api/context${query.toString() ? `?${query.toString()}` : ""}`,
  );
  state.athleteId = context.selectedAthleteId ?? "";
  state.raceId = context.selectedRaceId ?? "";
  state.assistantPanelAvailable = context.assistantPanelAvailable !== false;
  state.directMcpPanelAvailable = context.directMcpPanelAvailable !== false;
  state.synthetic = context.provenance?.source === "synthetic";
  if (state.synthetic) {
    elements.provenance.hidden = false;
    elements.provenance.textContent = `${context.provenance.label} • Account-free synthetic demo. No cloud data or Azure credentials. Seed ${context.provenance.seed}; reference ${context.provenance.referenceDate}.`;
    elements.contextForm.hidden = true;
    elements.reportContainer.closest(".card").hidden = true;
    elements.mcpForm.closest(".card").hidden = true;
    document.getElementById("assistant-heading").textContent = "Synthetic assistant demonstration";
    renderHistory(context.history ?? []);
    state.runtime = context.runtime ?? null;
    elements.simulationNote.textContent =
      "One shared run, no queue; at most two starts per minute across visitors. Runs are compressed demonstrations. This single backend stores runs in memory; restart resets them. Cancelled or failed races have no finish summary.";
  }
  elements.simulationPanel.hidden = !state.athleteId;
  updateSimulationControls();
  state.mcpRaceId = state.raceId || state.mcpRaceId;
  elements.athleteIdInput.value = state.athleteId;
  elements.raceIdInput.value = state.raceId;
  updateAssistantAvailability();
  updateMcpAvailability();
  setQueryParameters();
}

function renderGapBanner(payload) {
  if (!payload?.gapDetected || !Array.isArray(payload.activeGaps) || !payload.activeGaps.length) {
    elements.banner.hidden = true;
    elements.banner.textContent = "";
    return;
  }

  const latestGap = payload.activeGaps[payload.activeGaps.length - 1];
  elements.banner.hidden = false;
  elements.banner.textContent =
    `Data gap detected: ${latestGap.gapDays} missed day(s) between ${latestGap.fromDate} and ${latestGap.toDate}. Last generated date: ${payload.lastGeneratedDate ?? "unknown"}.`;
}

async function refreshDataGapBanner() {
  if (state.synthetic) return;
  if (!state.athleteId) {
    renderGapBanner({ gapDetected: false, activeGaps: [] });
    return;
  }

  try {
    renderGapBanner(
      await fetchJson(`/api/data-gaps/${encodeURIComponent(state.athleteId)}`),
    );
  } catch (error) {
    elements.banner.hidden = false;
    elements.banner.textContent = `Unable to load data-gap status: ${error.message}`;
  }
}

async function refreshAnalyses() {
  if (!state.athleteId) {
    elements.analysesStatus.textContent = "Athlete ID required";
    setDefinitionList(elements.analysesList, []);
    return;
  }

  elements.analysesStatus.textContent = "Loading…";
  try {
    const analyses = await fetchJson(
      `/api/analyses/${encodeURIComponent(state.athleteId)}`,
    );
    setDefinitionList(elements.analysesList, [
      ["Acute:Chronic ratio", formatNumber(analyses.acuteChronicWorkloadRatio)],
      ["Recovery score", formatNumber(analyses.recoveryScore)],
      ["Nutrition adequacy", formatNumber(analyses.nutritionAdequacy)],
      ["Sleep debt (min)", formatNumber(analyses.sleepDebtMinutes, 0)],
      ["Taper index", formatNumber(analyses.taperIndex)],
      ["As of", formatTimestamp(analyses.asOf)],
    ]);
    elements.analysesStatus.textContent = "Ready";
  } catch (error) {
    elements.analysesStatus.textContent = "Unavailable";
    setDefinitionList(elements.analysesList, [["Error", error.message]]);
  }
}

function renderAlertItem(alert) {
  return `
    <li>
      <span class="alert-type">${escapeHtml(alert.type)}</span>
      <div>${escapeHtml(alert.detail)}</div>
      <small class="muted">${escapeHtml(formatTimestamp(alert.raisedAt))}</small>
    </li>
  `;
}

async function refreshAlerts() {
  if (!state.athleteId) {
    elements.alertsStatus.textContent = "Athlete ID required";
    setList(elements.alertsList, [], "No athlete selected.");
    return;
  }

  elements.alertsStatus.textContent = "Loading…";
  try {
    const payload = await fetchJson(
      `/api/alerts/${encodeURIComponent(state.athleteId)}?active=true`,
    );
    setList(
      elements.alertsList,
      (payload.alerts ?? []).map(renderAlertItem),
      "No active alerts.",
    );
    elements.alertsStatus.textContent = `${payload.alerts?.length ?? 0} active`;
  } catch (error) {
    elements.alertsStatus.textContent = "Unavailable";
    setList(elements.alertsList, [], error.message);
  }
}

function renderTelemetry() {
  const metric = state.latestMetric?.metric;
  setDefinitionList(elements.telemetryList, [
    ["Session ID", state.latestMetric?.sessionId ?? "—"],
    ["Heart rate", metric ? `${metric.heartRate} bpm` : "—"],
    ["Power", metric?.power == null ? "—" : `${metric.power} W`],
    ["Pace", metric ? `${formatNumber(metric.pace)} sec/km` : "—"],
    ["Cadence", metric ? `${metric.cadence} rpm` : "—"],
    ["Timestamp", metric ? formatTimestamp(metric.timestamp) : "—"],
    ["Session status", state.latestSessionStatus ?? "Waiting for a session"],
  ]);
}

function renderLiveRace() {
  const live = state.raceSnapshot;
  const latestSplit = live?.latestSplit ?? state.recentRaceSplits[0] ?? null;

  setDefinitionList(elements.raceLiveList, [
    ["Race", live?.name ?? state.raceId ?? "—"],
    ["Status", live?.status ?? (latestSplit ? "live" : "waiting")],
    ["Distance", live?.distance ?? "—"],
    ["Progress", formatPercent(live?.progressPct)],
    ["Projected finish", formatSeconds(live?.projectedFinishTimeSeconds)],
    ["Current leg", latestSplit?.leg ?? "—"],
    ["Last update", formatTimestamp(live?.lastUpdatedAt ?? latestSplit?.timestamp)],
  ]);

  setList(
    elements.raceLiveSplits,
    state.recentRaceSplits.slice(0, 5).map(
      (split) => `
        <li>
          <strong>${escapeHtml(split.leg)}</strong> · ${escapeHtml(
            formatTimestamp(split.timestamp),
          )}<br />
          Pace ${escapeHtml(formatNumber(split.currentPaceSecPerKm))} sec/km · HR ${escapeHtml(
            split.currentHeartRate,
          )} bpm · ${escapeHtml(Math.round(split.distanceCoveredMeters))} m
        </li>
      `,
    ),
    "No live race splits received yet.",
  );
}

async function refreshRaceLive() {
  if (!state.raceId) {
    elements.raceLiveStatus.textContent = "Race ID required";
    state.raceSnapshot = null;
    renderLiveRace();
    return;
  }

  elements.raceLiveStatus.textContent = "Loading…";
  try {
    state.raceSnapshot = await fetchJson(
      `/api/race/${encodeURIComponent(state.raceId)}/live`,
    );
    renderLiveRace();
    elements.raceLiveStatus.textContent = "Ready";
  } catch (error) {
    elements.raceLiveStatus.textContent = "Unavailable";
    state.raceSnapshot = null;
    renderLiveRace();
    setDefinitionList(elements.raceLiveList, [["Error", error.message]]);
  }
}

// Renders the post-race summary as a row of KPI-style stat tiles (label above a
// large value) instead of a left/right definition list, so mixed-length labels
// like "Pacing evenness σ" and short ones like "Status" stay visually aligned.
function renderRaceSummaryStats(summary) {
  const predicted = summary?.predictedFinishTimeSeconds;
  const actual = summary?.actualFinishTimeSeconds;
  const hasDelta = typeof predicted === "number" && typeof actual === "number";
  const deltaSeconds = hasDelta ? Math.round(actual - predicted) : null;

  const tiles = [
    { label: "Race", value: summary?.name ?? state.raceId ?? "—" },
    { label: "Status", value: summary?.status ?? "—" },
    { label: "Predicted finish", value: formatSeconds(predicted) },
    { label: "Actual finish", value: formatSeconds(actual) },
    {
      label: "Prediction delta",
      value: deltaSeconds == null ? "—" : `${deltaSeconds > 0 ? "+" : ""}${deltaSeconds} sec`,
      tone: deltaSeconds == null ? null : deltaSeconds <= 0 ? "good" : "warn",
    },
    { label: "Pacing evenness σ", value: formatNumber(summary?.pacingEvennessStdDev) },
    { label: "Completed at", value: formatTimestamp(summary?.completedAt) },
  ];

  elements.raceSummaryList.innerHTML = tiles
    .map(
      (tile) => `
        <div class="stat-tile">
          <span class="stat-label">${escapeHtml(tile.label)}</span>
          <strong class="stat-value"${
            tile.tone ? ` data-tone="${escapeHtml(tile.tone)}"` : ""
          }>${escapeHtml(tile.value)}</strong>
        </div>`,
    )
    .join("");
}

async function refreshRaceSummary() {
  if (!state.raceId) {
    elements.raceSummaryStatus.textContent = "Race ID required";
    elements.raceSummaryList.innerHTML = '<div class="empty-state">No data available.</div>';
    return;
  }

  elements.raceSummaryStatus.textContent = "Loading…";
  try {
    const summary = await fetchJson(
      `/api/race/${encodeURIComponent(state.raceId)}/summary`,
    );
    renderRaceSummaryStats(summary);
    elements.raceSummaryStatus.textContent = "Ready";
  } catch (error) {
    elements.raceSummaryStatus.textContent = error.status === 404 ? "Waiting for completion" : "Unavailable";
    elements.raceSummaryList.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

let powerBiPanel;
async function refreshPowerBi() {
  if (state.synthetic) return;
  powerBiPanel ??= window.createPowerBiPanel({
    container: elements.reportContainer,
    status: elements.reportStatus,
    message: elements.reportMessage,
  });
  await powerBiPanel.refresh();
}

function disconnectStream() {
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
}

function connectStream() {
  disconnectStream();
  state.latestMetric = null;
  state.latestSessionStatus = null;
  state.recentRaceSplits = [];
  renderTelemetry();
  renderLiveRace();

  if (!state.athleteId) {
    elements.streamStatus.textContent = "Athlete ID required";
    return;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(
    `${protocol}//${window.location.host}/api/stream/${encodeURIComponent(state.athleteId)}`,
  );
  state.stream = socket;

  socket.addEventListener("open", () => {
    elements.streamStatus.textContent = "Connected";
  });

  socket.addEventListener("message", (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      elements.streamStatus.textContent = "Invalid stream message";
      return;
    }
    if (payload.type === "metric") {
      state.latestMetric = payload;
      state.latestSessionStatus = "live";
      elements.telemetryStatus.textContent = "Streaming";
      renderTelemetry();
      return;
    }

    if (payload.type === "sessionStatus") {
      state.latestSessionStatus = payload.status;
      elements.telemetryStatus.textContent = payload.status;
      renderTelemetry();
      return;
    }

    if (payload.type === "raceSplit") {
      state.recentRaceSplits = [
        payload.split,
        ...state.recentRaceSplits.filter(
          (candidate) => candidate.timestamp !== payload.split.timestamp,
        ),
      ].slice(0, 8);
      elements.raceLiveStatus.textContent = payload.split.isFinish
        ? "Finished"
        : "Streaming";
      renderLiveRace();
      if (payload.split.isFinish) {
        void refreshRaceSummary();
      }
      return;
    }

    if (payload.type === "alert") {
      void refreshAlerts();
      void refreshAnalyses();
      return;
    }

    if (payload.type === "proxyError") {
      elements.streamStatus.textContent = "Proxy error";
    }
  });

  socket.addEventListener("close", () => {
    if (state.stream === socket) {
      elements.streamStatus.textContent = "Disconnected";
      state.stream = null;
    }
  });

  socket.addEventListener("error", () => {
    elements.streamStatus.textContent = "Error";
  });
}

async function refreshCockpit() {
  await Promise.allSettled([
    refreshPowerBi(),
    refreshAnalyses(),
    refreshAlerts(),
    refreshDataGapBanner(),
    refreshRaceLive(),
    refreshRaceSummary(),
  ]);
  connectStream();
  if (state.synthetic) {
    await refreshSimulationStatus();
    state.statusTimer ??= setInterval(refreshSimulationStatus, 2_000);
  }
}

function renderHistory(history) {
  elements.historyPanel.hidden = false;
  const points = history.filter((point) =>
    typeof point.date === "string" && Number.isFinite(point.trainingLoad),
  ).slice(-112);
  elements.historyStatus.textContent = `${points.length} training days`;
  if (!points.length) {
    elements.historyChart.textContent = "Training history is unavailable.";
    return;
  }
  const maximum = Math.max(1, ...points.map((point) => point.trainingLoad));
  const width = Math.max(240, Math.min(800, elements.historyChart.clientWidth || 800));
  const firstDate = Date.parse(points[0].date);
  const dateSpan = Math.max(1, Date.parse(points.at(-1).date) - firstDate);
  const coordinates = points.map((point) =>
    `${55 + (Date.parse(point.date) - firstDate) / dateSpan * (width - 70)},${205 - point.trainingLoad / maximum * 165}`,
  ).join(" ");
  elements.historyChart.innerHTML = `
    <svg viewBox="0 0 ${width} 255" role="img" aria-label="Daily training load over ${points.length} synthetic training days">
      <title>Daily synthetic training load</title>
      <line class="chart-axis" x1="55" y1="40" x2="55" y2="205" />
      <line class="chart-axis" x1="55" y1="205" x2="${width - 15}" y2="205" />
      <text x="5" y="45">${escapeHtml(Math.round(maximum))}</text>
      <text x="25" y="210">0</text>
      <text x="55" y="235">${escapeHtml(points[0].date)}</text>
      <text x="${width - 15}" y="235" text-anchor="end">${escapeHtml(points.at(-1).date)}</text>
      <text x="${width / 2}" y="25" text-anchor="middle">Training load</text>
      <polyline class="chart-line" points="${coordinates}" />
    </svg>`;
  elements.historyTable.innerHTML = renderMcpTable(points);
}

function updateSimulationControls() {
  const running = state.runtime?.status === "running";
  const retrySeconds = Math.max(0, Math.ceil((state.retryUntil - Date.now()) / 1_000));
  const disabled = state.simulationPending || running || retrySeconds > 0;
  elements.startSession.disabled = disabled || !state.athleteId;
  elements.startRace.disabled = disabled || !state.raceId;
  elements.simulationDiscipline.disabled = disabled;
  elements.cancelSimulation.hidden = !state.synthetic || !running;
  elements.cancelSimulation.disabled = state.simulationPending;
  elements.simulationStatus.textContent = state.simulationPending ? "Submitting…" : state.runtime?.status ?? "Ready";
  elements.simulationCooldown.textContent = retrySeconds
    ? `Start controls available in ${retrySeconds}s. The shared two-starts-per-minute limit applies to all visitors.`
    : "";
  elements.simulationProgress.hidden = !running;
  elements.simulationProgress.value = state.runtime?.progressPct ?? 0;
}

async function refreshSimulationStatus() {
  try {
    const payload = await fetchJson("/api/demo/status");
    state.runtime = payload.runtime ?? payload;
    const identity = `${state.runtime.runId}:${state.runtime.status}`;
    const changed = identity !== state.previousRunStatus;
    state.previousRunStatus = identity;
    if (state.runtime.retryAfterSeconds > 0) {
      state.retryUntil = Date.now() + state.runtime.retryAfterSeconds * 1_000;
    }
    if (changed && ["completed", "failed", "cancelled"].includes(state.runtime.status)) {
      elements.simulationFeedback.textContent =
        state.runtime.status === "completed"
          ? "Run completed. Telemetry and the summary below are ready."
          : `Run ${state.runtime.status}. ${state.runtime.error ?? "You can start another run when the cooldown ends."}`;
      await Promise.all([refreshRaceLive(), refreshRaceSummary(), refreshAnalyses(), refreshAlerts()]);
    }
    if (state.runtime.kind === "session" && ["failed", "cancelled"].includes(state.runtime.status)) {
      state.latestSessionStatus = state.runtime.status;
      elements.telemetryStatus.textContent = state.runtime.status;
      renderTelemetry();
    }
    if (state.runtime.kind === "session" && state.runtime.summary) {
      const summary = state.runtime.summary;
      setDefinitionList(elements.sessionSummary, [
        ["Session", summary.session?.discipline ?? "Session"],
        ["Status", state.runtime.status],
        ["Simulated duration", `${summary.session?.plannedDurationMinutes ?? "—"} min`],
        ["Telemetry samples", summary.sampleCount ?? "—"],
        ["Final heart rate", summary.latestMetric ? `${summary.latestMetric.heartRate} bpm` : "—"],
        ["Final power", summary.latestMetric?.power == null ? "—" : `${summary.latestMetric.power} W`],
      ]);
      if (summary.latestMetric) {
        state.latestMetric = { sessionId: summary.session?.sessionId, metric: summary.latestMetric };
        state.latestSessionStatus = state.runtime.status;
        elements.telemetryStatus.textContent = state.runtime.status;
        renderTelemetry();
      }
    }
    updateSimulationControls();
  } catch (error) {
    elements.simulationStatus.textContent = "Status unavailable";
    elements.simulationFeedback.textContent = `Cannot verify the shared run: ${error.message}. Refresh to reconnect; do not assume it stopped.`;
    elements.startSession.disabled = true;
    elements.startRace.disabled = true;
  }
}

async function triggerSimulation(action) {
  if (state.simulationPending) return;
  state.simulationPending = true;
  elements.simulationFeedback.textContent = "";
  updateSimulationControls();
  try {
    const body = action === "cancel" ? { runId: state.runtime?.runId }
      : action === "trigger-race" ? { athleteId: state.athleteId, raceId: state.raceId }
      : { athleteId: state.athleteId, discipline: elements.simulationDiscipline.value };
    const { response, parsedBody } = await postJson(`/api/simulate/${action}`, body);
    if (!response.ok) {
      const retry = Number(response.headers.get("retry-after"));
      if (retry > 0) state.retryUntil = Date.now() + retry * 1_000;
      throw new Error(parsedBody?.error?.message ?? `Request failed (${response.status}).`);
    }
    elements.simulationFeedback.textContent = action === "cancel"
      ? "Cancellation requested. Waiting for the server's terminal status."
      : `Run started. ${state.synthetic ? "Watch the telemetry below." : "Live controls require seeded history and backend authorization."}`;
    if (action !== "cancel") {
      state.latestMetric = null;
      state.latestSessionStatus = null;
      state.recentRaceSplits = [];
      elements.sessionSummary.innerHTML = "";
      renderTelemetry();
      await refreshRaceSummary();
    }
  } catch (error) {
    elements.simulationFeedback.textContent = error.message;
  } finally {
    state.simulationPending = false;
    if (state.synthetic) await refreshSimulationStatus();
    else updateSimulationControls();
  }
}

elements.simulationForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void triggerSimulation("trigger-session");
});
elements.startRace.addEventListener("click", () => void triggerSimulation("trigger-race"));
elements.cancelSimulation.addEventListener("click", () => void triggerSimulation("cancel"));

elements.contextForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.athleteId = elements.athleteIdInput.value.trim();
  state.raceId = elements.raceIdInput.value.trim();
  if (!state.mcpRaceId || state.selectedMcpTool === "query_race_splits") {
    state.mcpRaceId = state.raceId;
  }
  resetAssistantTranscript();
  resetMcpOutput();
  updateAssistantAvailability();
  updateMcpAvailability();
  setQueryParameters();
  void refreshCockpit();
});

elements.assistantForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = elements.assistantQuestionInput.value.trim();
  if (!question || !state.assistantPanelAvailable || !state.athleteId) {
    return;
  }

  setAssistantBusy(true);
  elements.assistantStatus.textContent = "Thinking…";

  try {
    const payload = {
      athleteId: state.athleteId,
      question,
    };
    const { response, parsedBody } = state.synthetic
      ? await postJson("/api/assistant", payload)
      : await window.TriatwinAssistantSession.postQuestion(postJson, payload);

    renderAssistantSignIn(response.status === 401);
    if (!response.ok) {
      state.assistantTranscript.push({
        question,
        answer: describeAssistantFailure(response, parsedBody),
        groundedOn: [],
        respondedInMs: null,
        isError: true,
      });
      while (state.assistantTranscript.length > 30) state.assistantTranscript.shift();
      elements.assistantStatus.textContent = response.status === 401 ? "Sign-in required" : "Unavailable";
      renderAssistantTranscript();
      return;
    }

    state.assistantTranscript.push({
      question,
      answer: parsedBody.answer ?? "No answer returned.",
      groundedOn: Array.isArray(parsedBody.groundedOn) ? parsedBody.groundedOn : [],
      respondedInMs:
        typeof parsedBody.respondedInMs === "number" ? parsedBody.respondedInMs : null,
      isError: false,
    });
    while (state.assistantTranscript.length > 30) state.assistantTranscript.shift();
    elements.assistantStatus.textContent = "Answered";
    elements.assistantQuestionInput.value = "";
    renderAssistantTranscript();
  } catch (error) {
    state.assistantTranscript.push({
      question,
      answer:
        "Athlete Assistant is temporarily unavailable right now — core dashboards are unaffected.",
      groundedOn: [],
      respondedInMs: null,
      isError: true,
    });
    while (state.assistantTranscript.length > 30) state.assistantTranscript.shift();
    elements.assistantStatus.textContent = "Unavailable";
    renderAssistantTranscript();
    elements.assistantNote.textContent =
      error instanceof Error
        ? `Network issue: ${error.message}`
        : "Network issue while contacting the Athlete Assistant.";
  } finally {
    setAssistantBusy(false);
  }
});

elements.mcpToolSelect.addEventListener("change", () => {
  state.selectedMcpTool = elements.mcpToolSelect.value;
  renderMcpParameterFields();
  setMcpBusy(false);
});

elements.mcpForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.directMcpPanelAvailable || !state.athleteId) {
    return;
  }

  setMcpBusy(true);
  elements.mcpStatus.textContent = "Running…";

  try {
    const args = readMcpArguments();
    const validationError = validateMcpArguments(args);
    if (validationError) {
      elements.mcpStatus.textContent = "Race ID required";
      renderMcpResult(elements.mcpOutput, {
        error: {
          code: "invalid_request",
          message: validationError,
        },
      });
      return;
    }

    const { response, parsedBody, rawBody } = await postJson("/api/assistant/mcp-query", {
      tool: state.selectedMcpTool,
      arguments: args,
    });
    renderMcpResult(elements.mcpOutput, parsedBody);
    elements.mcpStatus.textContent = response.ok ? "Complete" : `Failed (${response.status})`;
    if (!response.ok && !rawBody) {
      renderMcpResult(elements.mcpOutput, {
        error: {
          code: "request_failed",
          message: `Request failed with status ${response.status}.`,
        },
      });
    }
  } catch (error) {
    elements.mcpStatus.textContent = "Unavailable";
    renderMcpResult(elements.mcpOutput, {
      error: {
        code: "network_error",
        message:
          error instanceof Error
            ? error.message
            : "Failed to reach the direct MCP query panel.",
      },
    });
  } finally {
    setMcpBusy(false);
  }
});

window.addEventListener("beforeunload", () => {
  disconnectStream();
  clearInterval(state.statusTimer);
});

// Colors the status chips/labels by meaning (good/bad/warn/busy) purely by observing
// their rendered text -- additive only, so it never touches the ~35 call sites above
// that already set these strings.
function toneForStatusText(text) {
  const trimmed = (text ?? "").trim();
  const activeMatch = trimmed.match(/^(\d+)\s*active/i);
  if (activeMatch) {
    return Number(activeMatch[1]) > 0 ? "warn" : "good";
  }
  if (/^(connected|streaming|available|ready|answered|complete|embedded|finished)/i.test(trimmed)) {
    return "good";
  }
  if (/^(loading|checking|thinking|running|waiting)/i.test(trimmed)) {
    return "busy";
  }
  if (
    /^(disconnected|unavailable|error|failed|not authorized|configuration needed|temporarily unavailable|report unavailable|proxy error|sign-in required|token expired|athlete id required|race id required)/i.test(
      trimmed,
    )
  ) {
    return "bad";
  }
  return "neutral";
}

function bindStatusTone(el) {
  if (!el) return;
  const apply = () => {
    el.dataset.tone = toneForStatusText(el.textContent);
  };
  apply();
  new MutationObserver(apply).observe(el, { characterData: true, childList: true, subtree: true });
}

[
  elements.streamStatus,
  elements.assistantPanelChip,
  elements.mcpPanelChip,
  elements.reportStatus,
  elements.analysesStatus,
  elements.alertsStatus,
  elements.telemetryStatus,
  elements.raceLiveStatus,
  elements.raceSummaryStatus,
  elements.assistantStatus,
  elements.mcpStatus,
].forEach(bindStatusTone);

renderTelemetry();
renderLiveRace();
resetAssistantTranscript();
resetMcpOutput();
elements.mcpToolSelect.value = state.selectedMcpTool;
updateAssistantAvailability();
updateMcpAvailability();

loadContext()
  .then(refreshCockpit)
  .catch((error) => {
    elements.banner.hidden = false;
    elements.banner.textContent = `Failed to initialize cockpit: ${error.message}`;
  });
