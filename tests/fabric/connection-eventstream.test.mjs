import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const definition = JSON.parse(
  readFileSync(resolve(root, "infra/fabric/mining-connection-flow/eventstream.json"), "utf8"),
);
const schema = readFileSync(
  resolve(root, "infra/fabric/eventhouse/MiningConnectionSchema.kql"),
  "utf8",
);

test("isolated stream separates measurement and run-pin families into their own tables", () => {
  assert.equal(definition.sources.length, 1);
  assert.equal(definition.sources[0].type, "CustomEndpoint");
  assert.equal(definition.operators.length, 2);
  const [filter] = definition.operators;
  assert.equal(filter.type, "Filter");
  assert.deepEqual(filter.inputNodes, [{ name: "connection_main_stream" }]);
  assert.equal(filter.properties.conditions.length, 1);
  const [condition] = filter.properties.conditions;
  assert.equal(condition.column.columnName, "entityType");
  assert.equal(condition.column.columnPathSegments, null);
  assert.equal(condition.operatorType, "Equals");
  assert.equal(condition.value.value, "ConnectionMeasurement");
  assert.deepEqual(
    definition.streams.map(({ name, inputNodes }) => [name, inputNodes]),
    [
      ["connection_main_stream", [{ name: "connection_custom_endpoint" }]],
      ["connection_measurement_stream", [{ name: "connection_measurement_filter" }]],
      ["connection_run_profile_stream", [{ name: "connection_run_profile_filter" }]],
    ],
  );
  assert.equal(definition.destinations.length, 2);
  const [destination] = definition.destinations;
  assert.deepEqual(destination.inputNodes, [{ name: "connection_measurement_stream" }]);
  assert.equal(destination.properties.dataIngestionMode, "DirectIngestion");
  assert.equal(destination.properties.workspaceId, "{{EVENTHOUSE_WORKSPACE_ID}}");
  assert.equal(destination.properties.itemId, "{{KQLDATABASE_ITEM_ID}}");
  assert.equal(destination.properties.tableName, "mining_ConnectionMeasurementRaw");
  assert.equal(destination.properties.mappingRuleName, "mining_connection_measurement_v1_json_map");
  assert.match(schema, /'mining_connection_measurement_v1_json_map'/);
  const pinFilter = definition.operators[1];
  assert.equal(pinFilter.type, "Filter");
  assert.deepEqual(pinFilter.inputNodes, [{ name: "connection_main_stream" }]);
  assert.equal(pinFilter.properties.conditions.length, 1);
  assert.equal(pinFilter.properties.conditions[0].column.columnName, "entityType");
  assert.equal(pinFilter.properties.conditions[0].column.columnPathSegments, null);
  assert.equal(pinFilter.properties.conditions[0].operatorType, "Equals");
  assert.equal(pinFilter.properties.conditions[0].value.value, "ConnectionRunProfile");
  const pinDestination = definition.destinations[1];
  assert.deepEqual(pinDestination.inputNodes, [{ name: "connection_run_profile_stream" }]);
  assert.equal(pinDestination.properties.dataIngestionMode, "DirectIngestion");
  assert.equal(pinDestination.properties.workspaceId, "{{EVENTHOUSE_WORKSPACE_ID}}");
  assert.equal(pinDestination.properties.itemId, "{{KQLDATABASE_ITEM_ID}}");
  assert.equal(pinDestination.properties.tableName, "mining_ConnectionRunProfile");
  assert.equal(
    pinDestination.properties.mappingRuleName,
    "mining_connection_run_profile_v1_json_map",
  );
  assert.match(schema, /'mining_connection_run_profile_v1_json_map'/);
  assert.match(schema, /"column":"pinned_at","Properties":\{"path":"\$\.requested_at"\}/);
});
