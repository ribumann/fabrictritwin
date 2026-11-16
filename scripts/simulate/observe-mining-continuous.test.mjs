import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  CRITICAL_TAGS,
  EXPECTED_CATALOG,
  EXPECTED_SOURCE,
  PUBLIC_ORIGIN,
  observeContinuousFlow,
  observeContinuousFlowToFiles,
  validateInputs,
} from "./observe-mining-continuous.mjs";

const BASE_TIME = Date.parse("2026-11-16T18:00:00.000Z");
const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const GENERATION = "test-generation-001";

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function owner(wall, overrides = {}) {
  return {
    plantId: "D01",
    runId: RUN_ID,
    catalogVersion: EXPECTED_CATALOG,
    publisherStatus: "running",
    ingestionStatus: "unknown",
    generation: GENERATION,
    authorityUntil: new Date(wall + 120_000).toISOString(),
    stopRequested: false,
    ...overrides,
  };
}

function context(wall, overrides = {}) {
  return {
    plantId: "D01",
    mode: "continuous",
    approvedRun: owner(wall),
    source: { ...EXPECTED_SOURCE },
    catalogVersion: EXPECTED_CATALOG,
    readAvailable: true,
    assistant: { available: false, kind: "bounded-fabric-evidence" },
    capabilities: { incidents: false, trends: false, replay: false, assistant: false },
    ...overrides,
  };
}

function overview(wall, index, overrides = {}) {
  const asOf = new Date(wall).toISOString();
  const watermark = new Date(wall - 2_000).toISOString();
  const readings = CRITICAL_TAGS.map((tagId, tagIndex) => {
    const value = 100 + index + tagIndex;
    return {
      tagId,
      sourceStatus: "READY",
      quality: "good",
      unit: "t/h",
      sampleTime: watermark,
      receivedAt: new Date(wall - 1_000).toISOString(),
      latestSampleTime: watermark,
      latestReceivedAt: new Date(wall - 1_000).toISOString(),
      eventId: createHash("sha256").update(`${tagId}:${index}`).digest("hex"),
      value,
      average: value,
      coverage: 1,
      observationCoverage: 1,
      sampleCount: 10,
      usableSamples: 10,
      ageSeconds: 2,
    };
  });
  const data = {
    mode: "continuous",
    plantId: "D01",
    runId: RUN_ID,
    generation: GENERATION,
    catalogVersion: EXPECTED_CATALOG,
    asOf,
    quality: "good",
    watermark,
    watermarkLagSeconds: 2,
    windowStart: new Date(wall - 302_000).toISOString(),
    windowEnd: watermark,
    throughput: {
      value: readings.reduce((sum, row) => sum + row.average, 0),
      unit: "t/h",
      quality: "good",
      coverage: 1,
    },
    readings,
    run: owner(wall),
    source: { ...EXPECTED_SOURCE },
    capabilities: { incidents: false, trends: false, assistant: false, replay: false },
  };
  return {
    ...data,
    ...overrides,
  };
}

function withWatermark(body, watermarkMs, options = {}) {
  const asOfMs = Date.parse(body.asOf);
  const watermark = new Date(watermarkMs).toISOString();
  const readings = body.readings.map((row) => {
    const latestSampleMs = options.latestSampleTimes?.[row.tagId] ?? watermarkMs;
    const latestReceivedMs = options.latestReceivedTimes?.[row.tagId] ?? latestSampleMs + 1_000;
    const value = options.values?.[row.tagId] ?? row.value;
    const average = options.averages?.[row.tagId] ?? row.average;
    return {
      ...row,
      sampleTime: watermark,
      receivedAt: new Date(watermarkMs + 1_000).toISOString(),
      latestSampleTime: new Date(latestSampleMs).toISOString(),
      latestReceivedAt: new Date(latestReceivedMs).toISOString(),
      eventId: createHash("sha256").update(`${row.tagId}:${watermark}`).digest("hex"),
      value,
      average,
      ageSeconds: (asOfMs - latestSampleMs) / 1000,
    };
  });
  return {
    ...body,
    watermark,
    watermarkLagSeconds: (asOfMs - watermarkMs) / 1000,
    windowStart: new Date(watermarkMs - 300_000).toISOString(),
    windowEnd: watermark,
    readings,
    throughput: {
      ...body.throughput,
      value: readings.reduce((sum, row) => sum + row.average, 0),
    },
  };
}

function harness({ mutateContext, mutateOverview, sleepDelta = 0 } = {}) {
  let wall = BASE_TIME;
  let monotonic = 0;
  let observation = 0;
  const calls = [];
  const evidence = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const parsed = new URL(String(url));
    if (parsed.origin !== PUBLIC_ORIGIN) return response({ error: "wrong origin" }, 500);
    if (init.method !== "GET") return response({ error: "wrong method" }, 405);
    if (parsed.pathname === "/api/mining/context") {
      const body = context(wall);
      return response(mutateContext ? mutateContext(body, observation) : body);
    }
    if (parsed.pathname !== "/api/mining/overview") return response({}, 404);
    observation += 1;
    const body = overview(wall, observation);
    return response(mutateOverview ? mutateOverview(body, observation) : body);
  };
  return {
    calls,
    evidence,
    fetchImpl,
    nowWall: () => wall,
    nowMonotonic: () => monotonic,
    sleep: async (milliseconds) => {
      const delta = sleepDelta || milliseconds;
      wall += delta;
      monotonic += delta;
    },
    onEvidence: async (record) => evidence.push(record),
    advance(milliseconds) {
      wall += milliseconds;
      monotonic += milliseconds;
    },
    adjustWall(milliseconds) {
      wall += milliseconds;
    },
  };
}

const validInput = {
  runId: RUN_ID,
  generation: GENERATION,
  durationMinutes: "15",
};

describe("read-only public Mining continuous-flow observer", () => {
  it("accepts only a v4 run, bounded generation identifier, and 15/35-minute duration", () => {
    assert.deepEqual(validateInputs(validInput), {
      runId: RUN_ID,
      generation: GENERATION,
      durationMinutes: 15,
    });
    assert.throws(() => validateInputs({ ...validInput, runId: "not-a-uuid" }), {
      code: "invalid_run_id",
    });
    assert.throws(() => validateInputs({ ...validInput, generation: "bad\nvalue" }), {
      code: "invalid_generation",
    });
    assert.throws(() => validateInputs({ ...validInput, durationMinutes: "20" }), {
      code: "invalid_duration",
    });
    assert.throws(() => validateInputs({ ...validInput, durationMinutes: "15.0" }), {
      code: "invalid_duration",
    });
  });

  it("observes a full 15-minute flow through fixed unauthenticated GETs and records bounded evidence", async () => {
    const test = harness();
    const summary = await observeContinuousFlow(validInput, test);

    assert.equal(summary.status, "passed");
    assert.equal(summary.observedDurationMs, 15 * 60_000);
    assert.equal(summary.asOfAdvanceMs, 15 * 60_000);
    assert.equal(summary.watermarkAdvanceMs, 15 * 60_000);
    assert.equal(summary.samplesObserved, 31);
    assert.equal(summary.tagProgress.length, 3);
    assert.ok(
      summary.tagProgress.every((tag) => tag.measurementAdvanceMs >= 15 * 60_000 - 105_000),
    );
    assert.ok(summary.tagProgress.every((tag) => tag.receiptAdvanceMs >= 15 * 60_000 - 105_000));
    assert.ok(
      summary.tagProgress.every((tag) => tag.distinctEventIds >= tag.requiredDistinctEventIds),
    );
    assert.equal(test.evidence.filter((record) => record.kind === "owner-check").length, 2);
    assert.equal(test.evidence.filter((record) => record.kind === "sample").length, 31);
    assert.ok(
      test.calls.every(
        ({ url, init }) =>
          url.startsWith(PUBLIC_ORIGIN) &&
          init.method === "GET" &&
          init.credentials === "omit" &&
          init.redirect === "error" &&
          !Object.keys(init.headers).some((name) => name.toLowerCase() === "authorization"),
      ),
    );
    const overviewCall = test.calls.find(({ url }) => url.includes("/api/mining/overview"));
    const overviewUrl = new URL(overviewCall.url);
    assert.equal(overviewUrl.searchParams.get("plantId"), "D01");
    assert.equal(overviewUrl.searchParams.get("runId"), RUN_ID);
    assert.equal(overviewUrl.searchParams.has("asOf"), false);
  });

  it("supports the 35-minute observation choice", async () => {
    const test = harness();
    const summary = await observeContinuousFlow({ ...validInput, durationMinutes: "35" }, test);

    assert.equal(summary.status, "passed");
    assert.equal(summary.observedDurationMs, 35 * 60_000);
    assert.equal(summary.samplesObserved, 71);
    assert.equal(summary.asOfAdvanceMs, 35 * 60_000);
    assert.ok(summary.tagProgress.every((tag) => tag.distinctEventIds >= 66));
  });

  it("fails closed when the public route is misbound or the current owner changed", async () => {
    const wrongMode = harness({
      mutateContext: (body) => ({ ...body, mode: undefined }),
    });
    const wrongModeResult = await observeContinuousFlow(validInput, wrongMode);
    assert.equal(wrongModeResult.failureCode, "unexpected_mode");
    assert.equal(wrongModeResult.samplesObserved, 0);

    const changedOwner = harness({
      mutateContext: (body, observation) =>
        observation > 0
          ? {
              ...body,
              approvedRun: { ...body.approvedRun, generation: "mining-next-generation" },
            }
          : body,
    });
    const changedOwnerResult = await observeContinuousFlow(validInput, changedOwner);
    assert.equal(changedOwnerResult.failureCode, "owner_scope_mismatch");
    assert.ok(changedOwnerResult.samplesObserved > 0);
  });

  it("rejects stale, malformed, not-ready, and wrongly scoped observations", async (t) => {
    const cases = [
      [
        "stale watermark",
        (body) => ({ ...body, watermark: "2026-11-16T17:55:00.000Z" }),
        "stale_watermark",
      ],
      [
        "bad receipt order",
        (body) => ({
          ...body,
          readings: body.readings.map((row) => ({
            ...row,
            receivedAt: "2026-11-16T17:59:57.000Z",
          })),
        }),
        "invalid_tag_timestamps",
      ],
      [
        "source not ready",
        (body) => ({
          ...body,
          readings: body.readings.map((row) => ({ ...row, sourceStatus: "UNKNOWN" })),
        }),
        "invalid_tag_reading",
      ],
      [
        "wrong source",
        (body) => ({
          ...body,
          source: { workspace: "mining-d01-native-agent-demo", database: EXPECTED_SOURCE.database },
        }),
        "source_mismatch",
      ],
    ];
    for (const [name, mutate, failureCode] of cases) {
      await t.test(name, async () => {
        const test = harness({
          mutateOverview: (body, index) => (index === 1 ? mutate(body) : body),
        });
        const summary = await observeContinuousFlow(validInput, test);
        assert.equal(summary.failureCode, failureCode);
        assert.equal(summary.samplesObserved, 0);
      });
    }
  });

  it("rejects a suspended observer, non-advancing timestamps, and a regressing watermark", async (t) => {
    await t.test("gap over 60 seconds", async () => {
      const test = harness({ sleepDelta: 61_000 });
      const summary = await observeContinuousFlow(validInput, test);
      assert.equal(summary.failureCode, "observation_gap_exceeded");
    });
    await t.test("wall and monotonic clocks diverge", async () => {
      const test = harness();
      const baseSleep = test.sleep;
      test.sleep = async (milliseconds) => {
        await baseSleep(milliseconds);
        test.adjustWall(-6_000);
      };
      const summary = await observeContinuousFlow(validInput, test);
      assert.equal(summary.failureCode, "clock_diverged");
    });
    await t.test("repeated asOf", async () => {
      const test = harness({
        mutateOverview: (body, index) => (index === 2 ? overview(BASE_TIME, index) : body),
      });
      const summary = await observeContinuousFlow(validInput, test);
      assert.equal(summary.failureCode, "as_of_not_advancing");
    });
    await t.test("watermark regresses before a later recovery", async () => {
      const test = harness({
        mutateOverview: (body, index) =>
          index === 2 ? withWatermark(body, BASE_TIME - 3_000) : body,
      });
      const summary = await observeContinuousFlow(validInput, test);
      assert.equal(summary.failureCode, "watermark_moved_backwards");
      assert.equal(summary.samplesObserved, 1);
    });
    await t.test(
      "per-tag latest measurement regresses while common watermark is unchanged",
      async () => {
        const tagC = CRITICAL_TAGS[2];
        const test = harness({
          mutateOverview: (body, index) =>
            withWatermark(body, BASE_TIME - 2_000, {
              latestSampleTimes: {
                [tagC]: index === 1 ? BASE_TIME - 1_000 : BASE_TIME - 2_000,
              },
            }),
        });
        const summary = await observeContinuousFlow(validInput, test);
        assert.equal(summary.failureCode, "measurement_time_moved_backwards");
        assert.equal(summary.samplesObserved, 1);
      },
    );
    await t.test("per-tag latest receipt regresses while measurement is equal", async () => {
      const tagC = CRITICAL_TAGS[2];
      const test = harness({
        mutateOverview: (_body, index) =>
          withWatermark(overview(BASE_TIME + (index - 1) * 30_000, index), BASE_TIME - 2_000, {
            latestSampleTimes: { [tagC]: BASE_TIME - 1_000 },
            latestReceivedTimes: {
              [tagC]: index === 1 ? BASE_TIME : BASE_TIME - 500,
            },
          }),
      });
      const summary = await observeContinuousFlow(validInput, test);
      assert.equal(summary.failureCode, "receipt_time_moved_backwards");
      assert.equal(summary.samplesObserved, 1);
    });
    await t.test("equal source timestamps are allowed during batching", async () => {
      let first;
      const test = harness({
        mutateOverview: (body, index) => {
          if (index === 1) {
            first = withWatermark(body, BASE_TIME - 2_000);
            return first;
          }
          if (index === 2) {
            const current = withWatermark(body, BASE_TIME - 2_000);
            const previousReadings = new Map(
              first.readings.map((reading) => [reading.tagId, reading]),
            );
            const readings = current.readings.map((reading) => {
              const previous = previousReadings.get(reading.tagId);
              return {
                ...reading,
                value: previous.value,
                average: previous.average,
                eventId: previous.eventId,
              };
            });
            return {
              ...current,
              readings,
              throughput: { ...current.throughput, value: first.throughput.value },
            };
          }
          return body;
        },
      });
      const summary = await observeContinuousFlow(validInput, test);
      assert.equal(summary.status, "passed");
      assert.equal(summary.failureCode, null);
    });
  });

  it("accepts constant numeric values when timestamps and event IDs advance", async () => {
    const test = harness({
      mutateOverview: (body) => {
        const readings = body.readings.map((row, index) => ({
          ...row,
          value: 200 + index,
          average: 200 + index,
        }));
        return {
          ...body,
          readings,
          throughput: {
            ...body.throughput,
            value: readings.reduce((sum, row) => sum + row.average, 0),
          },
        };
      },
    });
    const summary = await observeContinuousFlow(validInput, test);

    assert.equal(summary.status, "passed");
    assert.ok(summary.tagProgress.every((tag) => tag.distinctEventIds === 31));
  });

  it("writes a terminal failure record for a public HTTP error without retaining its body", async () => {
    const test = harness();
    test.fetchImpl = async (url, init) => {
      if (String(url).includes("/api/mining/context")) {
        return response(context(test.nowWall()));
      }
      return response({ privateDetail: "must not be persisted" }, 503);
    };
    const summary = await observeContinuousFlow(validInput, test);

    assert.equal(summary.status, "failed");
    assert.equal(summary.failureCode, "public_http_error");
    assert.equal(summary.httpStatus, 503);
    assert.equal(test.evidence.at(-1).kind, "failure");
    assert.equal(JSON.stringify(test.evidence).includes("must not be persisted"), false);
  });

  it("reports public request timeouts explicitly", async () => {
    const test = harness();
    test.fetchImpl = async (url) => {
      if (String(url).includes("/api/mining/context")) {
        return response(context(test.nowWall()));
      }
      throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    };
    const summary = await observeContinuousFlow(validInput, test);
    assert.equal(summary.failureCode, "request_timeout");
  });

  it("writes bounded JSONL and a terminal summary when input validation fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mining-observer-"));
    let requests = 0;
    try {
      const summary = await observeContinuousFlowToFiles(
        { ...validInput, runId: "invalid" },
        directory,
        { fetchImpl: async () => (requests += 1) },
      );
      const evidence = await readFile(join(directory, "evidence.jsonl"), "utf8");
      const terminal = JSON.parse(await readFile(join(directory, "summary.json"), "utf8"));
      assert.equal(summary.failureCode, "invalid_run_id");
      assert.equal(terminal.failureCode, "invalid_run_id");
      assert.equal(evidence.trim().split("\n").length, 1);
      assert.equal(JSON.parse(evidence).code, "invalid_run_id");
      assert.equal(requests, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
