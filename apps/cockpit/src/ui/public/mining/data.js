export function activePublisher(run) {
  return ["preparing", "scheduled", "running", "stopping"].includes(run?.publisherStatus);
}

export function demoContextChanged(context, run, managed) {
  const approved = context?.approvedRun;
  const status =
    run?.stopRequested && run.publisherStatus === "running"
      ? "stop_requested"
      : run?.publisherStatus;
  return (
    (approved?.runId ?? null) !== (run?.runId ?? null) ||
    (managed && (approved?.generation ?? null) !== (run?.generation ?? null)) ||
    (!managed && !!run && !!approved && approved.publisherStatus !== status)
  );
}

export function simulationTiming(run, data, now = Date.now()) {
  const start = Date.parse(run?.startedAt);
  const stop = Date.parse(run?.stopAt);
  const active = run?.publisherStatus === "running" && !run.stopRequested;
  const sameRun = run?.runId && (data?.runId ?? data?.run?.runId) === run.runId;
  const readings = sameRun ? (data?.latest?.readings ?? data?.readings ?? []) : [];
  const latest = readings
    .map((reading) => ({
      sample: Date.parse(reading.latestSampleTime ?? reading.sampleTime),
      receipt: Date.parse(reading.latestReceivedAt ?? reading.receivedAt ?? reading.ingestionTime),
    }))
    .filter(
      ({ sample, receipt }) =>
        Number.isFinite(sample) &&
        Number.isFinite(receipt) &&
        sample <= receipt &&
        receipt <= now &&
        (!Number.isFinite(start) || sample >= start),
    )
    .sort((a, b) => b.sample - a.sample || b.receipt - a.receipt)[0];
  return {
    active,
    elapsedSeconds: Number.isFinite(start) && start <= now ? (now - start) / 1000 : null,
    remainingSeconds:
      active && Number.isFinite(stop) ? Math.max(0, Math.ceil((stop - now) / 1000)) : null,
    lagSeconds: latest ? (latest.receipt - latest.sample) / 1000 : null,
    sampleAgeSeconds: latest ? (now - latest.sample) / 1000 : null,
    receiptAgeSeconds: latest ? (now - latest.receipt) / 1000 : null,
  };
}

export function usable(reading) {
  return (
    reading?.quality === "good" &&
    typeof reading.value === "number" &&
    Number.isFinite(reading.value) &&
    Number.isFinite(Date.parse(reading.sampleTime ?? reading.timestamp ?? reading.windowEnd))
  );
}

export function readingAt(reading, asOf) {
  const age = (Date.parse(asOf) - Date.parse(reading?.sampleTime)) / 1000;
  return (
    usable(reading) &&
    Number.isFinite(age) &&
    age >= 0 &&
    age <= 195 &&
    Number.isFinite(reading.ageSeconds) &&
    Math.abs(age - reading.ageSeconds) <= 1
  );
}

export function normalizeReading(reading, asOf) {
  if (readingAt(reading, asOf)) return reading;
  const quality = ["bad", "uncertain"].includes(reading.quality) ? reading.quality : "missing";
  return { ...reading, quality, value: null };
}

export function unknownQuality(quality) {
  return quality === "uncertain" || quality === "bad" ? `${quality} / unknown` : "unknown";
}

export function formatTimestamp(value) {
  const timestamp = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "unknown";
}

export function validIncidentWindows(incident) {
  const hasHoldStart = typeof incident?.holdWindowStart === "string";
  const hasHoldEnd = typeof incident?.holdWindowEnd === "string";
  if (
    typeof incident?.evidenceWindowStart !== "string" ||
    typeof incident?.evidenceWindowEnd !== "string"
  )
    return false;
  const evidenceStart = Date.parse(incident.evidenceWindowStart);
  const evidenceEnd = Date.parse(incident.evidenceWindowEnd);
  if (
    hasHoldStart !== hasHoldEnd ||
    !Number.isFinite(evidenceStart) ||
    !Number.isFinite(evidenceEnd) ||
    evidenceStart > evidenceEnd
  )
    return false;
  if (!hasHoldStart) return incident.holdWindowStart === null && incident.holdWindowEnd === null;
  const holdStart = Date.parse(incident.holdWindowStart);
  const holdEnd = Date.parse(incident.holdWindowEnd);
  return Number.isFinite(holdStart) && Number.isFinite(holdEnd) && holdStart <= holdEnd;
}

export function validIncidentAssociation(incident, catalog) {
  const metrics = ["feed", "density", "vibration", "water-energy"];
  return (
    (incident?.moduleId === null ||
      catalog.modules.some((module) => module.id === incident?.moduleId)) &&
    (incident?.metric === null || metrics.includes(incident?.metric)) &&
    (incident?.moduleId !== null || incident?.metric === null) &&
    Array.isArray(incident?.affectedModuleIds) &&
    incident.affectedModuleIds.every((id) => catalog.modules.some((module) => module.id === id))
  );
}

export function refreshedIncidentSelection(selectedIncident, incidents) {
  if (!selectedIncident) return null;
  return incidents.find((incident) => incident.incidentId === selectedIncident.incidentId) ?? null;
}

export function currentIncidentQuery(mode, params) {
  if (mode === "replay") return null;
  return { plantId: params.plantId, runId: params.runId };
}

export function validCurrentAssessmentAsOf(value, now = Date.now()) {
  if (typeof value !== "string") return false;
  const assessedAt = Date.parse(value);
  return Number.isFinite(assessedAt) && assessedAt >= now - 90_000 && assessedAt <= now + 15_000;
}

export function validIncidentAssessment(data, now = Date.now()) {
  if (data?.assessmentKind === undefined) return validCurrentAssessmentAsOf(data?.asOf, now);
  if (
    data.assessmentKind !== "reconciled-event-time" ||
    !validCurrentAssessmentAsOf(data.refreshedAt, now) ||
    typeof data.asOf !== "string" ||
    typeof data.sourceObservedAt !== "string"
  )
    return false;
  const assessed = Date.parse(data.asOf);
  const captured = Date.parse(data.sourceObservedAt);
  const refreshed = Date.parse(data.refreshedAt);
  return (
    Number.isFinite(assessed) &&
    Number.isFinite(captured) &&
    assessed <= captured &&
    captured <= refreshed &&
    captured <= now
  );
}

export function incidentAssessmentLabel(data) {
  return data?.assessmentKind === "reconciled-event-time"
    ? `Reconciled event time ${formatTimestamp(data.asOf)} · source captured ${formatTimestamp(data.sourceObservedAt)} · rechecked ${formatTimestamp(data.refreshedAt)} · not a live assessment`
    : `Assessed ${formatTimestamp(data?.asOf)} · advisory only`;
}

export function sameScope(data, runId, catalogVersion) {
  return data?.plantId === "D01" && data.runId === runId && data.catalogVersion === catalogVersion;
}

export function validConnectionFlow(data, runId, catalogVersion, catalog, now = Date.now()) {
  const asOf = Date.parse(data?.asOf);
  const anchor = Date.parse(data?.runStartedAt);
  const liveStream = data?.runId === undefined;
  if (
    (liveStream
      ? data?.plantId !== "D01" || data.catalogVersion !== catalogVersion
      : !sameScope(data, runId, catalogVersion)) ||
    !Number.isFinite(asOf) ||
    (!liveStream && (!Number.isFinite(anchor) || anchor > asOf)) ||
    asOf > now + 15_000 ||
    asOf < now - 30_000 ||
    !Array.isArray(data.readings) ||
    !Array.isArray(catalog?.streams)
  )
    return false;
  const ids = new Set(catalog.streams.map((stream) => stream.id));
  const seen = new Set();
  for (const reading of data.readings) {
    const key = `${reading?.streamId}:${reading?.quantity}`;
    if (
      !ids.has(reading?.streamId) ||
      seen.has(key) ||
      typeof reading?.measurementTagId !== "string" ||
      !Number.isFinite(reading.nominalCapacity) ||
      reading.nominalCapacity <= 0 ||
      !(
        (reading.quantity === "dry_solids_mass_flow" && reading.unit === "t/h") ||
        (["water_volume_flow", "medium_volume_flow"].includes(reading.quantity) &&
          reading.unit === "m3/h")
      ) ||
      ![
        "OK",
        "MISSING",
        "STALE",
        "BAD_QUALITY",
        "UNCERTAIN_QUALITY",
        "DUPLICATE_CONFLICT",
      ].includes(reading.status)
    )
      return false;
    seen.add(key);
    if (reading.status === "OK" || reading.status === "STALE") {
      if (
        reading.quality !== "good" ||
        reading.stale !== (reading.status === "STALE") ||
        !Number.isFinite(reading.value) ||
        reading.value < 0 ||
        !Number.isFinite(Date.parse(reading.sampleTime)) ||
        !Number.isFinite(Date.parse(reading.receiptTime)) ||
        (!liveStream && Date.parse(reading.sampleTime) < anchor) ||
        (!liveStream && Date.parse(reading.receiptTime) < Date.parse(reading.sampleTime)) ||
        Date.parse(reading.sampleTime) > asOf ||
        Date.parse(reading.receiptTime) > asOf
      )
        return false;
    } else if (reading.status === "MISSING" && reading.value !== null) return false;
  }
  return (
    ids.size > 0 &&
    (liveStream || [...ids].every((id) => data.readings.some((row) => row.streamId === id)))
  );
}

export function validConnectionTrend(data, request, flow) {
  if (data?.runId === undefined) {
    const size = request.windowSeconds * 1000;
    return (
      data?.plantId === "D01" &&
      data.catalogVersion === request.catalogVersion &&
      data.start === request.start &&
      data.end === request.end &&
      [30, 60].includes(request.windowSeconds) &&
      Array.isArray(data.points) &&
      data.points.length <= 1000 &&
      data.points.every(
        (point) =>
          request.streamIds.includes(point.streamId) &&
          typeof point.measurementTagId === "string" &&
          Number.isFinite(Date.parse(point.windowStart)) &&
          Date.parse(point.windowEnd) === Date.parse(point.windowStart) + size &&
          Number.isInteger(point.samples) &&
          point.samples >= 0 &&
          Number.isFinite(point.coverage) &&
          point.coverage >= 0 &&
          point.coverage <= 1 &&
          (point.value === null || (Number.isFinite(point.value) && point.value >= 0)),
      )
    );
  }
  const start = Date.parse(request.start);
  const end = Date.parse(request.end);
  const anchor = Date.parse(flow?.runStartedAt);
  const size = request.windowSeconds * 1000;
  if (
    !sameScope(data, request.runId, request.catalogVersion) ||
    data.start !== request.start ||
    data.end !== request.end ||
    data.runStartedAt !== flow?.runStartedAt ||
    !Number.isFinite(anchor) ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < anchor ||
    end <= start ||
    ![30, 60].includes(request.windowSeconds) ||
    !Array.isArray(data.points) ||
    data.points.length > 1000 ||
    !Array.isArray(flow?.readings)
  )
    return false;
  const selected = flow.readings.filter((item) => request.streamIds.includes(item.streamId));
  const tags = new Map(selected.map((item) => [item.measurementTagId, item]));
  const first = anchor + Math.floor((start - anchor - (start > anchor ? 1 : 0)) / size) * size;
  const last = anchor + Math.floor((end - anchor - 1) / size) * size;
  if (!tags.size || data.points.length !== tags.size * ((last - first) / size + 1)) return false;
  const seen = new Set();
  for (const point of data.points) {
    const tag = tags.get(point?.measurementTagId);
    const windowStart = Date.parse(point?.windowStart);
    const windowEnd = Date.parse(point?.windowEnd);
    const key = `${point?.measurementTagId}:${windowStart}`;
    if (
      !tag ||
      tag.streamId !== point.streamId ||
      tag.quantity !== point.quantity ||
      tag.unit !== point.unit ||
      seen.has(key) ||
      !Number.isFinite(windowStart) ||
      windowStart < first ||
      windowStart > last ||
      (windowStart - anchor) % size !== 0 ||
      windowEnd !== windowStart + size ||
      !Number.isInteger(point.samples) ||
      point.samples < 0 ||
      point.expectedSamples !== request.windowSeconds / 5 ||
      point.samples > point.expectedSamples ||
      !Number.isFinite(point.coverage) ||
      Math.abs(point.coverage - point.samples / point.expectedSamples) > 1e-9 ||
      typeof point.complete !== "boolean" ||
      !["COMPLETE", "PARTIAL", "MISSING", "UNUSABLE", "CONFLICT", "OPEN_WINDOW"].includes(
        point.state,
      ) ||
      point.complete !== (point.state === "COMPLETE") ||
      (point.complete &&
        (windowEnd > end ||
          point.samples !== point.expectedSamples ||
          point.quality !== "good" ||
          point.conflicts !== 0)) ||
      (point.samples === 0
        ? point.value !== null
        : !Number.isFinite(point.value) || point.value < 0)
    )
      return false;
    seen.add(key);
  }
  return true;
}

export function validAsOf(value, asOf, replay) {
  const age = Date.parse(asOf) - Date.parse(value);
  return Number.isFinite(age) && (replay ? Math.abs(age) < 1000 : age >= -15_000 && age <= 90_000);
}

// Treat the browser as up to 15 seconds behind for expiry and age checks.
export const continuousClockSkewMs = 15_000;
function continuousRequestCurrent(value, now) {
  const request = Date.parse(value);
  const latestPossibleNow = now + continuousClockSkewMs;
  return (
    Number.isFinite(request) &&
    request <= latestPossibleNow &&
    latestPossibleNow - request <= 90_000
  );
}

export function validSeries(data, params, catalogVersion, catalog) {
  if (
    !sameScope(data, params.runId, catalogVersion) ||
    data.moduleId !== (params.moduleId ?? null) ||
    data.metric !== params.metric ||
    ![1, 5].includes(data.binMinutes) ||
    data.binMinutes !== Number(params.binMinutes) ||
    Date.parse(data.windowStart) !== Date.parse(params.start) ||
    Date.parse(data.windowEnd) !== Date.parse(params.end) ||
    !Array.isArray(data.rows) ||
    data.rows.length > Math.min(1000, Number(params.maxRows))
  )
    return false;
  if (
    ["sorter-feed", "motor-current", "bearing-temperature", "feed-pressure"].includes(params.metric)
  ) {
    const checked = crossRunChartData(data, params, catalogVersion, catalog, null, Date.now(), {
      runId: params.runId,
      moduleId: params.moduleId,
      asOf: params.asOf,
    });
    return !!checked && JSON.stringify(checked.rows) === JSON.stringify(data.rows);
  }
  const binMs = data.binMinutes * 60_000;
  const firstBin = Math.floor(Date.parse(params.start) / binMs) * binMs;
  return data.rows.every((row) => {
    const tag = catalog.telemetry_tags.find((item) => item.id === row?.seriesId);
    const time = Date.parse(row?.timestamp);
    const metric = { feed: "ore_flow", density: "medium_density", vibration: "vibration_rms" }[
      params.metric
    ];
    return (
      tag &&
      tag.unit === row.unit &&
      (!params.moduleId || tag.module_id === params.moduleId) &&
      (!metric || tag.metric === metric) &&
      Number.isFinite(time) &&
      time >= firstBin &&
      time < Date.parse(params.end) &&
      time % binMs === 0
    );
  });
}

export function crossRunChartData(
  data,
  params,
  catalogVersion,
  catalog,
  owner,
  now = Date.now(),
  scoped = null,
) {
  const start = Date.parse(params.start);
  const end = Date.parse(params.end);
  const asOf = Date.parse(data?.asOf);
  const binMs = Number(params.binMinutes) * 60_000;
  const statuses = new Set([
    "OBSERVED",
    "PARTIAL",
    "NON_GOOD",
    "CONFLICT",
    "CADENCE_CONFLICT",
    "AMBIGUOUS_OWNER",
    "COVERAGE_UNKNOWN",
    "GAP",
  ]);
  if (
    (scoped
      ? !sameScope(data, scoped.runId, catalogVersion) ||
        data.moduleId !== scoped.moduleId ||
        Date.parse(data.asOf) !== Date.parse(scoped.asOf)
      : !owner ||
        data?.owner?.runId !== owner.runId ||
        data.owner.generation !== owner.generation ||
        !(Date.parse(data.owner.authorityUntil) > now + continuousClockSkewMs)) ||
    data.catalogVersion !== catalogVersion ||
    data.profileVersion !== "d01-publish-profile-v1" ||
    data.metric !== params.metric ||
    data.binMinutes !== Number(params.binMinutes) ||
    ![60_000, 300_000].includes(binMs) ||
    !Number.isFinite(start) ||
    !(end > start) ||
    end - start > 86_400_000 ||
    Date.parse(data.start) !== start ||
    Date.parse(data.end) !== end ||
    (!scoped && !continuousRequestCurrent(data.asOf, now)) ||
    asOf < end ||
    !Array.isArray(data.points) ||
    data.points.length > 1000
  )
    return null;
  const seen = new Set();
  for (const point of data.points) {
    const tag = catalog.telemetry_tags.find((item) => item.id === point?.seriesId);
    const time = Date.parse(point?.binStart);
    const samples = point?.sampleTimes;
    const family =
      params.metric === "feed"
        ? tag?.metric === "ore_flow" && tag.module_id.endsWith(".crusher")
        : params.metric === "density"
          ? tag?.metric === "medium_density"
          : params.metric === "vibration"
            ? tag?.metric === "vibration_rms" && tag.module_id.endsWith(".crusher")
            : params.metric === "sorter-feed"
              ? tag?.metric === "ore_flow" && tag.module_id.endsWith(".sorter")
              : params.metric === "bearing-temperature"
                ? tag?.metric === "bearing_temperature" && tag.module_id.endsWith(".crusher")
                : params.metric === "feed-pressure"
                  ? tag?.metric === "feed_pressure" && tag.module_id.endsWith(".dms")
                  : params.metric === "motor-current"
                    ? tag?.metric === "motor_current" &&
                      [".crusher", ".dms", ".sorter"].some((suffix) =>
                        tag.module_id.endsWith(suffix),
                      )
                    : params.metric === "water-energy" &&
                      [
                        "D01.shared.water.level",
                        "D01.shared.water.water_flow",
                        "D01.shared.control.power",
                      ].includes(tag?.id);
    const key = `${point?.runId}:${point?.seriesId}:${time}`;
    if (
      !tag ||
      !family ||
      (scoped && (point.runId !== scoped.runId || point.moduleId !== scoped.moduleId)) ||
      tag.unit !== point.unit ||
      tag.module_id !== point.moduleId ||
      tag.equipment_id !== point.equipmentId ||
      tag.metric !== point.metric ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        point.runId,
      ) ||
      seen.has(key) ||
      !Number.isFinite(time) ||
      time < start ||
      time >= end ||
      (time - start) % binMs !== 0 ||
      !statuses.has(point.status) ||
      !Array.isArray(samples) ||
      !samples.length ||
      samples.length !== point.sampleCount ||
      samples.some(
        (sample, index) =>
          !Number.isFinite(Date.parse(sample)) ||
          Date.parse(sample) < time ||
          Date.parse(sample) >= Math.min(time + binMs, end) ||
          (index > 0 && Date.parse(sample) <= Date.parse(samples[index - 1])),
      ) ||
      Date.parse(point.firstSampleTime) !== Date.parse(samples[0]) ||
      Date.parse(point.lastSampleTime) !== Date.parse(samples.at(-1)) ||
      !Number.isFinite(Date.parse(point.firstReceivedAt)) ||
      !Number.isFinite(Date.parse(point.lastReceivedAt)) ||
      Date.parse(point.firstReceivedAt) > Date.parse(point.lastReceivedAt) ||
      Date.parse(point.lastReceivedAt) > asOf ||
      (point.coverage !== null &&
        (!Number.isFinite(point.coverage) || point.coverage < 0 || point.coverage > 1)) ||
      (point.status === "OBSERVED"
        ? point.quality !== "good" ||
          !Number.isFinite(point.value) ||
          point.coverage !== 1 ||
          !point.coverageComplete ||
          point.ambiguousOwner ||
          point.cadenceConflict ||
          typeof point.segmentId !== "string" ||
          !point.segmentId.startsWith(`${point.runId}:${point.seriesId}:`)
        : point.value !== null || point.segmentId !== null)
    )
      return null;
    seen.add(key);
  }
  return {
    crossRun: true,
    binMinutes: data.binMinutes,
    windowStart: data.start,
    windowEnd: data.end,
    rows: data.points.map((point) => ({ ...point, timestamp: point.binStart })),
  };
}

export function moduleStatus(
  overview,
  moduleId,
  mode = overview?.mode,
  catalog = null,
  now = Date.now(),
) {
  if (mode === "continuous") {
    if (!overview?.detail || !Array.isArray(catalog?.telemetry_tags))
      return "not directly reported";
    const tags = catalog.telemetry_tags.filter((tag) => tag.module_id === moduleId);
    if (!tags.length) return overview?.detail ? "no direct sensor tags" : "not directly reported";
    const readings = tags.map((tag) => continuousTagReading(overview, tag.id, now));
    if (readings.some((reading) => reading?.quality === "bad")) return "sensor evidence flagged";
    if (readings.some((reading) => reading?.quality === "stale")) return "sensor evidence stale";
    if (
      readings.every((reading) => reading?.quality === "good" && Number.isFinite(reading.value))
    ) {
      return "sensor evidence current";
    }
    return "sensor evidence incomplete";
  }
  if (!overview) return "unknown";
  const readings = overview.latest?.readings?.filter((item) => item.moduleId === moduleId);
  if (!readings?.length) return "not directly reported";
  if (readings.some((reading) => !usable(reading))) return "unknown";
  return "sensor evidence current";
}

// A line controller observation is not an individual machine health signal.
export function lineOperatingState(overview, line, mode, now = Date.now(), replay = false) {
  const states =
    mode === "continuous" ? overview?.detail?.lineStates : overview?.latest?.lineStates;
  if (!["A", "B", "C"].includes(line) || !Array.isArray(states)) return "unknown";
  const matching = states.filter((item) => item?.scopeId === line);
  if (matching.length !== 1) return "unknown";
  const state = matching[0];
  const at = Date.parse(overview?.asOf);
  const sampled = Date.parse(state.sampleTime);
  const reference = replay ? at : now;
  if (
    !Number.isFinite(at) ||
    !Number.isFinite(sampled) ||
    !Number.isFinite(reference) ||
    sampled > at ||
    at - sampled > 195_000 ||
    reference - sampled > 195_000 ||
    sampled > reference + continuousClockSkewMs ||
    (mode === "continuous" &&
      (state.quality !== "good" ||
        !continuousOwnerCurrent(overview, now) ||
        now + continuousClockSkewMs - sampled > 195_000)) ||
    typeof state.scheduledRunning !== "boolean"
  )
    return "unknown";
  if (state.state === "running" && state.scheduledRunning) return "running";
  if (state.state === "stopped") return "stopped";
  return "unknown";
}

export function validOverview(data, runId, catalogVersion, asOf, replay, now = Date.now()) {
  if (
    !sameScope(data, runId, catalogVersion) ||
    !sameScope(data.run, runId, catalogVersion) ||
    !Array.isArray(data.latest?.modules) ||
    data.latest.modules.length !== 24 ||
    !Array.isArray(data.latest?.readings) ||
    data.latest.readings.length !== 56
  )
    return false;
  // Live reads use the service cutoff, not the rounded chart-window timestamp.
  return validAsOf(data.asOf, replay ? asOf : new Date(now).toISOString(), replay);
}

export function validContinuousOverview(
  data,
  runId,
  catalogVersion,
  generation,
  now = Date.now(),
  catalog = null,
) {
  const expected = ["A", "B", "C"].map((line) => `D01.${line}.crusher.ore_flow`);
  const continuousScopeValid =
    data?.mode === "continuous" &&
    sameScope(data, runId, catalogVersion) &&
    sameScope(data.run, runId, catalogVersion) &&
    data.generation === generation &&
    data.run.generation === generation &&
    continuousRequestCurrent(data.asOf, now) &&
    ["good", "unavailable"].includes(data.quality) &&
    data.throughput?.unit === "t/h" &&
    Array.isArray(data.readings) &&
    data.readings.length === 3 &&
    new Set(data.readings.map((row) => row.tagId)).size === 3 &&
    data.readings.every(
      (row) =>
        expected.includes(row.tagId) &&
        row.unit === "t/h" &&
        ["good", "bad", "stale", "missing", "warming_up", "unavailable"].includes(row.quality),
    ) &&
    data.source?.workspace === "triatwin-dev-fabric" &&
    data.source.database === "mining-d01-realtime" &&
    typeof data.capabilities?.incidents === "boolean" &&
    typeof data.capabilities?.trends === "boolean";
  if (!continuousScopeValid) return false;
  if (Object.hasOwn(data, "continuousSummary") && !validContinuousSummary(data)) return false;
  if (!Object.hasOwn(data, "detail")) return true;
  return validContinuousDetail(data, catalogVersion, catalog);
}

export function validContinuousAdvisories(
  data,
  runId,
  catalogVersion,
  generation,
  now = Date.now(),
  catalog = null,
) {
  const timestamp = (value) => {
    const parsed = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
  };
  const start = timestamp(data?.windowStart);
  const asOf = timestamp(data?.asOf);
  const observed = timestamp(data?.sourceObservedAt);
  if (
    data?.assessmentKind !== "rolling-event-time-advisory" ||
    data?.plantId !== "D01" ||
    data?.catalogVersion !== catalogVersion ||
    data?.runId !== runId ||
    data?.generation !== generation ||
    start === null ||
    asOf === null ||
    observed === null ||
    asOf - start !== 20 * 60_000 ||
    asOf > observed ||
    observed > now + 15_000 ||
    now - asOf > 180_000 ||
    !Number.isSafeInteger(data.totalAdvisories) ||
    data.totalAdvisories < 0 ||
    !Array.isArray(data.advisories) ||
    data.advisories.length !== Math.min(data.totalAdvisories, 20)
  )
    return false;
  const scopes = new Set(["A", "B", "C", "shared"]);
  return data.advisories.every((item) => {
    const evidenceStart = timestamp(item?.evidenceWindow?.start);
    const evidenceEnd = timestamp(item?.evidenceWindow?.end);
    if (
      !item ||
      typeof item !== "object" ||
      ["incidentId", "raisedAt", "clearedAt", "acknowledgedAt"].some((key) =>
        Object.hasOwn(item, key),
      ) ||
      typeof item.ruleId !== "string" ||
      !scopes.has(item.scopeId) ||
      !["warning", "high"].includes(item.severity) ||
      !["verified", "unverified"].includes(item.verification) ||
      evidenceStart === null ||
      evidenceEnd === null ||
      evidenceStart < start ||
      evidenceEnd > asOf ||
      evidenceStart > evidenceEnd ||
      !Array.isArray(item.evidence) ||
      item.evidence.length > 56 ||
      !Array.isArray(item.stateEvidence) ||
      item.stateEvidence.length > 4
    )
      return false;
    return (
      item.evidence.every((row) => {
        const tag = catalog?.telemetry_tags?.find((candidate) => candidate.id === row?.tagId);
        const sample = timestamp(row?.sampleTime);
        return (
          tag &&
          row.unit === tag.unit &&
          typeof row.value === "number" &&
          Number.isFinite(row.value) &&
          ["good", "uncertain", "bad"].includes(row.quality) &&
          sample !== null &&
          sample >= start &&
          sample <= asOf
        );
      }) &&
      item.stateEvidence.every((row) => {
        const sample = timestamp(row?.sampleTime);
        return (
          row &&
          scopes.has(row.scopeId) &&
          ["starting", "running", "idle", "stopped", "fault"].includes(row.state) &&
          typeof row.scheduledRunning === "boolean" &&
          sample !== null &&
          sample >= start &&
          sample <= asOf
        );
      })
    );
  });
}

function validContinuousSummary(data) {
  const summary = data?.continuousSummary;
  const request = Date.parse(data?.asOf);
  if (
    !summary ||
    summary.plantId !== "D01" ||
    summary.runId !== data.runId ||
    summary.generation !== data.generation ||
    summary.catalogVersion !== data.catalogVersion ||
    summary.sourceContractVersion !== continuousSourceContractVersion ||
    summary.asOf !== data.asOf ||
    !Number.isFinite(request) ||
    !Array.isArray(summary.windows) ||
    summary.windows.length !== continuousSummaryWindows.length
  )
    return false;
  const seen = new Set();
  for (const window of summary.windows) {
    const definition = continuousSummaryWindows.find((item) => item.window === window?.window);
    if (
      !definition ||
      seen.has(window.window) ||
      window.windowStart !== new Date(request - definition.durationMs).toISOString() ||
      window.windowEnd !== data.asOf ||
      !continuousSummaryStatuses.has(window.status)
    )
      return false;
    seen.add(window.window);
    for (const [metric, unit] of [
      ["grossProcessWaterIntensity", "m\u00b3/t"],
      ["energyIntensity", "kWh/t"],
    ]) {
      const reading = window[metric];
      if (
        reading?.unit !== unit ||
        reading.windowStart !== window.windowStart ||
        reading.windowEnd !== window.windowEnd ||
        !["good", "uncertain", "bad", "missing", "unavailable"].includes(reading.quality) ||
        !(
          reading.coverage === null ||
          (Number.isFinite(reading.coverage) && reading.coverage >= 0 && reading.coverage <= 1)
        ) ||
        (reading.quality === "good"
          ? !Number.isFinite(reading.value) ||
            reading.value < 0 ||
            reading.coverage === null ||
            reading.coverage < 0.9
          : reading.value !== null)
      )
        return false;
    }
  }
  return seen.size === continuousSummaryWindows.length;
}

const continuousFeedTags = new Set([
  "D01.A.crusher.ore_flow",
  "D01.B.crusher.ore_flow",
  "D01.C.crusher.ore_flow",
]);
const continuousProfileVersion = "d01-publish-profile-v1";
const continuousSourceContractVersion = "d01-validated-source-v1";
const continuousSummaryWindows = [
  { window: "30m", durationMs: 30 * 60_000 },
  { window: "2h", durationMs: 2 * 60 * 60_000 },
  { window: "24h", durationMs: 24 * 60 * 60_000 },
];
const continuousSummaryStatuses = new Set([
  "OK",
  "NO_DATA",
  "STATE_COVERAGE_INCOMPLETE",
  "INSUFFICIENT_COMMON_COVERAGE",
  "FEED_BELOW_10_TPH",
  "SOURCE_REJECTED",
  "QUERY_UNAVAILABLE",
]);
const cadenceByMetric = {
  bearing_temperature: 60,
  feed_pressure: 30,
  level: 60,
  medium_density: 30,
  motor_current: 30,
  ore_flow: 30,
  power: 30,
  product_mass: 60,
  vibration_rms: 30,
  water_flow: 30,
};
const validEventId = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const emptyEvidence = (reading) =>
  reading.value === null &&
  reading.sampleTime === null &&
  reading.receivedAt === null &&
  reading.ageSeconds === null &&
  reading.eventId === null &&
  reading.sequence === null;

function validContinuousObservation(
  reading,
  request,
  sourceStatus,
  maxAgeMs,
  envelope,
  hasValue = true,
) {
  if (!["good", "bad", "stale", "missing", "unavailable"].includes(reading.quality)) return false;
  if (reading.sampleTime === null) {
    return (
      emptyEvidence(reading) &&
      ["bad", "missing", "unavailable"].includes(reading.quality) &&
      (reading.quality !== "unavailable" || sourceStatus !== "READY")
    );
  }
  const sample = Date.parse(reading.sampleTime);
  const received = Date.parse(reading.receivedAt);
  const age = (Date.parse(request) - sample) / 1000;
  if (
    !Number.isFinite(sample) ||
    !Number.isFinite(received) ||
    sample > Date.parse(request) ||
    Date.parse(request) - sample > 600_000 ||
    received < sample ||
    received > Date.parse(request) ||
    !Number.isFinite(reading.ageSeconds) ||
    Math.abs(reading.ageSeconds - age) > 1 ||
    !validEventId(reading.eventId) ||
    !Number.isSafeInteger(reading.sequence) ||
    reading.sequence < 1
  )
    return false;
  if (reading.quality === "good") {
    return (
      sourceStatus === "READY" &&
      Date.parse(request) - sample <= maxAgeMs &&
      (!hasValue ||
        (Number.isFinite(reading.value) &&
          (!envelope || (reading.value >= envelope[0] && reading.value <= envelope[1]))))
    );
  }
  if (reading.value !== null) return false;
  if (reading.quality === "stale") return Date.parse(request) - sample > maxAgeMs;
  if (reading.quality === "unavailable") return sourceStatus !== "READY";
  return reading.quality === "bad";
}

function validContinuousDetail(data, catalogVersion, catalog) {
  const detail = data.detail;
  const sourceStatus = detail?.sourceStatus;
  if (
    !detail ||
    !catalog ||
    !Array.isArray(catalog.telemetry_tags) ||
    catalog.telemetry_tags.length !== 56 ||
    detail.plantId !== "D01" ||
    detail.runId !== data.runId ||
    detail.generation !== data.generation ||
    detail.asOf !== data.asOf ||
    detail.catalogVersion !== catalogVersion ||
    detail.profileVersion !== continuousProfileVersion ||
    detail.sourceContractVersion !== continuousSourceContractVersion ||
    typeof sourceStatus !== "string" ||
    sourceStatus.length === 0 ||
    !Array.isArray(detail.readings) ||
    detail.readings.length !== catalog.telemetry_tags.length - continuousFeedTags.size ||
    !Array.isArray(detail.lineStates) ||
    detail.lineStates.length !== 3 ||
    detail.runningLines?.unit !== "lines" ||
    !["good", "unavailable"].includes(detail.runningLines.quality)
  )
    return false;
  const request = data.asOf;
  const tags = new Map(catalog.telemetry_tags.map((tag) => [tag.id, tag]));
  const seenTags = new Set();
  for (const reading of detail.readings) {
    const tag = tags.get(reading?.tagId);
    if (
      !tag ||
      continuousFeedTags.has(tag.id) ||
      seenTags.has(tag.id) ||
      reading.moduleId !== tag.module_id ||
      reading.equipmentId !== tag.equipment_id ||
      reading.unit !== tag.unit ||
      reading.cadenceSeconds !== cadenceByMetric[tag.metric] ||
      !validContinuousObservation(
        reading,
        request,
        sourceStatus,
        reading.cadenceSeconds * 3_000 + 15_000,
        tag.simulation_envelope,
      )
    )
      return false;
    seenTags.add(tag.id);
  }
  if (
    seenTags.size !== tags.size - continuousFeedTags.size ||
    [...continuousFeedTags].some(
      (tagId) => !data.readings.some((reading) => reading.tagId === tagId),
    )
  )
    return false;
  for (const reading of data.readings) {
    const tag = tags.get(reading.tagId);
    if (
      reading.sourceStatus !== sourceStatus ||
      !tag ||
      reading.moduleId !== tag.module_id ||
      reading.unit !== tag.unit ||
      !["good", "bad", "stale", "missing", "unavailable"].includes(reading.latestQuality) ||
      !validContinuousObservation(
        {
          value: reading.latestValue,
          quality: reading.latestQuality,
          sampleTime: reading.latestSampleTime,
          receivedAt: reading.latestReceivedAt,
          ageSeconds: reading.ageSeconds,
          eventId: reading.latestEventId,
          sequence: reading.latestSequence,
        },
        request,
        sourceStatus,
        105_000,
        tag.simulation_envelope,
      )
    )
      return false;
  }
  const scopes = new Set();
  for (const state of detail.lineStates) {
    if (
      !["A", "B", "C"].includes(state?.scopeId) ||
      scopes.has(state.scopeId) ||
      !["starting", "running", "idle", "stopped", "fault", null].includes(state.state) ||
      !(state.scheduledRunning === null || typeof state.scheduledRunning === "boolean") ||
      !validContinuousObservation(
        {
          value: null,
          quality: state.quality,
          sampleTime: state.sampleTime,
          receivedAt: state.receivedAt,
          ageSeconds: state.ageSeconds,
          eventId: state.eventId,
          sequence: state.sequence,
        },
        request,
        sourceStatus,
        195_000,
        undefined,
        false,
      ) ||
      (state.sampleTime === null
        ? state.state !== null || state.scheduledRunning !== null
        : state.state === null || typeof state.scheduledRunning !== "boolean")
    )
      return false;
    scopes.add(state.scopeId);
  }
  if (scopes.size !== 3) return false;
  const allCurrent = detail.lineStates.every((state) => state.quality === "good");
  const expectedCount = allCurrent
    ? detail.lineStates.filter(
        (state) => state.state === "running" && state.scheduledRunning === true,
      ).length
    : null;
  return (
    detail.runningLines.value === expectedCount &&
    detail.runningLines.quality === (expectedCount === null ? "unavailable" : "good")
  );
}

export function continuousTagReading(data, tagId, now = Date.now()) {
  const feed = data?.readings?.find((reading) => reading.tagId === tagId);
  const reading = feed
    ? {
        tagId,
        moduleId: feed.moduleId,
        unit: feed.unit,
        value: feed.latestValue,
        quality: feed.latestQuality,
        sampleTime: feed.latestSampleTime,
        receivedAt: feed.latestReceivedAt,
        ageSeconds: feed.ageSeconds,
        eventId: feed.latestEventId,
        sequence: feed.latestSequence,
      }
    : data?.detail?.readings?.find((item) => item.tagId === tagId);
  if (!reading) return null;
  if (!continuousOwnerCurrent(data, now))
    return { ...reading, quality: "unavailable", value: null };
  if (
    reading.quality === "good" &&
    now + continuousClockSkewMs - Date.parse(reading.sampleTime) >
      (feed ? 105_000 : (reading.cadenceSeconds ?? 60) * 3_000 + 15_000)
  ) {
    return { ...reading, quality: "stale", value: null };
  }
  return reading;
}

export function continuousSummaryFresh(data, now = Date.now()) {
  const request = Date.parse(data?.asOf);
  const watermark = Date.parse(data?.watermark);
  const summary = data?.continuousSummary;
  return (
    continuousOwnerCurrent(data, now) &&
    summary?.runId === data.runId &&
    summary?.generation === data.generation &&
    summary?.asOf === data.asOf &&
    Array.isArray(summary?.windows) &&
    Number.isFinite(watermark) &&
    watermark <= request &&
    now + continuousClockSkewMs - watermark <= 105_000 &&
    [...continuousFeedTags, "D01.shared.water.water_flow", "D01.shared.control.power"].every(
      (tagId) => {
        const reading = continuousTagReading(data, tagId, now);
        return reading?.quality === "good" && Number.isFinite(reading.value);
      },
    )
  );
}

export function continuousSummaryMetric(data, windowId, metric, now = Date.now()) {
  if (!continuousSummaryFresh(data, now)) return null;
  const value = data.continuousSummary.windows.find((window) => window.window === windowId)?.[
    metric
  ];
  return value?.quality === "good" &&
    Number.isFinite(value.value) &&
    value.coverage >= 0.9 &&
    value.coverage <= 1
    ? value
    : null;
}

export function continuousRunningLines(data, now = Date.now()) {
  const detail = data?.detail;
  const request = Date.parse(data?.asOf);
  if (
    !continuousOwnerCurrent(data, now) ||
    detail?.runningLines?.quality !== "good" ||
    !Number.isInteger(detail.runningLines.value) ||
    !Array.isArray(detail.lineStates) ||
    !Number.isFinite(request) ||
    detail.lineStates.some(
      (state) =>
        state.quality !== "good" ||
        !Number.isFinite(Date.parse(state.sampleTime)) ||
        now + continuousClockSkewMs - Date.parse(state.sampleTime) > 195_000,
    )
  )
    return null;
  return detail.runningLines.value;
}

function continuousOwnerCurrent(data, now) {
  return (
    data?.run?.publisherStatus === "running" &&
    data.run.stopRequested === false &&
    data.run.runId === data.runId &&
    data.run.generation === data.generation &&
    Date.parse(data.run.authorityUntil) > now + continuousClockSkewMs &&
    continuousRequestCurrent(data.asOf, now)
  );
}

export function continuousThroughputUsable(data, now = Date.now()) {
  const requested = Date.parse(data?.asOf);
  const cutoff = Date.parse(data?.watermark);
  return (
    data?.quality === "good" &&
    data.throughput?.quality === "good" &&
    Number.isFinite(data.throughput.value) &&
    continuousOwnerCurrent(data, now) &&
    Number.isFinite(cutoff) &&
    cutoff <= requested &&
    now + continuousClockSkewMs - cutoff <= 105_000 &&
    Date.parse(data.windowStart) === cutoff - 300_000 &&
    Date.parse(data.windowEnd) === cutoff &&
    data.readings?.length === 3 &&
    data.readings.every(
      (row) =>
        row.quality === "good" &&
        Number.isFinite(row.average) &&
        Number.isFinite(row.value) &&
        row.coverage >= 0.9 &&
        row.coverage <= 1 &&
        Date.parse(row.sampleTime) === cutoff &&
        Date.parse(row.latestSampleTime) >= cutoff &&
        Date.parse(row.latestSampleTime) <= requested &&
        Date.parse(row.receivedAt) >= cutoff &&
        Date.parse(row.receivedAt) <= requested,
    ) &&
    Math.abs(data.throughput.value - data.readings.reduce((sum, row) => sum + row.average, 0)) <
      0.00001
  );
}

export function seriesQuery(
  { plantId, runId, start, end, binMinutes, maxRows, asOf },
  metric,
  moduleId,
) {
  const request = { plantId, runId, start, end, binMinutes, maxRows, metric, moduleId };
  if (["sorter-feed", "motor-current", "bearing-temperature", "feed-pressure"].includes(metric))
    request.asOf = asOf;
  return request;
}

const safeReadErrors = {
  mining_flow_pending: ["waiting", "Waiting for the first connection flow samples."],
  mining_demo_run_not_found: ["no_sample", "No public simulation is available yet."],
  mining_run_not_found: ["no_sample", "No simulation is available yet."],
  mining_admission_unavailable: ["waiting", "Waiting for the simulation to start."],
  mining_read_configuration: ["not_configured", "Mining readings are not configured."],
  mining_demo_configuration: ["not_configured", "Mining readings are not configured."],
  mining_demo_read_disabled: ["not_configured", "Mining readings are not enabled."],
  mining_demo_disabled: ["not_configured", "The mining demo is not enabled."],
  mining_read_timeout: ["service_failed", "The readings request timed out."],
  mining_demo_timeout: ["service_failed", "The readings request timed out."],
};

export class MiningReads {
  constructor(fetchImpl = fetch, now = Date.now) {
    this.fetch = (...args) => fetchImpl(...args);
    this.now = now;
    this.cache = new Map();
    this.inflight = new Map();
  }
  read(path, query = {}) {
    const url = `/api/mining/${path}?${new URLSearchParams(
      Object.entries(query)
        .filter(([, value]) => value !== undefined)
        .sort(),
    )}`;
    const cached = this.cache.get(url);
    if (cached && this.now() - cached.at < 15_000) return Promise.resolve(cached.data);
    if (this.inflight.has(url)) return this.inflight.get(url).promise;
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 10_000);
    const promise = this.fetch(url, { signal: controller.signal, credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) {
          let envelope;
          try {
            envelope = await response.json();
          } catch {
            /* No trusted error envelope. */
          }
          const code = envelope?.error?.code;
          const [category, message] = (Object.hasOwn(safeReadErrors, code) &&
            safeReadErrors[code]) || [
            "service_failed",
            "Live readings unavailable. Plant layout still works. Retry.",
          ];
          const error = new Error(message);
          error.category = category;
          throw error;
        }
        const data = await response.json();
        if (!data || typeof data !== "object" || data.error)
          throw new Error("Invalid mining response.");
        if (!controller.signal.aborted) this.cache.set(url, { at: this.now(), data });
        return data;
      })
      .catch((error) => {
        if (timedOut || error instanceof TypeError) {
          const failure = new Error("Readings unavailable. Check your connection and retry.");
          failure.category = "service_failed";
          throw failure;
        }
        throw error;
      })
      .finally(() => {
        clearTimeout(timeout);
        if (this.inflight.get(url)?.controller === controller) this.inflight.delete(url);
      });
    this.inflight.set(url, { controller, promise });
    return promise;
  }
  abort() {
    for (const { controller } of this.inflight.values()) controller.abort();
    this.inflight.clear();
  }
  reset() {
    this.abort();
    this.cache.clear();
  }
}

export class MiningPolling {
  constructor(
    refresh,
    {
      setInterval: schedule = globalThis.setInterval.bind(globalThis),
      clearInterval: cancel = globalThis.clearInterval.bind(globalThis),
    } = {},
  ) {
    this.refresh = refresh;
    this.schedule = schedule;
    this.cancel = cancel;
    this.timers = [];
  }
  update({ mode, hidden, connected }) {
    this.stop();
    if (mode !== "live" || hidden || !connected) return;
    this.timers.push(this.schedule(() => this.refresh("overview"), 30_000));
    this.timers.push(this.schedule(() => this.refresh("detail"), 60_000));
  }
  stop() {
    this.timers.forEach(this.cancel);
    this.timers = [];
  }
}
export function verifiedRunIngestion(overview, run) {
  const connection = overview?.connectionIngestion;
  if (run && overview?.run?.runId === run.runId && connection) {
    if (connection.status === "pending") return "verification pending";
    if (
      connection.provenance === "fabric-connection-reconciliation-v1" &&
      ["complete", "changed"].includes(connection.status) &&
      Number.isFinite(Date.parse(connection.asOf)) &&
      Number.isFinite(Date.parse(connection.checkedAt)) &&
      Date.parse(connection.asOf) <= Date.parse(connection.checkedAt)
    ) {
      return connection.status === "complete"
        ? `complete as of ${formatTimestamp(connection.asOf)} · row counts checked ${formatTimestamp(connection.checkedAt)}`
        : `changed after verification at ${formatTimestamp(connection.asOf)}`;
    }
    return "unknown";
  }
  const evidence = overview?.ingestion;
  if (
    !run ||
    overview?.run?.runId !== run.runId ||
    evidence?.provenance !== "fabric-event-id-reconciliation-v1" ||
    !["pending", "partial", "complete", "unknown"].includes(evidence.status) ||
    !Number.isFinite(Date.parse(evidence.asOf))
  )
    return "unknown";
  return `${evidence.status} as of ${formatTimestamp(evidence.asOf)}`;
}
