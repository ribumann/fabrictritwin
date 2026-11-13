import { describe, expect, it } from "vitest";
import { D01_PLANT_CATALOG } from "@triathlon-twin/simulator/mining";
import { mapLatestRows } from "../src/mining/read/latest-dto.js";

const input = { runId: "123e4567-e89b-42d3-a456-426614174000", asOf: "2026-01-01T00:05:00.000Z" };
function sourceRows(): Record<string, unknown>[] {
  const common = { plant_id: "D01", run_id: input.runId, as_of_utc: input.asOf };
  return [
    ...D01_PLANT_CATALOG.telemetry_tags.map((tag) => ({
      ...common,
      row_kind: "tag",
      status: "UNKNOWN_NO_OBSERVATION",
      tagId: tag.id,
      seriesId: tag.id,
      module_id: tag.module_id,
      equipment_id: tag.equipment_id,
      metric: tag.metric,
      unit: tag.unit,
      value: null,
      quality: "",
      event_time: null,
      received_at: null,
      age_seconds: null,
    })),
    ...["A", "B", "C", "shared"].map((scope_id) => ({
      ...common,
      row_kind: "state",
      status: "UNKNOWN_NO_STATE",
      scope_id,
      event_time: null,
      received_at: null,
      age_seconds: null,
      state: "",
      scheduled_running: null,
    })),
  ];
}

describe("latest mining source mapping", () => {
  it("preserves missing tags and unknown states without inventing normal bands", () => {
    const mapped = mapLatestRows(input, sourceRows());
    expect(mapped.readings).toHaveLength(56);
    expect(
      mapped.readings.every(
        (reading) =>
          reading.quality === "missing" && reading.value === null && reading.normalBand === null,
      ),
    ).toBe(true);
    expect(mapped.states.A).toEqual({ status: "unknown", state: null });
  });

  it("preserves uncertain, bad, and stale readings distinctly", () => {
    const rows = sourceRows();
    for (const [index, quality, status, age] of [
      [0, "uncertain", "UNCERTAIN_QUALITY", 10],
      [1, "bad", "BAD_QUALITY", 10],
      [2, "good", "STALE", 500],
    ] as const) {
      Object.assign(rows[index], {
        quality,
        status,
        value: 7,
        age_seconds: age,
        event_time: new Date(Date.parse(input.asOf) - age * 1000).toISOString(),
        received_at: input.asOf,
      });
    }
    expect(
      mapLatestRows(input, rows)
        .readings.slice(0, 3)
        .map((reading) => reading.quality),
    ).toEqual(["uncertain", "bad", "stale"]);
  });

  it("rejects incomplete or spoofed grids and exposes source conflict", () => {
    const rows = sourceRows();
    expect(() => mapLatestRows(input, rows.slice(1))).toThrow("Incomplete");
    rows[0].unit = "invalid";
    expect(() => mapLatestRows(input, rows)).toThrow("catalog");
    const conflicting = sourceRows();
    conflicting[0].status = "DUPLICATE_CONFLICT";
    expect(() => mapLatestRows(input, conflicting)).toThrow("conflicting events");
    const wrongInstant = sourceRows();
    wrongInstant[0].as_of_utc = "2026-01-01T00:05:00.0000001Z";
    expect(() => mapLatestRows(input, wrongInstant)).toThrow("scope");
  });

  it("does not mistake a blocked readiness control for missing data", () => {
    expect(() =>
      mapLatestRows(input, [
        {
          plant_id: "D01",
          run_id: input.runId,
          as_of_utc: input.asOf,
          row_kind: "contract",
          status: "BLOCKED_RAW_TIMESTAMP_PROOF",
        },
      ]),
    ).toThrow("BLOCKED_RAW_TIMESTAMP_PROOF");
  });
});
