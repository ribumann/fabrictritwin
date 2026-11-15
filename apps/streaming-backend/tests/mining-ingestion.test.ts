import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createD01RunContract } from "../src/mining-incidents/catalog.js";
import { expectedMiningEventIds, mapMiningIngestion } from "../src/mining/read/ingestion-dto.js";
import type { MiningRunRecord } from "../src/mining/run-coordinator.js";

const run: MiningRunRecord = {
  plantId: "D01",
  runId: "44444444-4444-4444-8444-444444444444",
  durationSeconds: 300,
  scenario: "normal",
  seed: 1,
  startedAt: "2026-11-15T08:00:00.000Z",
  stopAt: "2026-11-15T08:05:00.000Z",
  authorityUntil: "2026-11-15T08:05:05.000Z",
  phase: "publisher_complete",
  contract: createD01RunContract(),
};
const asOf = "2026-11-15T08:06:00.000Z";
const emptyHash = createHash("sha256").update("").digest("hex");
function results(): Record<string, unknown>[] {
  const expected = expectedMiningEventIds(run);
  return ["raw_telemetry", "raw_state", "validated_telemetry", "validated_state", "quarantine"].map(
    (family) => {
      const ids =
        family === "quarantine"
          ? { count: 0, hash: emptyHash }
          : family.endsWith("telemetry")
            ? expected.telemetry
            : expected.state;
      return {
        family,
        source_status: "READY",
        event_count: ids.count,
        copies: ids.count,
        conflicting_ids: 0,
        event_ids_hash: ids.hash,
      };
    },
  );
}

describe("exact Fabric ingestion reconciliation", () => {
  it("requires the entire expected telemetry and state ID sets, not just publisher success", () => {
    expect(expectedMiningEventIds(run)).toMatchObject({
      telemetry: { count: 505 },
      state: { count: 32 },
    });
    expect(mapMiningIngestion(run, asOf, results()).status).toBe("complete");
    const rows = results();
    rows[2].event_ids_hash = "a".repeat(64);
    expect(mapMiningIngestion(run, asOf, rows).status).toBe("partial");
    expect(mapMiningIngestion({ ...run, phase: "failed" }, asOf, results()).status).toBe("partial");
  });

  it("allows identical duplicate delivery but rejects conflicting or quarantined events", () => {
    const rows = results();
    rows[2].copies = Number(rows[2].copies) + 10;
    expect(mapMiningIngestion(run, asOf, rows).status).toBe("complete");
    rows[2].conflicting_ids = 1;
    expect(mapMiningIngestion(run, asOf, rows).status).toBe("partial");
    const quarantined = results();
    quarantined[4].event_count = 1;
    quarantined[4].copies = 1;
    quarantined[4].event_ids_hash = "a".repeat(64);
    expect(mapMiningIngestion(run, asOf, quarantined).status).toBe("partial");
  });

  it("reports empty reads as pending and failed source readiness as unknown", () => {
    const rows = results().map((row) => ({
      ...row,
      event_count: 0,
      copies: 0,
      event_ids_hash: emptyHash,
    }));
    expect(mapMiningIngestion(run, asOf, rows).status).toBe("pending");
    rows[0].source_status = "SOURCE_NOT_READY";
    expect(mapMiningIngestion(run, asOf, rows).status).toBe("unknown");
  });

  it("fails closed on missing, duplicate, malformed or unversioned evidence", () => {
    expect(() => mapMiningIngestion(run, "invalid", results())).toThrow("timestamp");
    expect(() => mapMiningIngestion(run, asOf, results().slice(1))).toThrow("Missing");
    expect(() => mapMiningIngestion(run, asOf, [results()[0], ...results()])).toThrow("Invalid");
    const rows = results();
    rows[0].event_count = 50000;
    expect(() => mapMiningIngestion(run, asOf, rows)).toThrow("Invalid");
    expect(() => mapMiningIngestion({ ...run, contract: undefined }, asOf, results())).toThrow(
      "Invalid D01 run contract",
    );
  });
});
