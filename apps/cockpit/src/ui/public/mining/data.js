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

export function sameScope(data, runId, catalogVersion) {
  return data?.plantId === "D01" && data.runId === runId && data.catalogVersion === catalogVersion;
}

export function validAsOf(value, asOf, replay) {
  const age = Date.parse(asOf) - Date.parse(value);
  return Number.isFinite(age) && (replay ? Math.abs(age) < 1000 : age >= -15_000 && age <= 90_000);
}

export function validSeries(data, params, catalogVersion, catalog) {
  if (
    !sameScope(data, params.runId, catalogVersion) ||
    data.moduleId !== (params.moduleId ?? null) ||
    data.metric !== params.metric ||
    data.binMinutes !== Number(params.binMinutes) ||
    Date.parse(data.windowStart) !== Date.parse(params.start) ||
    Date.parse(data.windowEnd) !== Date.parse(params.end) ||
    !Array.isArray(data.rows) ||
    data.rows.length > Math.min(1000, Number(params.maxRows))
  )
    return false;
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
      time >= Date.parse(params.start) &&
      time <= Date.parse(params.end)
    );
  });
}

export function moduleStatus(overview, moduleId) {
  if (!overview || overview.quality !== "good") return "unknown";
  const module = overview.latest?.modules?.find((item) => item.moduleId === moduleId);
  const readings = overview.latest?.readings?.filter((item) => item.moduleId === moduleId);
  if (readings?.some((reading) => !usable(reading))) return "unknown";
  const status = module?.status;
  return ["normal", "warning", "high", "stopped"].includes(status) ? status : "unknown";
}

export function validOverview(data, runId, catalogVersion, asOf, replay) {
  if (
    !sameScope(data, runId, catalogVersion) ||
    !sameScope(data.run, runId, catalogVersion) ||
    !Array.isArray(data.latest?.modules) ||
    data.latest.modules.length !== 24 ||
    !Array.isArray(data.latest?.readings) ||
    data.latest.readings.length !== 56
  )
    return false;
  return validAsOf(data.asOf, asOf, replay);
}

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
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const promise = this.fetch(url, { signal: controller.signal, credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Mining read unavailable (HTTP ${response.status}).`);
        const data = await response.json();
        if (!data || typeof data !== "object" || data.error)
          throw new Error("Invalid mining response.");
        if (!controller.signal.aborted) this.cache.set(url, { at: this.now(), data });
        return data;
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
}

export class MiningPolling {
  constructor(
    refresh,
    { setInterval: schedule = setInterval, clearInterval: cancel = clearInterval } = {},
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
