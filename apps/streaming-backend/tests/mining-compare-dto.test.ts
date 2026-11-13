import { describe, expect, it } from "vitest";
import { mapComparisonRows, mapTrendRows } from "../src/mining/read/series-dto.js";

const request = {
  runId: "11111111-1111-4111-8111-111111111111",
  start: "2026-01-01T11:00:00.000Z",
  end: "2026-01-01T11:01:00.000Z",
  metric: "feed" as const,
  binMinutes: 1 as const,
  maxRows: 1000,
};

function row(line: "A" | "B" | "C") {
  return {
    status: "OK",
    plant_id: "D01",
    run_id: request.runId,
    line_id: line,
    module_id: `D01.${line}.crusher`,
    tag_id: `D01.${line}.crusher.ore_flow`,
    metric: "ore_flow",
    metric_family: "feed",
    bin_start_utc: request.start,
    value: 10,
    unit: "t/h",
    good_count: 1,
    non_good_count: 0,
    source_qualities: ["good"],
    uncertain_count: 0,
    bad_count: 0,
    late_count: 0,
    expected_samples: 2,
    coverage: 0.5,
    conflict_count: 0,
    first_event_time: "2026-01-01T11:00:30.0000000Z",
    last_event_time: "2026-01-01T11:00:30.0000000Z",
    first_received_at: "2026-01-01T11:00:31.0000000Z",
    last_received_at: "2026-01-01T11:00:31.0000000Z",
  };
}
const good = () => [row("A"), row("B"), row("C")];

describe("mining comparison DTO", () => {
  it("uses canonical source tag IDs and preserves uncertain and missing without values", () => {
    const rows = good();
    Object.assign(rows[1], {
      status: "UNCERTAIN_QUALITY",
      value: null,
      good_count: 0,
      non_good_count: 1,
      source_qualities: ["uncertain"],
      uncertain_count: 1,
      coverage: 0,
    });
    Object.assign(rows[2], {
      status: "GAP",
      value: null,
      good_count: 0,
      source_qualities: [],
      coverage: 0,
      first_event_time: null,
      last_event_time: null,
      first_received_at: null,
      last_received_at: null,
    });
    expect(mapComparisonRows(request, rows)).toMatchObject({
      plantId: "D01",
      runId: request.runId,
      moduleId: null,
      metric: "feed",
      rows: [
        {
          seriesId: "D01.A.crusher.ore_flow",
          value: 10,
          unit: "t/h",
          quality: "good",
          coverage: 0.5,
        },
        { seriesId: "D01.B.crusher.ore_flow", value: null, quality: "uncertain", coverage: 0 },
        { seriesId: "D01.C.crusher.ore_flow", value: null, quality: "missing", coverage: 0 },
      ],
    });
  });

  it("never treats a mixed bad or uncertain bin as good", () => {
    const rows = good();
    Object.assign(rows[0], {
      status: "MIXED_QUALITY",
      non_good_count: 1,
      uncertain_count: 1,
      source_qualities: JSON.stringify(["good", "uncertain"]),
    });
    Object.assign(rows[1], {
      status: "MIXED_QUALITY",
      non_good_count: 1,
      bad_count: 1,
      source_qualities: ["good", "bad"],
    });
    const result = mapComparisonRows(request, rows);
    expect(result.rows[0]).toMatchObject({ quality: "uncertain", value: null });
    expect(result.rows[1]).toMatchObject({ quality: "bad", value: null });
  });

  it("rejects unavailable controls and caller overflow", () => {
    expect(() =>
      mapComparisonRows(request, [
        {
          status: "BLOCKED_WRITER_APPROVAL",
          plant_id: "D01",
          run_id: request.runId,
          metric_family: "feed",
          tag_id: "",
        },
      ]),
    ).toThrowError(expect.objectContaining({ code: "upstream" }));
    expect(() => mapComparisonRows({ ...request, maxRows: 2 }, good())).toThrowError(
      expect.objectContaining({ code: "overflow" }),
    );
  });

  it("maps trend families to separate canonical module tags and retains units", () => {
    const trend = { ...request, moduleId: "D01.shared.water", metric: "water-energy" as const };
    const trendRow = {
      ...row("A"),
      module_id: trend.moduleId,
      tagId: "D01.shared.water.water_flow",
      seriesId: "D01.shared.water.water_flow",
      metric_family: "water-energy",
      unit: "m3/h",
    };
    expect(mapTrendRows(trend, [trendRow])).toMatchObject({
      moduleId: trend.moduleId,
      metric: "water-energy",
      rows: [{ seriesId: "D01.shared.water.water_flow", unit: "m3/h", quality: "good" }],
    });
    expect(() => mapTrendRows(trend, [{ ...trendRow, seriesId: "fabricated" }])).toThrowError(
      expect.objectContaining({ code: "malformed" }),
    );
    expect(() =>
      mapTrendRows(trend, [
        {
          status: "BLOCKED_RAW_TIMESTAMP_PROOF",
          plant_id: "D01",
          run_id: request.runId,
          module_id: trend.moduleId,
          metric_family: trend.metric,
          tagId: "",
        },
      ]),
    ).toThrow("BLOCKED_RAW_TIMESTAMP_PROOF");
    const missing = { ...trend, moduleId: "D01.A.crusher", metric: "density" as const };
    expect(() =>
      mapTrendRows(missing, [
        {
          status: "UNKNOWN_TAG",
          plant_id: "D01",
          run_id: request.runId,
          module_id: missing.moduleId,
          metric_family: missing.metric,
          tagId: "",
        },
      ]),
    ).toThrow("UNKNOWN_TAG");
  });

  it("rejects incomplete or inconsistent identities, coverage, provenance and quality", () => {
    const badRows = [
      good().slice(0, 2),
      [row("A"), row("A"), row("C")],
      [{ ...row("A"), tag_id: "D01.B.crusher.ore_flow" }, row("B"), row("C")],
      [{ ...row("A"), coverage: 1 }, row("B"), row("C")],
      [
        {
          ...row("A"),
          status: "OK",
          bad_count: 1,
          non_good_count: 1,
          source_qualities: ["good", "bad"],
        },
        row("B"),
        row("C"),
      ],
      [{ ...row("A"), first_event_time: "2026-02-31T11:00:00Z" }, row("B"), row("C")],
      [{ ...row("A"), first_event_time: "2026-01-01T10:59:30Z" }, row("B"), row("C")],
      [{ ...row("A"), value: Number.NaN }, row("B"), row("C")],
      [{ ...row("A"), conflict_count: 1 }, row("B"), row("C")],
    ];
    for (const rows of badRows) {
      expect(() => mapComparisonRows(request, rows)).toThrowError(
        expect.objectContaining({ code: "malformed" }),
      );
    }
  });
});
