import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

export const PUBLIC_ORIGIN = "https://ontologydemo.liberatetheinnerchild.net";
export const EXPECTED_CATALOG =
  "sha256:0ba278e5e28b3466381534c5a920ce28b551cb3a7ddfc68cdf4371749f2c62ce";
export const EXPECTED_SOURCE = Object.freeze({
  workspace: "triatwin-dev-fabric",
  database: "mining-d01-realtime",
});
export const CRITICAL_TAGS = Object.freeze(
  ["A", "B", "C"].map((line) => `D01.${line}.crusher.ore_flow`),
);

const RUN_ID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const POLL_INTERVAL_MS = 30_000;
const MAX_POLL_GAP_MS = 60_000;
const MAX_AS_OF_AGE_MS = 90_000;
const MAX_WATERMARK_AGE_MS = 105_000;
const WINDOW_MS = 300_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_EVIDENCE_RECORDS = 160;
const MAX_EVIDENCE_RECORD_BYTES = 16 * 1024;
const MAX_EVIDENCE_BYTES = 512 * 1024;

class ObserverFailure extends Error {
  constructor(code, httpStatus) {
    super(code);
    this.name = "ObserverFailure";
    this.code = code;
    if (Number.isInteger(httpStatus)) this.httpStatus = httpStatus;
  }
}

function fail(code, httpStatus) {
  throw new ObserverFailure(code, httpStatus);
}

function requireValue(condition, code) {
  if (!condition) fail(code);
}

function parseUtc(value) {
  if (typeof value !== "string" || !UTC.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function validateInputs(input) {
  if (!input || !RUN_ID_V4.test(input.runId ?? "")) fail("invalid_run_id");
  if (!GENERATION.test(input.generation ?? "")) fail("invalid_generation");
  const durationText = String(input.durationMinutes);
  if (!["15", "35"].includes(durationText)) fail("invalid_duration");
  const durationMinutes = Number(durationText);
  return { runId: input.runId, generation: input.generation, durationMinutes };
}

function assertSource(source) {
  requireValue(
    source?.workspace === EXPECTED_SOURCE.workspace &&
      source?.database === EXPECTED_SOURCE.database,
    "source_mismatch",
  );
}

function assertAuthority(run, expected, now) {
  requireValue(run && typeof run === "object", "missing_owner");
  requireValue(
    run.plantId === "D01" &&
      run.runId === expected.runId &&
      run.generation === expected.generation &&
      run.catalogVersion === EXPECTED_CATALOG,
    "owner_scope_mismatch",
  );
  requireValue(run.publisherStatus === "running", "owner_not_running");
  requireValue(run.stopRequested === false, "owner_stop_requested");
  const authorityUntil = parseUtc(run.authorityUntil);
  requireValue(authorityUntil !== null, "invalid_owner_authority");
  requireValue(authorityUntil > now, "owner_authority_expired");
  return authorityUntil;
}

function assertContext(data, expected, now) {
  requireValue(data?.mode === "continuous", "unexpected_mode");
  requireValue(data.plantId === "D01", "plant_mismatch");
  requireValue(data.catalogVersion === EXPECTED_CATALOG, "catalog_mismatch");
  requireValue(data.readAvailable === true, "continuous_read_disabled");
  requireValue(
    data.capabilities?.incidents === false && data.capabilities?.trends === false,
    "unsupported_capability_contract",
  );
  assertSource(data.source);
  const authorityUntil = assertAuthority(data.approvedRun, expected, now);
  return {
    runId: data.approvedRun.runId,
    generation: data.approvedRun.generation,
    publisherStatus: data.approvedRun.publisherStatus,
    stopRequested: data.approvedRun.stopRequested,
    authorityUntil: new Date(authorityUntil).toISOString(),
    source: { ...EXPECTED_SOURCE },
    readAvailable: true,
  };
}

function assertOverview(data, expected, observedAt) {
  requireValue(data?.mode === "continuous", "unexpected_mode");
  requireValue(
    data.plantId === "D01" &&
      data.runId === expected.runId &&
      data.generation === expected.generation &&
      data.catalogVersion === EXPECTED_CATALOG,
    "overview_scope_mismatch",
  );
  assertSource(data.source);
  requireValue(
    data.capabilities?.incidents === false && data.capabilities?.trends === false,
    "unsupported_capability_contract",
  );
  const authorityUntil = assertAuthority(data.run, expected, observedAt);
  const asOf = parseUtc(data.asOf);
  const watermark = parseUtc(data.watermark);
  const windowStart = parseUtc(data.windowStart);
  const windowEnd = parseUtc(data.windowEnd);
  requireValue(asOf !== null && asOf <= observedAt, "invalid_as_of");
  requireValue(observedAt - asOf <= MAX_AS_OF_AGE_MS, "stale_as_of");
  requireValue(
    watermark !== null &&
      watermark <= asOf &&
      observedAt - watermark <= MAX_WATERMARK_AGE_MS &&
      asOf - watermark <= MAX_WATERMARK_AGE_MS,
    "stale_watermark",
  );
  requireValue(
    windowStart === watermark - WINDOW_MS && windowEnd === watermark,
    "invalid_rolling_window",
  );
  requireValue(
    Number.isFinite(data.watermarkLagSeconds) &&
      Math.abs(data.watermarkLagSeconds - (asOf - watermark) / 1000) <= 0.001,
    "invalid_watermark_lag",
  );
  requireValue(data.quality === "good", "source_not_ready");
  requireValue(
    data.throughput?.quality === "good" &&
      data.throughput.unit === "t/h" &&
      Number.isFinite(data.throughput.value) &&
      Number.isFinite(data.throughput.coverage) &&
      data.throughput.coverage >= 0.9 &&
      data.throughput.coverage <= 1,
    "invalid_throughput",
  );
  requireValue(
    Array.isArray(data.readings) && data.readings.length === CRITICAL_TAGS.length,
    "invalid_tag_set",
  );
  requireValue(
    new Set(data.readings.map((row) => row?.tagId)).size === CRITICAL_TAGS.length &&
      data.readings.every((row) => CRITICAL_TAGS.includes(row?.tagId)),
    "invalid_tag_set",
  );

  const readings = data.readings.map((row) => {
    const sampleTime = parseUtc(row.sampleTime);
    const receivedAt = parseUtc(row.receivedAt);
    const latestSampleTime = parseUtc(row.latestSampleTime);
    const latestReceivedAt = parseUtc(row.latestReceivedAt);
    const ageSeconds = (asOf - latestSampleTime) / 1000;
    requireValue(
      row.quality === "good" &&
        row.sourceStatus === "READY" &&
        row.unit === "t/h" &&
        Number.isFinite(row.value) &&
        Number.isFinite(row.average) &&
        Number.isFinite(row.coverage) &&
        row.coverage >= 0.9 &&
        row.coverage <= 1 &&
        Number.isSafeInteger(row.sampleCount) &&
        row.sampleCount >= 9 &&
        row.sampleCount <= 10 &&
        row.usableSamples === row.sampleCount &&
        Number.isFinite(row.ageSeconds) &&
        Math.abs(row.ageSeconds - ageSeconds) <= 0.001,
      "invalid_tag_reading",
    );
    requireValue(
      sampleTime === watermark &&
        receivedAt !== null &&
        sampleTime <= receivedAt &&
        receivedAt <= asOf &&
        latestSampleTime !== null &&
        watermark <= latestSampleTime &&
        latestSampleTime <= asOf &&
        latestReceivedAt !== null &&
        latestSampleTime <= latestReceivedAt &&
        latestReceivedAt <= asOf &&
        asOf - latestSampleTime <= MAX_WATERMARK_AGE_MS,
      "invalid_tag_timestamps",
    );
    requireValue(/^[0-9a-f]{64}$/.test(row.eventId ?? ""), "invalid_event_id");
    return {
      tagId: row.tagId,
      sourceStatus: row.sourceStatus,
      quality: row.quality,
      unit: row.unit,
      sampleTime: row.sampleTime,
      sampleTimeMs: sampleTime,
      receivedAt: row.receivedAt,
      receivedAtMs: receivedAt,
      latestSampleTime: row.latestSampleTime,
      latestSampleTimeMs: latestSampleTime,
      latestReceivedAt: row.latestReceivedAt,
      latestReceivedAtMs: latestReceivedAt,
      value: row.value,
      average: row.average,
      coverage: row.coverage,
      sampleCount: row.sampleCount,
      ageSeconds: row.ageSeconds,
      eventId: row.eventId,
    };
  });
  const total = readings.reduce((sum, row) => sum + row.average, 0);
  requireValue(Math.abs(data.throughput.value - total) < 0.00001, "throughput_sum_mismatch");
  return {
    asOf: data.asOf,
    asOfMs: asOf,
    watermark: data.watermark,
    watermarkMs: watermark,
    watermarkLagSeconds: data.watermarkLagSeconds,
    windowStart: data.windowStart,
    windowEnd: data.windowEnd,
    throughput: data.throughput.value,
    throughputCoverage: data.throughput.coverage,
    publisherStatus: data.run.publisherStatus,
    stopRequested: data.run.stopRequested,
    authorityUntil: new Date(authorityUntil).toISOString(),
    source: { ...EXPECTED_SOURCE },
    readings,
  };
}

async function readBoundedJson(response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    await response.body?.cancel().catch(() => {});
    fail("invalid_content_type");
  }
  const reader = response.body?.getReader();
  let text;
  if (!reader) {
    text = await response.text();
    requireValue(Buffer.byteLength(text, "utf8") <= MAX_RESPONSE_BYTES, "response_too_large");
  } else {
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          fail("response_too_large");
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    text = Buffer.concat(chunks).toString("utf8");
  }
  try {
    return JSON.parse(text);
  } catch {
    fail("invalid_json");
  }
}

async function getPublicJson(url, fetchImpl) {
  let response;
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal,
    });
  } catch (cause) {
    fail(cause?.name === "TimeoutError" ? "request_timeout" : "request_failed");
  }
  if (response.redirected) {
    await response.body?.cancel().catch(() => {});
    fail("redirect_rejected");
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    fail("public_http_error", response.status);
  }
  try {
    return await readBoundedJson(response);
  } catch (cause) {
    if (signal.aborted) fail("request_timeout");
    throw cause;
  }
}

function contextUrl() {
  return new URL("/api/mining/context", PUBLIC_ORIGIN).href;
}

function overviewUrl(runId) {
  const url = new URL("/api/mining/overview", PUBLIC_ORIGIN);
  url.searchParams.set("plantId", "D01");
  url.searchParams.set("runId", runId);
  return url.href;
}

function checkClock(previous, current) {
  const wallDelta = current.wall - previous.wall;
  const monotonicDelta = current.monotonic - previous.monotonic;
  requireValue(wallDelta > 0 && monotonicDelta > 0, "clock_moved_backwards");
  requireValue(
    wallDelta <= MAX_POLL_GAP_MS && monotonicDelta <= MAX_POLL_GAP_MS,
    "observation_gap_exceeded",
  );
  requireValue(Math.abs(wallDelta - monotonicDelta) <= 5_000, "clock_diverged");
}

function checkFeedTimestamps(previous, current) {
  requireValue(current.watermarkMs >= previous.watermarkMs, "watermark_moved_backwards");
  const previousReadings = new Map(previous.readings.map((reading) => [reading.tagId, reading]));
  for (const reading of current.readings) {
    const prior = previousReadings.get(reading.tagId);
    requireValue(
      reading.latestSampleTimeMs >= prior.latestSampleTimeMs,
      "measurement_time_moved_backwards",
    );
    requireValue(
      reading.latestReceivedAtMs >= prior.latestReceivedAtMs &&
        reading.receivedAtMs >= prior.receivedAtMs,
      "receipt_time_moved_backwards",
    );
  }
}

function publicReadingRecord(reading) {
  return {
    tagId: reading.tagId,
    sourceStatus: reading.sourceStatus,
    quality: reading.quality,
    unit: reading.unit,
    sampleTime: reading.sampleTime,
    receivedAt: reading.receivedAt,
    latestSampleTime: reading.latestSampleTime,
    latestReceivedAt: reading.latestReceivedAt,
    value: reading.value,
    average: reading.average,
    coverage: reading.coverage,
    sampleCount: reading.sampleCount,
    ageSeconds: reading.ageSeconds,
    eventId: reading.eventId,
  };
}

export async function observeContinuousFlow(input, dependencies = {}) {
  const nowWall = dependencies.nowWall ?? Date.now;
  const nowMonotonic = dependencies.nowMonotonic ?? (() => performance.now());
  const sleep = dependencies.sleep ?? ((milliseconds) => wait(milliseconds));
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const onEvidence = dependencies.onEvidence ?? (async () => {});
  const observationStartedWall = nowWall();
  const summary = {
    schemaVersion: 1,
    gate: "public-continuous-flow-observer",
    status: "failed",
    startedAt: new Date(observationStartedWall).toISOString(),
    finishedAt: null,
    durationMinutes: null,
    runId: null,
    generation: null,
    samplesObserved: 0,
    observedDurationMs: 0,
    firstAsOf: null,
    lastAsOf: null,
    asOfAdvanceMs: null,
    firstWatermark: null,
    lastWatermark: null,
    watermarkAdvanceMs: null,
    tagProgress: [],
    evidenceRecords: 0,
    failureCode: null,
    httpStatus: null,
  };
  const series = new Map(
    CRITICAL_TAGS.map((tagId) => [tagId, { eventIds: new Set(), first: null, last: null }]),
  );
  let firstPoll;
  let previousPoll;
  let priorRequestStart;
  let lastPoll;
  let expected;

  const emit = async (record) => {
    try {
      await onEvidence(record);
      summary.evidenceRecords += 1;
    } catch {
      fail("evidence_write_failed");
    }
  };

  const updateTagProgress = (readings) => {
    for (const reading of readings) {
      const state = series.get(reading.tagId);
      const latestSampleTime = parseUtc(reading.latestSampleTime);
      const latestReceivedAt = parseUtc(reading.latestReceivedAt);
      state.eventIds.add(reading.eventId);
      if (!state.first) state.first = { latestSampleTime, latestReceivedAt };
      state.last = { latestSampleTime, latestReceivedAt };
    }
  };

  const refreshProgressSummary = () => {
    const durationMs = summary.durationMinutes === null ? 0 : summary.durationMinutes * 60_000;
    const minimumAdvanceMs = Math.max(0, durationMs - MAX_WATERMARK_AGE_MS);
    const minimumDistinctEvents = Math.max(1, Math.floor(minimumAdvanceMs / POLL_INTERVAL_MS));
    summary.asOfAdvanceMs =
      summary.firstAsOf && summary.lastAsOf
        ? parseUtc(summary.lastAsOf) - parseUtc(summary.firstAsOf)
        : null;
    summary.watermarkAdvanceMs =
      summary.firstWatermark && summary.lastWatermark
        ? parseUtc(summary.lastWatermark) - parseUtc(summary.firstWatermark)
        : null;
    summary.tagProgress = CRITICAL_TAGS.map((tagId) => {
      const state = series.get(tagId);
      return {
        tagId,
        measurementAdvanceMs:
          state.first && state.last
            ? state.last.latestSampleTime - state.first.latestSampleTime
            : null,
        receiptAdvanceMs:
          state.first && state.last
            ? state.last.latestReceivedAt - state.first.latestReceivedAt
            : null,
        distinctEventIds: state.eventIds.size,
        requiredDistinctEventIds: minimumDistinctEvents,
      };
    });
    return { minimumAdvanceMs, minimumDistinctEvents };
  };

  try {
    expected = validateInputs(input);
    Object.assign(summary, expected);
    await emit({
      kind: "start",
      observedAt: new Date(nowWall()).toISOString(),
      durationMinutes: expected.durationMinutes,
      runId: expected.runId,
      generation: expected.generation,
      source: { ...EXPECTED_SOURCE },
    });

    const initialContext = await getPublicJson(contextUrl(), fetchImpl);
    const initialOwner = assertContext(initialContext, expected, nowWall());
    await emit({
      kind: "owner-check",
      phase: "initial",
      observedAt: new Date(nowWall()).toISOString(),
      ...initialOwner,
    });

    const durationMs = expected.durationMinutes * 60_000;
    while (true) {
      const requestStartWall = nowWall();
      const requestStartMonotonic = nowMonotonic();
      const data = await getPublicJson(overviewUrl(expected.runId), fetchImpl);
      const observedAt = nowWall();
      const observedMonotonic = nowMonotonic();
      const current = assertOverview(data, expected, observedAt);
      const poll = { wall: observedAt, monotonic: observedMonotonic };
      if (previousPoll) {
        checkClock(previousPoll, poll);
        requireValue(current.asOfMs > previousPoll.asOfTime, "as_of_not_advancing");
        checkFeedTimestamps(previousPoll, current);
      } else {
        firstPoll = { ...poll, asOfTime: current.asOfMs };
      }
      if (previousPoll) {
        // The API is uncached and its request UTC must progress with actual observation time.
        const asOfDelta = current.asOfMs - previousPoll.asOfTime;
        requireValue(asOfDelta > 0 && asOfDelta <= MAX_POLL_GAP_MS, "as_of_gap_exceeded");
      }
      updateTagProgress(current.readings);
      summary.samplesObserved += 1;
      summary.firstAsOf ??= current.asOf;
      summary.lastAsOf = current.asOf;
      summary.firstWatermark ??= current.watermark;
      summary.lastWatermark = current.watermark;
      lastPoll = { ...poll, asOfTime: current.asOfMs };
      await emit({
        kind: "sample",
        index: summary.samplesObserved,
        requestStartedAt: new Date(requestStartWall).toISOString(),
        observedAt: new Date(observedAt).toISOString(),
        asOf: current.asOf,
        watermark: current.watermark,
        watermarkLagSeconds: current.watermarkLagSeconds,
        windowStart: current.windowStart,
        windowEnd: current.windowEnd,
        throughput: current.throughput,
        throughputCoverage: current.throughputCoverage,
        runId: expected.runId,
        generation: expected.generation,
        publisherStatus: current.publisherStatus,
        stopRequested: current.stopRequested,
        authorityUntil: current.authorityUntil,
        source: current.source,
        readings: current.readings.map(publicReadingRecord),
      });

      if (observedMonotonic - firstPoll.monotonic >= durationMs) break;
      previousPoll = {
        ...poll,
        asOfTime: current.asOfMs,
        watermarkMs: current.watermarkMs,
        readings: current.readings,
      };
      priorRequestStart = requestStartMonotonic;
      const nextRequestAt = priorRequestStart + POLL_INTERVAL_MS;
      const delay = Math.max(0, nextRequestAt - nowMonotonic());
      if (delay > 0) await sleep(delay);
    }

    summary.observedDurationMs = Math.round(lastPoll.monotonic - firstPoll.monotonic);
    requireValue(summary.observedDurationMs >= durationMs, "observation_too_short");
    const { minimumAdvanceMs, minimumDistinctEvents } = refreshProgressSummary();
    requireValue(
      summary.tagProgress.every(
        (tag) =>
          tag.measurementAdvanceMs >= minimumAdvanceMs &&
          tag.receiptAdvanceMs >= minimumAdvanceMs &&
          tag.distinctEventIds >= minimumDistinctEvents,
      ),
      "source_progress_insufficient",
    );
    requireValue(summary.asOfAdvanceMs >= minimumAdvanceMs, "as_of_span_insufficient");
    requireValue(summary.watermarkAdvanceMs >= minimumAdvanceMs, "watermark_progress_insufficient");

    const finalContext = await getPublicJson(contextUrl(), fetchImpl);
    const finalOwner = assertContext(finalContext, expected, nowWall());
    await emit({
      kind: "owner-check",
      phase: "final",
      observedAt: new Date(nowWall()).toISOString(),
      ...finalOwner,
    });
    summary.status = "passed";
  } catch (error) {
    summary.failureCode = error instanceof ObserverFailure ? error.code : "observer_failed";
    summary.httpStatus = error instanceof ObserverFailure ? (error.httpStatus ?? null) : null;
    summary.observedDurationMs =
      firstPoll && lastPoll ? Math.max(0, Math.round(lastPoll.monotonic - firstPoll.monotonic)) : 0;
    refreshProgressSummary();
    if (summary.failureCode !== "evidence_write_failed") {
      try {
        await emit({
          kind: "failure",
          observedAt: new Date(nowWall()).toISOString(),
          code: summary.failureCode,
          ...(summary.httpStatus === null ? {} : { httpStatus: summary.httpStatus }),
        });
      } catch {
        summary.failureCode = "evidence_write_failed";
      }
    }
  }

  summary.finishedAt = new Date(nowWall()).toISOString();
  if (summary.status !== "passed" && !summary.failureCode) {
    summary.failureCode = "observer_failed";
  }
  return summary;
}

export async function observeContinuousFlowToFiles(input, outputDirectory, dependencies = {}) {
  const directory = resolve(outputDirectory);
  const evidencePath = resolve(directory, "evidence.jsonl");
  const summaryPath = resolve(directory, "summary.json");
  await mkdir(directory, { recursive: true });
  await writeFile(evidencePath, "", "utf8");
  let recordCount = 0;
  let evidenceBytes = 0;
  const onEvidence = async (record) => {
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    if (
      recordCount >= MAX_EVIDENCE_RECORDS ||
      bytes > MAX_EVIDENCE_RECORD_BYTES ||
      evidenceBytes + bytes > MAX_EVIDENCE_BYTES
    ) {
      throw new Error("evidence_limit");
    }
    await appendFile(evidencePath, line, "utf8");
    recordCount += 1;
    evidenceBytes += bytes;
  };
  let summary;
  try {
    summary = await observeContinuousFlow(input, { ...dependencies, onEvidence });
  } catch {
    summary = {
      schemaVersion: 1,
      gate: "public-continuous-flow-observer",
      status: "failed",
      failureCode: "observer_setup_failed",
      finishedAt: new Date().toISOString(),
    };
  }
  summary.evidenceRecords = recordCount;
  summary.evidenceBytes = evidenceBytes;
  try {
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  } catch {
    summary.status = "failed";
    summary.failureCode = "summary_write_failed";
  }
  return summary;
}

async function main() {
  const outputDirectory = resolve(
    process.env.MINING_OBSERVER_OUTPUT_DIR ?? "artifacts/mining-continuous-flow",
  );
  let summary;
  try {
    summary = await observeContinuousFlowToFiles(
      {
        runId: process.env.MINING_OBSERVER_RUN_ID,
        generation: process.env.MINING_OBSERVER_GENERATION,
        durationMinutes: process.env.MINING_OBSERVER_DURATION_MINUTES,
      },
      outputDirectory,
    );
  } catch {
    summary = {
      schemaVersion: 1,
      gate: "public-continuous-flow-observer",
      status: "failed",
      failureCode: "observer_setup_failed",
      finishedAt: new Date().toISOString(),
    };
  }
  console.log(JSON.stringify(summary));
  if (summary?.status !== "passed") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
