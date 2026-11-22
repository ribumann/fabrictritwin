import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const kql = (name) => readFileSync(resolve(root, "infra/fabric/eventhouse", name), "utf8");
const docs = readFileSync(resolve(root, "docs/mining-connection-flow-fabric.md"), "utf8");

function referenceWindow(events, expected, { allRunEvents = events } = {}) {
  const fingerprintsByEvent = new Map();
  for (const event of allRunEvents) {
    const fingerprints = fingerprintsByEvent.get(event.eventId) ?? new Set();
    fingerprints.add(event.fingerprint);
    fingerprintsByEvent.set(event.eventId, fingerprints);
  }

  const byPayload = new Map();
  for (const event of events) {
    const key = JSON.stringify([
      event.eventId,
      event.fingerprint,
      event.sampleTime,
      event.streamId ?? "",
      event.measurementTagId ?? "",
    ]);
    const copies = byPayload.get(key) ?? [];
    copies.push(event);
    byPayload.set(key, copies);
  }

  const ticks = new Map();
  let duplicateCount = 0;
  const firstReceipts = [];
  for (const copies of byPayload.values()) {
    duplicateCount += Math.max(0, copies.length - 1);
    const event = copies[0];
    const receipts = copies
      .map((copy) => copy.receivedAt)
      .filter(Boolean)
      .map((receivedAt) => Date.parse(receivedAt));
    if (receipts.length > 0) firstReceipts.push(Math.min(...receipts));
    const atTick = ticks.get(event.sampleTime) ?? [];
    atTick.push({
      ...event,
      eventConflict: (fingerprintsByEvent.get(event.eventId)?.size ?? 0) !== 1,
    });
    ticks.set(event.sampleTime, atTick);
  }

  let sampleCount = 0;
  let badSampleCount = 0;
  let uncertainSampleCount = 0;
  let conflictCount = 0;
  let valueSum = 0;
  let observedTickCount = ticks.size;
  for (const atTick of ticks.values()) {
    const isConflict = atTick.length !== 1 || atTick.some((event) => event.eventConflict);
    if (isConflict) {
      conflictCount += 1;
      continue;
    }
    const event = atTick[0];
    if (event.quality === "good") {
      sampleCount += 1;
      valueSum += event.value;
    } else if (event.quality === "bad") {
      badSampleCount += 1;
    } else if (event.quality === "uncertain") {
      uncertainSampleCount += 1;
    }
  }
  const windowState =
    conflictCount > 0
      ? "CONFLICT"
      : observedTickCount === 0
        ? "MISSING"
        : sampleCount === 0
          ? "UNUSABLE"
          : sampleCount === expected && badSampleCount === 0 && uncertainSampleCount === 0
            ? "COMPLETE"
            : "PARTIAL";
  return {
    observedTickCount,
    sampleCount,
    expected,
    coverage: sampleCount / expected,
    duplicateCount,
    conflictCount,
    firstReceiptAt:
      firstReceipts.length === 0 ? null : new Date(Math.min(...firstReceipts)).toISOString(),
    badSampleCount,
    uncertainSampleCount,
    value: sampleCount === 0 ? null : valueSum / sampleCount,
    windowState,
  };
}

function isRunRelativeTick(startedAt, sampleTime) {
  const offsetMs = Date.parse(sampleTime) - Date.parse(startedAt);
  return offsetMs > 0 && offsetMs % 5_000 === 0;
}

function runRelativeWindowStart(startedAt, sampleTime, windowSeconds) {
  const offsetMs = Date.parse(sampleTime) - Date.parse(startedAt);
  const windowMs = windowSeconds * 1_000;
  return new Date(
    Date.parse(startedAt) + Math.floor((offsetMs - (offsetMs > 0 ? 1 : 0)) / windowMs) * windowMs,
  ).toISOString();
}

function runRelativeWindowStarts(startedAt, fromTime, toTime, windowSeconds) {
  const first = Date.parse(runRelativeWindowStart(startedAt, fromTime, windowSeconds));
  const last = Date.parse(runRelativeWindowStart(startedAt, toTime, windowSeconds));
  const windowMs = windowSeconds * 1_000;
  return Array.from({ length: Math.floor((last - first) / windowMs) + 1 }, (_, index) =>
    new Date(first + index * windowMs).toISOString(),
  );
}

function goodTicks(count = 6) {
  return Array.from({ length: count }, (_, index) => ({
    eventId: `event-${index}`,
    fingerprint: `fingerprint-${index}`,
    sampleTime: `2026-11-22T00:00:${String(index * 5).padStart(2, "0")}.000Z`,
    quality: "good",
    value: index,
  }));
}

function expectedSetOutcome(eventId, rawRows, validatedRows, cutoff) {
  const cutoffMs = Date.parse(cutoff);
  const raw = rawRows.filter(
    (row) => row.eventId === eventId && Date.parse(row.receivedAt) <= cutoffMs,
  );
  const validated = validatedRows.filter(
    (row) =>
      row.eventId === eventId &&
      Date.parse(row.receivedAt) <= cutoffMs &&
      Date.parse(row.ingestedAt) <= cutoffMs,
  );
  const accepted = raw.filter((row) => row.disposition === "ACCEPTED");
  const distinctRaw = new Set(raw.map((row) => row.fingerprint));
  const distinctAccepted = new Set(accepted.map((row) => row.fingerprint));
  const distinctValidated = new Set(validated.map((row) => row.fingerprint));
  const rawConflict =
    raw.length > 1 &&
    (distinctRaw.size !== 1 || (accepted.length > 0 && accepted.length < raw.length));
  const validatedConflict = distinctValidated.size > 1;
  const payloadMismatch =
    accepted.length > 0 &&
    validated.length > 0 &&
    (distinctAccepted.size !== 1 ||
      distinctValidated.size !== 1 ||
      [...distinctAccepted][0] !== [...distinctValidated][0]);
  const status = rawConflict
    ? "RAW_CONFLICT"
    : validatedConflict
      ? "VALIDATED_CONFLICT"
      : payloadMismatch
        ? "RAW_VALIDATED_MISMATCH"
        : raw.length === 0 && validated.length === 0
          ? "MISSING_FROM_RAW_AND_VALIDATED"
          : raw.length === 0
            ? "VALIDATED_WITHOUT_RAW"
            : accepted.length === 0
              ? "RAW_NOT_ACCEPTED"
              : validated.length === 0
                ? "RAW_ONLY"
                : raw.length > 1 || validated.length > 1
                  ? "DUPLICATE_MATCH"
                  : "OBSERVED_MATCH";
  return {
    status,
    rawCopyCount: raw.length,
    validatedCopyCount: validated.length,
    rawDuplicateCopyCount: Math.max(0, raw.length - 1),
    validatedDuplicateCopyCount: Math.max(0, validated.length - 1),
    rawConflict,
    validatedConflict,
    payloadMismatch,
  };
}

function pinSnapshotStatus(pins, cutoff) {
  const cutoffMs = Date.parse(cutoff);
  if (pins.some((pin) => pin.receivedAt === null)) {
    return "RUN_PIN_RECEIPT_TIME_UNAVAILABLE";
  }
  const visiblePins = pins.filter((pin) => Date.parse(pin.receivedAt) <= cutoffMs);
  return visiblePins.length === 1 ? "OK" : "RUN_PIN_MISSING_OR_AMBIGUOUS";
}

test("connection KQL is additive and scopes update policies to new tables", () => {
  const schema = kql("MiningConnectionSchema.kql");
  const materialization = kql("MiningConnectionMaterialization.kql");
  assert.match(schema, /started_at:datetime, pinned_at:datetime/);
  assert.match(schema, /mining_ConnectionMeasurementProfile policy retention softdelete = 36500d/);
  assert.match(schema, /mining_ConnectionMeasurementBinding policy retention softdelete = 36500d/);
  assert.match(schema, /mining_ConnectionRunProfile policy retention softdelete = 7d/);
  assert.match(schema, /mining_ConnectionRunCompletion policy retention softdelete = 7d/);
  assert.match(schema, /mining_ConnectionRunProfile policy ingestiontime true/);
  const createdTables = [...schema.matchAll(/^\.create table (mining_\w+)/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual(createdTables, [
    "mining_ConnectionMeasurementRaw",
    "mining_ConnectionMeasurementProfile",
    "mining_ConnectionMeasurementBinding",
    "mining_ConnectionRunProfile",
    "mining_ConnectionRunCompletion",
    "mining_ValidatedConnectionMeasurement",
    "mining_ConnectionQuarantine",
  ]);
  assert.doesNotMatch(
    schema,
    /mining_(?:TelemetryRaw|PlantStateEvents|ValidatedTelemetry|ValidatedState)\b/,
  );
  assert.doesNotMatch(
    materialization,
    /mining_(?:TelemetryRaw|PlantStateEvents|ValidatedTelemetry|ValidatedState)\b/,
  );
  assert.match(
    schema,
    /mining_ConnectionMeasurementRaw policy streamingingestion '\{"IsEnabled":false\}'/,
  );
  assert.match(schema, /mining_ValidatedConnectionMeasurement policy ingestiontime true/);
  assert.match(
    schema,
    /mining_ConnectionMeasurementBinding policy streamingingestion '\{"IsEnabled":false\}'/,
  );
  assert.match(
    schema,
    /mining_ConnectionRunProfile policy streamingingestion '\{"IsEnabled":false\}'/,
  );

  const policyLines = materialization
    .split(/\r?\n/)
    .filter((line) => line.startsWith(".alter table ") && line.includes(" policy update"));
  assert.equal(policyLines.length, 2);
  for (const line of policyLines) {
    const match = line.match(/^\.alter table (\w+) policy update @'(.+)'$/);
    assert.ok(match, `Expected a single-line update policy: ${line}`);
    const target = match[1];
    const [policy] = JSON.parse(match[2]);
    assert.ok(createdTables.includes(target));
    assert.equal(policy.Source, "mining_ConnectionMeasurementRaw");
    assert.equal(policy.IsTransactional, false);
    assert.match(policy.Query, /mining_ClassifyConnectionMeasurementV1/);
    assert.match(policy.Query, /project /);

    const tableSchema = schema.match(new RegExp(`^\\.create table ${target} \\(([^)]*)\\)`, "m"));
    assert.ok(tableSchema, `Missing target schema: ${target}`);
    const expectedColumns = tableSchema[1]
      .split(",")
      .map((column) => column.trim().split(":")[0].trim());
    const projection = policy.Query.split("| project ").at(-1);
    const actualColumns = projection.split(",").map((column) => column.trim().split("=")[0].trim());
    assert.deepEqual(actualColumns, expectedColumns, `Projection does not match ${target}`);
  }
});

test("binding seed describes 57 components with pinned versions and module-port endpoints", () => {
  const bindings = kql("MiningConnectionBindings.kql");
  assert.match(bindings, /\.set-or-append mining_ConnectionMeasurementProfile <\|/);
  assert.match(bindings, /\.set-or-append mining_ConnectionMeasurementBinding <\|/);
  assert.match(bindings, /sample_interval_seconds = toint\(5\)/);
  const process = bindings.match(/suffix=dynamic\(\[([\s\S]*?)\]\) to typeof\(string\)/);
  assert.ok(process);
  const processSuffixes = [...process[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.equal(processSuffixes.length * 3, 30);
  assert.match(bindings, /"utility-", line_id, "-fines"/);
  assert.match(bindings, /"utility-", line_id, "-effluent"/);
  assert.match(bindings, /"utility-thickener-underflow", "water_volume_flow"/);
  assert.match(bindings, /"d01-connection-measurements-v1"/);
  assert.match(bindings, /"d01-shared-flow-v1"/);
  const simulatorCatalog = readFileSync(
    resolve(root, "apps/simulator/src/mining/connection-catalog.ts"),
    "utf8",
  );
  assert.match(simulatorCatalog, /D01_CONNECTION_PROFILE_VERSION\s*=\s*"d01-shared-flow-v1"/);
  assert.match(bindings, /"synthetic_sensor_observation"/);
  assert.match(bindings, /"visualization_scale_only"/);
  assert.match(bindings, /endpoint_granularity = "module-port"/);
  assert.match(bindings, /binding_rows=count\(\)[\s\S]*unique_tags=dcount\(measurement_tag_id\)/);
  assert.equal(30 + 3 + 3 + 3 + 3 + 3 + 9 + 3, 57);
});

test("classifier enforces the exact event family, versions, binding, time, quality, and run pin", () => {
  const schema = kql("MiningConnectionSchema.kql");
  const validation = kql("MiningConnectionValidation.kql");
  assert.match(schema, /sample_time_raw:string/);
  assert.match(schema, /ingestion json mapping[\s\S]*\$\.sample_time/);
  for (const invariant of [
    '"ConnectionMeasurement"',
    '"d01-connection-measurements-v1"',
    '"d01-shared-flow-v1"',
    "array_length(set_difference(expected_fields, actual_fields)) == 0",
    "sequence > 0",
    '":connection:"',
    "sample_interval_seconds == 5",
    'gettype(event["run_id"]) in ("string", "guid")',
    "event_time > pinned_started_at",
    'datetime_diff("millisecond", event_time, pinned_started_at) % 5000 == 0',
    "event_time <= received_at",
    "run_profile_received_at=take_any(ingestion_time())",
    "run_profile_received_at < received_at",
    "isfinite(value) and value >= 0.0",
    'quality in ("good", "uncertain", "bad")',
    'gettype(event["source_equipment_id"]) == "null"',
    'gettype(event["target_equipment_id"]) == "null"',
    "binding_rows == 1",
    "run_profile_rows == 1",
    "payload_fingerprint",
  ]) {
    assert.ok(validation.includes(invariant), `Missing validation invariant: ${invariant}`);
  }
  assert.doesNotMatch(validation, /datetime_part\("second", event_time\)/);
  assert.match(validation, /"invalid_or_unexpected_root_fields"/);
  assert.match(validation, /"unknown_or_mismatched_measurement_binding"/);
  assert.match(validation, /"run_pin_receipt_not_prior_to_event"/);
  assert.match(validation, /run_profile_rows=count\(\)[\s\S]*by run_id/);
  assert.match(validation, /"run_version_not_pinned_uniquely"/);
  assert.match(validation, /\n\}\s*$/);
});

test("public functions are bounded, version-scoped, and return explicit status rows", () => {
  const queries = kql("MiningConnectionQueries.kql");
  const runIngestion = kql("MiningConnectionRunIngestion.kql");
  assert.doesNotMatch(
    `${queries}\n${runIngestion}`,
    /\b\d+L\b/,
    "Kusto does not support C-style long literal suffixes",
  );
  assert.match(queries, /MiningConnectionLatestV1\([\s\S]*maxRows:long\)/);
  assert.match(queries, /MiningConnectionTrendV1\([\s\S]*maxRows:long\)/);
  assert.match(
    queries,
    /mining_ConnectionUniqueTicksV1\([\s\S]*?\n\}\s*\n\s*\.create-or-alter function/,
  );
  assert.match(queries, /MiningConnectionLatestV1\([\s\S]*?\n\}\s*\n\s*\.create-or-alter function/);
  assert.match(queries, /MiningConnectionTrendV1\([\s\S]*?\n\}\s*$/);
  assert.match(queries, /maxRows between \(1 \.\. 57\)/);
  assert.match(queries, /maxRows between \(1 \.\. 5000\)/);
  assert.match(queries, /"TRUNCATED"/);
  assert.match(queries, /ExpectedSampleCount=expected_samples/);
  assert.match(queries, /requested_receipt_cutoff_utc:datetime/);
  assert.match(queries, /iff\(windowSize == 30s, tolong\(6\), tolong\(12\)\)/);
  assert.match(queries, /Value=iff\(SampleCount == 0, real\(null\), Value\)/);
  assert.match(queries, /profileVersion == "d01-shared-flow-v1"/);
  assert.match(
    queries,
    /WindowStart=window_anchor \+ bin\(sample_time - window_anchor - 1ms, windowSize\)/,
  );
  assert.match(queries, /range window_index from 0 to 2880 step 1/);
  assert.match(queries, /WindowStart=first_window_start \+ todouble\(window_index\) \* windowSize/);
  assert.match(queries, /where WindowStart <= last_window_start/);
  assert.doesNotMatch(queries, /range WindowStart from first_window_start/);
  assert.match(queries, /fromTime >= run_started_at/);
  assert.match(queries, /first_received_at=min\(received_at\)/);
  const groupedTickSummary = queries.match(
    /event_copies\s*\|\s*summarize event_count=([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(groupedTickSummary);
  assert.doesNotMatch(
    groupedTickSummary,
    /(?:sample_time|stream_id|measurement_tag_id)=take_any\(/,
  );
  assert.match(
    queries,
    /mining_ClassifyConnectionMeasurementV1\(\)[\s\S]*raw_identity_conflict=true/,
  );
  assert.doesNotMatch(queries, /bin\(sample_time, windowSize\)/);
  const rawIdentityCheck = queries
    .split("let raw_identity_status =")[1]
    ?.split("let identity_status =")[0];
  assert.ok(rawIdentityCheck);
  assert.doesNotMatch(rawIdentityCheck, /sample_time\s*>=\s*requested_start_utc/);
  assert.match(
    rawIdentityCheck,
    /accepted_copies > 0 and quarantined_copies \+ blocked_copies > 0/,
  );
  assert.match(
    queries,
    /Coverage=todouble\(coalesce\(SampleCount, tolong\(0\)\)\) \/ todouble\(expected_samples\)/,
  );
  assert.match(queries, /SampleCount=countif\(not\(tick_conflict\) and quality == "good"\)/);
  assert.match(queries, /ObservedTickCount=count\(\)/);
  assert.match(
    queries,
    /WindowState=case\([\s\S]*"MISSING"[\s\S]*"UNUSABLE"[\s\S]*"COMPLETE"[\s\S]*"PARTIAL"/,
  );
  assert.match(queries, /join kind=leftouter \(tick_windows\)/);
  assert.doesNotMatch(queries, /coalesce\(Value,\s*0(?:\.0)?\)/);
  const compactDocs = docs.replace(/\s+/g, " ");
  for (const contract of [
    "| `Status` | `string` |",
    "| `RunId` | `string` |",
    "| `CatalogVersion` | `string` |",
    "| `MeasurementCatalogVersion` | `string` |",
    "| `ProfileVersion` | `string` |",
    "| `StreamId` | `string` |",
    "| `MeasurementTagId` | `string` |",
    "| `WindowStart` | `datetime` |",
    "| `ExpectedSampleCount` | `long` |",
    "| `ConflictCount` | `long` |",
    "| `LastReceiptTime` | `datetime` |",
  ]) {
    assert.ok(compactDocs.includes(contract), `Documentation is missing type ${contract}`);
  }
  assert.match(docs, /MiningConnectionLatestV1/);
  assert.match(docs, /MiningConnectionTrendV1/);

  const contracts = [
    {
      name: "MiningConnectionLatestV1",
      signature:
        /runId:string,\s*catalogVersion:string,\s*measurementCatalogVersion:string,\s*profileVersion:string,\s*streamIds:dynamic,\s*asOf:datetime,\s*lookback:timespan,\s*maxRows:long/,
      columns: [
        ["Status", "string"],
        ["RunId", "string"],
        ["CatalogVersion", "string"],
        ["MeasurementCatalogVersion", "string"],
        ["ProfileVersion", "string"],
        ["StreamId", "string"],
        ["MeasurementTagId", "string"],
        ["Quantity", "string"],
        ["Basis", "string"],
        ["Unit", "string"],
        ["Value", "real"],
        ["Quality", "string"],
        ["SampleTime", "datetime"],
        ["ReceiptTime", "datetime"],
        ["EventId", "string"],
        ["Sequence", "long"],
        ["IsStale", "bool"],
        ["DuplicateCount", "long"],
        ["ConflictCount", "long"],
      ],
    },
    {
      name: "MiningConnectionTrendV1",
      signature:
        /runId:string,\s*catalogVersion:string,\s*measurementCatalogVersion:string,\s*profileVersion:string,\s*streamIds:dynamic,\s*fromTime:datetime,\s*toTime:datetime,\s*windowSize:timespan,\s*maxRows:long/,
      columns: [
        ["Status", "string"],
        ["RunId", "string"],
        ["CatalogVersion", "string"],
        ["MeasurementCatalogVersion", "string"],
        ["ProfileVersion", "string"],
        ["StreamId", "string"],
        ["MeasurementTagId", "string"],
        ["Quantity", "string"],
        ["Basis", "string"],
        ["Unit", "string"],
        ["WindowStart", "datetime"],
        ["WindowEnd", "datetime"],
        ["WindowClosed", "bool"],
        ["Value", "real"],
        ["SampleCount", "long"],
        ["ExpectedSampleCount", "long"],
        ["ObservedTickCount", "long"],
        ["BadSampleCount", "long"],
        ["UncertainSampleCount", "long"],
        ["Coverage", "real"],
        ["DuplicateCount", "long"],
        ["ConflictCount", "long"],
        ["Quality", "string"],
        ["WindowState", "string"],
        ["IsComplete", "bool"],
        ["LastSampleTime", "datetime"],
        ["LastReceiptTime", "datetime"],
      ],
    },
  ];
  for (const contract of contracts) {
    const functionStart = queries.indexOf(`${contract.name}(`);
    assert.notEqual(functionStart, -1);
    const functionEnd = queries.indexOf(".create-or-alter function", functionStart + 1);
    const section = queries.slice(functionStart, functionEnd === -1 ? undefined : functionEnd);
    const signatureEnd = section.indexOf(")\n{");
    assert.match(section.slice(0, signatureEnd), contract.signature);
    const projection = section.match(
      /\| project Status,([\s\S]*?);\s*\n\s*union kind=outer status_row/,
    );
    assert.ok(projection, `Missing explicit result projection for ${contract.name}`);
    for (const [column, type] of contract.columns) {
      assert.match(
        projection[0],
        new RegExp(`(?:^|[,\\s])${column}(?:\\s*=|\\s*,|\\s*;|\\s*$)`),
        `Missing ${contract.name} result column ${column}`,
      );
      assert.ok(
        compactDocs.includes(`| \`${column}\` | \`${type}\` |`),
        `Missing documented ${column}:${type}`,
      );
    }
  }
});

test("bounded-window reference cases preserve partial, missing, quality, and conflict states", () => {
  const full = goodTicks();
  full.push({ ...full[0] });
  const complete = referenceWindow(full, 6);
  assert.equal(complete.windowState, "COMPLETE");
  assert.equal(complete.sampleCount, 6);
  assert.equal(complete.duplicateCount, 1);
  assert.equal(complete.coverage, 1);

  const partial = referenceWindow(goodTicks(5), 6);
  assert.equal(partial.windowState, "PARTIAL");
  assert.equal(partial.sampleCount, 5);
  assert.equal(partial.value, 2);

  const badInput = goodTicks();
  badInput[2] = { ...badInput[2], quality: "bad" };
  const bad = referenceWindow(badInput, 6);
  assert.equal(bad.windowState, "PARTIAL");
  assert.equal(bad.badSampleCount, 1);
  assert.equal(bad.sampleCount, 5);

  const missing = referenceWindow([], 12);
  assert.equal(missing.windowState, "MISSING");
  assert.equal(missing.sampleCount, 0);
  assert.equal(missing.value, null);

  const conflictInput = goodTicks(6);
  conflictInput.push({ ...conflictInput[0], fingerprint: "different-payload" });
  const conflict = referenceWindow(conflictInput, 6);
  assert.equal(conflict.windowState, "CONFLICT");
  assert.equal(conflict.conflictCount, 1);
  assert.equal(conflict.sampleCount, 5);
  assert.match(kql("MiningConnectionQueries.kql"), /event_conflicts=countif\(event_conflict\)/);
  assert.match(kql("MiningConnectionQueries.kql"), /event_count != 1/);
});

test("run cadence and 30/60-second windows are anchored to a non-wall-aligned start", () => {
  const startedAt = "2026-11-22T21:05:41.826Z";
  const atStart = startedAt;
  const atFiveSeconds = "2026-11-22T21:05:46.826Z";
  const wallAlignedButWrong = "2026-11-22T21:05:45.000Z";
  const atTwentyFiveSeconds = "2026-11-22T21:06:06.826Z";
  const atThirtySeconds = "2026-11-22T21:06:11.826Z";
  const atSixtySeconds = "2026-11-22T21:06:41.826Z";

  assert.equal(isRunRelativeTick(startedAt, atStart), false);
  assert.equal(isRunRelativeTick(startedAt, atFiveSeconds), true);
  assert.equal(isRunRelativeTick(startedAt, wallAlignedButWrong), false);
  assert.equal(runRelativeWindowStart(startedAt, atTwentyFiveSeconds, 30), startedAt);
  assert.equal(runRelativeWindowStart(startedAt, atThirtySeconds, 30), startedAt);
  assert.equal(runRelativeWindowStart(startedAt, atThirtySeconds, 60), startedAt);
  assert.equal(runRelativeWindowStart(startedAt, atSixtySeconds, 30), atThirtySeconds);
  assert.equal(runRelativeWindowStart(startedAt, atSixtySeconds, 60), startedAt);

  assert.deepEqual(runRelativeWindowStarts(startedAt, atFiveSeconds, atThirtySeconds, 30), [
    startedAt,
  ]);
  assert.deepEqual(runRelativeWindowStarts(startedAt, atThirtySeconds, atSixtySeconds, 30), [
    startedAt,
    atThirtySeconds,
  ]);
  assert.equal(Date.parse(atThirtySeconds) + 30_000 <= Date.parse(atThirtySeconds), false);
  assert.equal(Date.parse(atThirtySeconds) + 30_000 <= Date.parse(atSixtySeconds), true);
  assert.match(kql("MiningConnectionQueries.kql"), /ExpectedSampleCount=expected_samples/);
  assert.match(
    kql("MiningConnectionQueries.kql"),
    /bin\(sample_time - window_anchor - 1ms, windowSize\)/,
  );
  assert.match(
    kql("MiningConnectionQueries.kql"),
    /iff\(windowSize == 30s, tolong\(6\), tolong\(12\)\)/,
  );
  assert.match(docs, /always the full-bin count—6 for 30 seconds and 12 for 60 seconds/);
  assert.match(docs, /Value` is null when a\s+window has no qualifying good tick/);
});

test("duplicate first receipt and cross-time/cross-stream event conflicts are preserved", () => {
  const firstCopy = {
    eventId: "same-event",
    fingerprint: "payload-a",
    sampleTime: "2026-11-22T21:05:46.826Z",
    streamId: "stream-a",
    measurementTagId: "tag-a",
    quality: "good",
    value: 10,
    receivedAt: "2026-11-22T21:05:47.000Z",
  };
  const earlierDuplicate = { ...firstCopy, receivedAt: "2026-11-22T21:05:46.900Z" };
  const duplicate = referenceWindow([firstCopy, earlierDuplicate], 1);
  assert.equal(duplicate.duplicateCount, 1);
  assert.equal(duplicate.firstReceiptAt, earlierDuplicate.receivedAt);

  const otherStreamAndTime = {
    ...firstCopy,
    fingerprint: "payload-b",
    sampleTime: "2026-11-22T21:06:21.826Z",
    streamId: "stream-b",
    measurementTagId: "tag-b",
    receivedAt: "2026-11-22T21:06:22.000Z",
  };
  const boundedConflict = referenceWindow([firstCopy], 1, {
    allRunEvents: [firstCopy, otherStreamAndTime],
  });
  assert.equal(boundedConflict.windowState, "CONFLICT");
  assert.equal(boundedConflict.sampleCount, 0);

  const beforeLaterCopy = referenceWindow([firstCopy], 1, { allRunEvents: [firstCopy] });
  assert.equal(beforeLaterCopy.windowState, "COMPLETE");
  assert.equal(beforeLaterCopy.sampleCount, 1);
});

test("run reconciliation compares observed accepted raw and validated identity-plus-payload sets", () => {
  const reconciliation = kql("MiningConnectionRunIngestion.kql");
  assert.match(reconciliation, /MiningConnectionRunReconciliationV1/);
  assert.match(reconciliation, /payload_fingerprint/);
  assert.match(reconciliation, /join kind=leftanti \(observed\) on event_id, fingerprint/);
  assert.match(reconciliation, /join kind=leftanti \(expected\) on event_id, fingerprint/);
  assert.match(reconciliation, /ingestion_time\(\) <= asOf/);
  assert.match(reconciliation, /"NOT_COMPLETED_AT_CUTOFF"/);
  assert.match(reconciliation, /"BLOCKED_RAW_CLASSIFICATION"/);
  assert.match(reconciliation, /"RECONCILED_WITH_QUARANTINE"/);
  assert.match(reconciliation, /"RECONCILED"/);
  assert.match(
    reconciliation,
    /raw_identity_groups[\s\S]*quarantined_copies=countif\(disposition == "QUARANTINED"\)/,
  );
  assert.match(reconciliation, /accepted_copies=countif\(disposition == "ACCEPTED"\)/);
  assert.match(reconciliation, /raw_conflict_count=toscalar\(raw_conflicting_ids \| count\)/);
  assert.match(docs, /does \*\*not\*\* prove that\s+the simulator emitted/);
  assert.match(docs, /not epoch or\s+wall-clock boundaries/);
});

test("expected-set canary reconciliation is bounded and keeps honest per-ID outcomes", () => {
  const reconciliation = kql("MiningConnectionRunIngestion.kql");
  const body = reconciliation.slice(
    reconciliation.indexOf("MiningConnectionExpectedSetReconciliationV1("),
  );
  const compactDocs = docs.replace(/\s+/g, " ");
  assert.match(body, /expected_count > 200,\s+"TRUNCATED"/);
  assert.match(body, /expected_unique_count != expected_count/);
  assert.match(body, /supplied_id_type != "string"/);
  assert.match(body, /ExpectedEventId matches regex @"\^\[0-9a-f\]\{64\}\$"/);
  assert.match(body, /RawDistinctPayloadCountCappedAt2/);
  assert.match(body, /RawAcceptedDistinctPayloadCountCappedAt2/);
  assert.match(body, /ValidatedDistinctPayloadCountCappedAt2/);
  assert.match(body, /profileVersion == "d01-shared-flow-v1"/);
  assert.match(body, /RawConflict=RawCopyCount > 1 and/);
  assert.match(body, /ValidatedConflict=ValidatedDistinctPayloadCountCappedAt2 > 1/);
  assert.match(body, /received_at <= asOf and\s+ingestion_time\(\) <= asOf/);
  assert.match(body, /not\(basic_request_ok\), "INVALID_REQUEST"/);
  assert.match(body, /pin_received_at=ingestion_time\(\)/);
  assert.match(body, /pin_received_at <= asOf/);
  assert.match(body, /"RUN_PIN_RECEIPT_TIME_UNAVAILABLE"/);
  assert.doesNotMatch(body, /pinned_at\s*<=\s*asOf/);
  assert.match(body, /pin_count != 1 or matching_pin_count != 1,\s+"RUN_PIN_MISSING_OR_AMBIGUOUS"/);
  assert.match(body, /"MISSING_FROM_RAW_AND_VALIDATED"/);
  assert.match(body, /"RAW_ONLY"/);
  assert.match(body, /"VALIDATED_WITHOUT_RAW"/);
  assert.match(body, /"RAW_CONFLICT"/);
  assert.match(body, /"VALIDATED_CONFLICT"/);
  assert.match(body, /"DUPLICATE_MATCH"/);
  assert.match(body, /EvidenceScope="explicit_expected_ids_only"/);
  const projection = body.match(/\| project Status,([\s\S]*?);\s*let status_row/);
  assert.ok(projection, "Missing explicit expected-set result projection");
  const resultColumns = [
    ["Status", "string"],
    ["RunId", "string"],
    ["CatalogVersion", "string"],
    ["MeasurementCatalogVersion", "string"],
    ["ProfileVersion", "string"],
    ["AsOf", "datetime"],
    ["EvidenceScope", "string"],
    ["ExpectedEventId", "string"],
    ["RawCopyCount", "long"],
    ["RawInScopeCopyCount", "long"],
    ["RawOutOfScopeCopyCount", "long"],
    ["RawAcceptedCopyCount", "long"],
    ["RawQuarantinedCopyCount", "long"],
    ["RawBlockedCopyCount", "long"],
    ["RawDuplicateCopyCount", "long"],
    ["RawDistinctPayloadCountCappedAt2", "long"],
    ["RawAcceptedDistinctPayloadCountCappedAt2", "long"],
    ["RawConflict", "bool"],
    ["ValidatedCopyCount", "long"],
    ["ValidatedDuplicateCopyCount", "long"],
    ["ValidatedDistinctPayloadCountCappedAt2", "long"],
    ["ValidatedConflict", "bool"],
    ["RawValidatedPayloadMatch", "bool"],
    ["PayloadMismatch", "bool"],
    ["Conflict", "bool"],
  ];
  for (const [column, type] of resultColumns) {
    assert.match(
      projection[0],
      new RegExp(`(?:^|[,\\s])${column}(?:\\s*=|\\s*,|\\s*;|\\s*$)`),
      `Missing expected-set result column ${column}`,
    );
    assert.ok(
      compactDocs.includes(`| \`${column}\` | \`${type}\` |`),
      `Missing documented expected-set type ${column}:${type}`,
    );
  }

  const cutoff = "2026-11-22T11:30:00Z";
  const ids = {
    missing: "a".repeat(64),
    rawOnly: "b".repeat(64),
    duplicates: "c".repeat(64),
    rawConflict: "d".repeat(64),
    validatedOnly: "e".repeat(64),
    beyondReceiptCutoff: "f".repeat(64),
    beyondIngestionCutoff: "1".repeat(64),
    validatedConflict: "2".repeat(64),
    payloadMismatch: "3".repeat(64),
  };
  const rawRows = [
    {
      eventId: ids.rawOnly,
      fingerprint: "raw-b",
      disposition: "ACCEPTED",
      receivedAt: "2026-11-22T11:20:00Z",
    },
    {
      eventId: ids.duplicates,
      fingerprint: "same-c",
      disposition: "ACCEPTED",
      receivedAt: "2026-11-22T11:21:00Z",
    },
    {
      eventId: ids.duplicates,
      fingerprint: "same-c",
      disposition: "ACCEPTED",
      receivedAt: "2026-11-22T11:22:00Z",
    },
    {
      eventId: ids.rawConflict,
      fingerprint: "d1",
      disposition: "ACCEPTED",
      receivedAt: "2026-11-22T11:23:00Z",
    },
    {
      eventId: ids.rawConflict,
      fingerprint: "d2",
      disposition: "QUARANTINED",
      receivedAt: "2026-11-22T11:24:00Z",
    },
    {
      eventId: ids.beyondReceiptCutoff,
      fingerprint: "late-f",
      disposition: "ACCEPTED",
      receivedAt: "2026-11-22T11:31:00Z",
    },
    {
      eventId: ids.beyondIngestionCutoff,
      fingerprint: "raw-g",
      disposition: "ACCEPTED",
      receivedAt: "2026-11-22T11:25:00Z",
    },
    {
      eventId: ids.validatedConflict,
      fingerprint: "raw-h",
      disposition: "ACCEPTED",
      receivedAt: "2026-11-22T11:25:00Z",
    },
    {
      eventId: ids.payloadMismatch,
      fingerprint: "raw-i",
      disposition: "ACCEPTED",
      receivedAt: "2026-11-22T11:25:00Z",
    },
  ];
  const validatedRows = [
    {
      eventId: ids.duplicates,
      fingerprint: "same-c",
      receivedAt: "2026-11-22T11:21:00Z",
      ingestedAt: "2026-11-22T11:22:00Z",
    },
    {
      eventId: ids.duplicates,
      fingerprint: "same-c",
      receivedAt: "2026-11-22T11:22:00Z",
      ingestedAt: "2026-11-22T11:23:00Z",
    },
    {
      eventId: ids.rawConflict,
      fingerprint: "d1",
      receivedAt: "2026-11-22T11:23:00Z",
      ingestedAt: "2026-11-22T11:24:00Z",
    },
    {
      eventId: ids.validatedOnly,
      fingerprint: "e",
      receivedAt: "2026-11-22T11:22:00Z",
      ingestedAt: "2026-11-22T11:23:00Z",
    },
    {
      eventId: ids.beyondReceiptCutoff,
      fingerprint: "late-f",
      receivedAt: "2026-11-22T11:31:00Z",
      ingestedAt: "2026-11-22T11:31:00Z",
    },
    {
      eventId: ids.beyondIngestionCutoff,
      fingerprint: "raw-g",
      receivedAt: "2026-11-22T11:25:00Z",
      ingestedAt: "2026-11-22T11:31:00Z",
    },
    {
      eventId: ids.validatedConflict,
      fingerprint: "val-h1",
      receivedAt: "2026-11-22T11:25:00Z",
      ingestedAt: "2026-11-22T11:26:00Z",
    },
    {
      eventId: ids.validatedConflict,
      fingerprint: "val-h2",
      receivedAt: "2026-11-22T11:26:00Z",
      ingestedAt: "2026-11-22T11:27:00Z",
    },
    {
      eventId: ids.payloadMismatch,
      fingerprint: "val-i",
      receivedAt: "2026-11-22T11:25:00Z",
      ingestedAt: "2026-11-22T11:26:00Z",
    },
  ];

  assert.equal(
    expectedSetOutcome(ids.missing, rawRows, validatedRows, cutoff).status,
    "MISSING_FROM_RAW_AND_VALIDATED",
  );
  assert.equal(expectedSetOutcome(ids.rawOnly, rawRows, validatedRows, cutoff).status, "RAW_ONLY");
  const duplicate = expectedSetOutcome(ids.duplicates, rawRows, validatedRows, cutoff);
  assert.equal(duplicate.status, "DUPLICATE_MATCH");
  assert.equal(duplicate.rawDuplicateCopyCount, 1);
  assert.equal(duplicate.validatedDuplicateCopyCount, 1);
  assert.equal(
    expectedSetOutcome(ids.rawConflict, rawRows, validatedRows, cutoff).status,
    "RAW_CONFLICT",
  );
  assert.equal(
    expectedSetOutcome(ids.validatedOnly, rawRows, validatedRows, cutoff).status,
    "VALIDATED_WITHOUT_RAW",
  );
  assert.equal(
    expectedSetOutcome(ids.beyondReceiptCutoff, rawRows, validatedRows, cutoff).status,
    "MISSING_FROM_RAW_AND_VALIDATED",
  );
  assert.equal(
    expectedSetOutcome(ids.beyondIngestionCutoff, rawRows, validatedRows, cutoff).status,
    "RAW_ONLY",
  );
  assert.equal(
    expectedSetOutcome(ids.validatedConflict, rawRows, validatedRows, cutoff).status,
    "VALIDATED_CONFLICT",
  );
  assert.equal(
    expectedSetOutcome(ids.payloadMismatch, rawRows, validatedRows, cutoff).status,
    "RAW_VALIDATED_MISMATCH",
  );
  assert.equal(
    pinSnapshotStatus(
      [{ pinnedAt: "2026-11-22T11:35:00Z", receivedAt: "2026-11-22T11:20:00Z" }],
      cutoff,
    ),
    "OK",
  );
  assert.equal(
    pinSnapshotStatus(
      [{ pinnedAt: "2026-11-22T11:20:00Z", receivedAt: "2026-11-22T11:31:00Z" }],
      cutoff,
    ),
    "RUN_PIN_MISSING_OR_AMBIGUOUS",
  );
  assert.equal(
    pinSnapshotStatus(
      [
        { pinnedAt: "2026-11-22T11:20:00Z", receivedAt: "2026-11-22T11:21:00Z" },
        { pinnedAt: "2026-11-22T11:22:00Z", receivedAt: "2026-11-22T11:23:00Z" },
      ],
      cutoff,
    ),
    "RUN_PIN_MISSING_OR_AMBIGUOUS",
  );
  assert.equal(
    pinSnapshotStatus(
      [
        { pinnedAt: "2026-11-22T11:20:00Z", receivedAt: "2026-11-22T11:21:00Z" },
        { pinnedAt: "2026-11-22T11:22:00Z", receivedAt: "2026-11-22T11:31:00Z" },
      ],
      cutoff,
    ),
    "OK",
  );
  assert.equal(
    pinSnapshotStatus([{ pinnedAt: "2026-11-22T11:20:00Z", receivedAt: null }], cutoff),
    "RUN_PIN_RECEIPT_TIME_UNAVAILABLE",
  );
  assert.match(reconciliation, /pin_received_at=ingestion_time\(\)/);
  assert.match(reconciliation, /pin_received_at <= asOf/);
  assert.match(reconciliation, /"RUN_PIN_RECEIPT_TIME_UNAVAILABLE"/);
  assert.match(docs, /declared `pinned_at` field[\s\S]*not used as persisted-receipt proof/);
  assert.match(docs, /any duplicate pin rows make\s+the run ambiguous/);
  assert.match(docs, /does \*\*not\*\* prove the simulator emitted every expected event/);
  assert.match(docs, /CappedAt2/);
});
