import { describe, expect, it, vi } from "vitest";
import { createBoundedMiningQuery } from "../src/mining/read/bounded-query.js";
import { createMiningDemoProvider } from "../src/mining/read/demo-provider.js";
import type { MiningRunRecord } from "../src/mining/run-coordinator.js";
import { createD01RunContract } from "../src/mining-incidents/catalog.js";

const run: MiningRunRecord = {
  plantId: "D01",
  runId: "11111111-1111-4111-8111-111111111111",
  scenario: "normal",
  seed: 1,
  durationSeconds: 300,
  startedAt: "2026-01-01T11:00:00.000Z",
  stopAt: "2026-01-01T11:05:00.000Z",
  authorityUntil: "2026-01-01T11:00:45.000Z",
  phase: "running",
};
const start = "2026-01-01T11:00:00.000Z";
const end = "2026-01-01T11:01:00.000Z";

describe("public mining curated reads", () => {
  it("does not query finite incident or overview contracts for continuous lifetimes", async () => {
    const query = vi.fn<ReturnType<typeof createBoundedMiningQuery>>();
    const provider = createMiningDemoProvider({}, query);
    const continuous: MiningRunRecord = {
      plantId: "D01",
      runId: run.runId,
      scenario: "normal",
      seed: 1,
      startedAt: run.startedAt,
      authorityUntil: run.authorityUntil,
      phase: "running",
      contract: createD01RunContract(),
      lifetime: { kind: "continuous", generation: "release-1" },
    };
    for (const kind of ["incidents", "overview"] as const) {
      await expect(
        provider(
          {
            kind,
            run: continuous,
            asOf: end,
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow("bounded-run");
    }
    expect(query).not.toHaveBeenCalled();
  });
  it("maps real scoped comparison rows without requiring an incident journal", async () => {
    const rows = (["A", "B", "C"] as const).map((line) => ({
      status: "OK",
      plant_id: "D01",
      run_id: run.runId,
      line_id: line,
      module_id: `D01.${line}.crusher`,
      tag_id: `D01.${line}.crusher.ore_flow`,
      metric: "ore_flow",
      metric_family: "feed",
      bin_start_utc: start,
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
    }));
    const query = vi.fn<ReturnType<typeof createBoundedMiningQuery>>().mockResolvedValue(rows);
    const provider = createMiningDemoProvider({}, query);
    const signal = new AbortController().signal;
    const result = await provider(
      { kind: "compare", run, start, end, metric: "feed", binMinutes: 1, maxRows: 1000 },
      signal,
    );
    expect(result).toMatchObject({ plantId: "D01", runId: run.runId, rows: expect.any(Array) });
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "compare", runId: run.runId, start, end }),
      signal,
    );
  });

  it("surfaces query failures and never invents incident assessments", async () => {
    const query = vi
      .fn<ReturnType<typeof createBoundedMiningQuery>>()
      .mockRejectedValue(new Error("offline"));
    const provider = createMiningDemoProvider({}, query);
    const signal = new AbortController().signal;
    await expect(
      provider(
        { kind: "compare", run, start, end, metric: "feed", binMinutes: 1, maxRows: 1000 },
        signal,
      ),
    ).rejects.toThrow("offline");
    await expect(provider({ kind: "incidents", run, asOf: end }, signal)).rejects.toThrow(
      "awaiting a completed demo run",
    );
  });
});
