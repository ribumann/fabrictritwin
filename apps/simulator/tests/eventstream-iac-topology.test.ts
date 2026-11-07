import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards against the schema-drift class of bug diagnosed in production: the Eventstream
 * destinations' `inputSchemas` and `mappingRuleName` in the checked-in IaC topology files must
 * always match the canonical field shape of the `SessionMetric`/`RaceSplit` TypeScript models
 * (`../src/models/telemetry.ts`) plus the transport-only `entityType` discriminator, so that
 * re-provisioning from IaC reproduces the corrected, live-verified Eventstream contract instead of
 * silently regressing to a broken/incomplete schema.
 */

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const eventstreamDir = path.join(repoRoot, "infra", "fabric", "eventstream");

const TOPOLOGY_FILES = ["eventstream.custom-endpoint.json", "eventstream.azure-eventhub-fallback.json"];

const EXPECTED_DESTINATIONS: Record<
  string,
  {
    tableName: string;
    mappingRuleName: string;
    streamName: string;
    columns: ReadonlyArray<{ name: string; type: string }>;
  }
> = {
  sessionmetric_direct_ingestion: {
    tableName: "SessionMetric",
    mappingRuleName: "sessionmetric_json_map",
    streamName: "sessionmetric_stream",
    columns: [
      { name: "entityType", type: "Nvarchar(max)" },
      { name: "sessionId", type: "Nvarchar(max)" },
      { name: "timestamp", type: "DateTime" },
      { name: "heartRate", type: "BigInt" },
      { name: "power", type: "Float" },
      { name: "pace", type: "Float" },
      { name: "cadence", type: "Float" },
      { name: "latitude", type: "Float" },
      { name: "longitude", type: "Float" },
    ],
  },
  racesplit_direct_ingestion: {
    tableName: "RaceSplit",
    mappingRuleName: "racesplit_json_map",
    streamName: "racesplit_stream",
    columns: [
      { name: "entityType", type: "Nvarchar(max)" },
      { name: "raceId", type: "Nvarchar(max)" },
      { name: "timestamp", type: "DateTime" },
      { name: "distanceCoveredMeters", type: "Float" },
      { name: "currentPaceSecPerKm", type: "Float" },
      { name: "plannedPaceSecPerKm", type: "Float" },
      { name: "currentHeartRate", type: "BigInt" },
      { name: "leg", type: "Nvarchar(max)" },
      { name: "isFinish", type: "Nvarchar(max)" },
    ],
  },
};

interface TopologyDestination {
  name: string;
  properties: { tableName: string; mappingRuleName: string };
  inputSchemas?: Array<{ name: string; schema: { columns: Array<{ name: string; type: string }> } }>;
}

describe("Eventstream IaC topology schema", () => {
  for (const fileName of TOPOLOGY_FILES) {
    it(`${fileName}: every Eventhouse destination declares the canonical inputSchemas and mappingRuleName`, () => {
      const raw = readFileSync(path.join(eventstreamDir, fileName), "utf8");
      const topology = JSON.parse(raw) as { destinations: TopologyDestination[] };

      for (const [destinationName, expected] of Object.entries(EXPECTED_DESTINATIONS)) {
        const destination = topology.destinations.find((d) => d.name === destinationName);
        expect(destination, `${fileName} is missing destination "${destinationName}"`).toBeDefined();
        expect(destination!.properties.tableName).toBe(expected.tableName);
        expect(destination!.properties.mappingRuleName).toBe(expected.mappingRuleName);

        expect(
          destination!.inputSchemas,
          `${fileName} destination "${destinationName}" is missing inputSchemas`,
        ).toBeDefined();
        const inputSchema = destination!.inputSchemas!.find((s) => s.name === expected.streamName);
        expect(inputSchema, `${fileName} destination "${destinationName}" has no inputSchema named "${expected.streamName}"`).toBeDefined();
        const actualColumns = inputSchema!.schema.columns.map((column) => ({
          name: column.name,
          type: column.type,
        }));
        expect(actualColumns).toEqual(expected.columns);
      }
    });
  }
});
