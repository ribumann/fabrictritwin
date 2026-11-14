import { createHash } from "node:crypto";
import { log } from "node:console";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createD01EventId, toD01TransportBody } from "@triathlon-twin/simulator/mining";

export function buildMiningRawCanary(runId, timestamp) {
  if (
    typeof runId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(runId)
  ) {
    throw new Error("Provide a canonical lowercase UUIDv4 run ID.");
  }
  if (
    typeof timestamp !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp)) ||
    new Date(timestamp).toISOString() !== timestamp
  ) {
    throw new Error("Provide a real canonical UTC millisecond timestamp.");
  }
  const telemetry = toD01TransportBody({
    schema_version: 2,
    run_id: runId,
    event_id: createD01EventId(runId, 1),
    sequence: 1,
    interval_seconds: 30,
    timestamp,
    plant_id: "D01",
    module_id: "D01.A.crusher",
    equipment_id: "D01.A.crusher.feeder",
    tag_id: "D01.A.crusher.ore_flow",
    value: 42,
    unit: "t/h",
    quality: "good",
  });
  const state = toD01TransportBody({
    schema_version: 2,
    run_id: runId,
    event_id: createD01EventId(runId, 2),
    sequence: 2,
    timestamp,
    plant_id: "D01",
    scope_id: "A",
    scheduled_running: true,
    state: "running",
  });
  const messages = [telemetry, state];
  const ndjson = messages.map((message) => JSON.stringify(message)).join("\n") + "\n";
  const verificationQuery = `let expected_run_id = "${runId}";
let expected_timestamp = "${timestamp}";
let expected_telemetry_id = "${telemetry.event_id}";
let expected_state_id = "${state.event_id}";
let expected = datatable(table_name:string)
[
  "mining_TelemetryRaw",
  "mining_PlantStateEvents"
];
let observed =
union
  (mining_TelemetryRaw | extend table_name = "mining_TelemetryRaw"),
  (mining_PlantStateEvents | extend table_name = "mining_PlantStateEvents")
| where tostring(event["run_id"]) == expected_run_id
| extend expected_event_id = iff(table_name == "mining_TelemetryRaw", expected_telemetry_id, expected_state_id)
| summarize copies = count(),
    matching_id_copies = countif(tostring(event["event_id"]) == expected_event_id),
    exact_timestamp_copies = countif(
      todatetime(event["timestamp"]) == todatetime(expected_timestamp) and
      timestamp_raw == expected_timestamp),
    received_copies = countif(isnotnull(ingestion_time()))
  by table_name;
expected
| join kind=leftouter observed on table_name
| project table_name,
    copies = coalesce(copies, long(0)),
    matching_id_copies = coalesce(matching_id_copies, long(0)),
    exact_timestamp_copies = coalesce(exact_timestamp_copies, long(0)),
    received_copies = coalesce(received_copies, long(0))
| extend passed = copies >= 1 and matching_id_copies == copies and
    exact_timestamp_copies == copies and received_copies == copies
| order by table_name asc
`;
  return {
    schemaVersion: 1,
    status: "PreparedOnly",
    runId,
    timestamp,
    messages,
    ndjson,
    ndjsonSha256: createHash("sha256").update(ndjson).digest("hex"),
    verificationQuery,
    verificationQuerySha256: createHash("sha256").update(verificationQuery).digest("hex"),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { positionals } = parseArgs({ allowPositionals: true, options: {} });
  if (positionals.length !== 2) {
    throw new Error("Usage: node scripts/fabric/build-mining-raw-canary.mjs <run-id> <timestamp>");
  }
  log(JSON.stringify(buildMiningRawCanary(...positionals), null, 2));
}
