import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  D01_CATALOG_VERSION,
  D01_PLANT_CATALOG,
  D01_PUBLISH_PROFILE_VERSION,
  getD01TagIntervalSeconds,
} from "@triathlon-twin/simulator/mining";
import { createD01IncidentRun, createD01RunContract } from "../src/mining-incidents/catalog.js";
import { createContinuousIncidentProvider } from "../src/mining-incidents/continuous-provider.js";
import {
  continuousIncidentPartitionQuery,
  readContinuousIncidentWindow,
  type ContinuousIncidentPartition,
} from "../src/mining-incidents/continuous-source.js";

const START = Date.parse("2026-01-01T00:00:00.000Z");
const RUN = "11111111-1111-4111-8111-111111111111";
const iso = (second: number) => new Date(START + second * 1000).toISOString();
const run = createD01IncidentRun({ runId: RUN, startedAt: iso(0), stopAt: iso(1200) });
const tag = D01_PLANT_CATALOG.telemetry_tags.find(
  (candidate) => candidate.id === "D01.shared.water.level",
)!;

function row(second: number, sequence: number): Record<string, unknown> {
  return {
    source: "mining_ValidatedTelemetry",
    plant_id: "D01",
    run_id: RUN,
    event_id: createHash("sha256").update(`${RUN}:${sequence}`).digest("hex"),
    sequence,
    timestamp: iso(second),
    received_at: iso(second + 1),
    catalog_version: D01_CATALOG_VERSION,
    profile_version: D01_PUBLISH_PROFILE_VERSION,
    source_contract_version: "d01-validated-source-v1",
    tag_id: tag.id,
    module_id: tag.module_id,
    equipment_id: tag.equipment_id,
    unit: tag.unit,
    value: 55,
    quality: "good",
    interval_seconds: getD01TagIntervalSeconds(tag),
    event_conflict: false,
  };
}

function fixtures(rows: Record<string, unknown>[]) {
  const readiness = vi.fn(async () => [
    {
      status: "READY",
      catalog_version: D01_CATALOG_VERSION,
      profile_version: D01_PUBLISH_PROFILE_VERSION,
      contract_version: "d01-validated-source-v1",
    },
  ]);
  const query = vi.fn(async (input: ContinuousIncidentPartition) =>
    rows.filter((item) => {
      const timestamp = Date.parse(item.timestamp as string);
      return (
        timestamp >= Date.parse(input.start) &&
        (timestamp < Date.parse(input.end) ||
          (input.includeEnd && timestamp === Date.parse(input.end)))
      );
    }),
  );
  return { readiness, query, now: () => START + 1_230_000 };
}

describe("continuous incident source partitions", () => {
  it("checks candidate IDs against both retained source families outside the time partition", () => {
    const identities = continuousIncidentPartitionQuery.split("let identities = union")[1];
    expect(identities).toContain("mining_ValidatedTelemetry");
    expect(identities).toContain("mining_ValidatedState");
    expect(identities).toContain("join kind=leftsemi (candidates | distinct event_id)");
    expect(identities).toContain("array_length(identities) != 1");
    expect(identities).not.toMatch(/timestamp\s*(?:>=|<=|>|<)\s*(?:start|end)/);
  });

  it("uses adjacent bounded partitions including the last endpoint once", async () => {
    const dependencies = fixtures([row(0, 1), row(300, 2), row(600, 3), row(900, 4), row(1200, 5)]);
    const result = await readContinuousIncidentWindow(
      run,
      iso(1200),
      dependencies,
      new AbortController().signal,
    );
    expect(dependencies.readiness).toHaveBeenCalledTimes(2);
    expect(dependencies.query).toHaveBeenCalledTimes(4);
    expect(dependencies.query.mock.calls.map(([input]) => input)).toEqual([
      { runId: RUN, start: iso(0), end: iso(300), includeEnd: false, maxRows: 1000 },
      { runId: RUN, start: iso(300), end: iso(600), includeEnd: false, maxRows: 1000 },
      { runId: RUN, start: iso(600), end: iso(900), includeEnd: false, maxRows: 1000 },
      { runId: RUN, start: iso(900), end: iso(1200), includeEnd: true, maxRows: 1000 },
    ]);
    expect(result.sourceObservedAt).toBe(iso(1230));
    expect(result.observations.map((observation) => observation.timestamp)).toEqual([
      iso(0),
      iso(300),
      iso(600),
      iso(900),
      iso(1200),
    ]);
  });

  it("rejects conflicts and duplicate identities rather than selecting a payload", async () => {
    const conflict = fixtures([{ ...row(30, 1), event_conflict: true }]);
    await expect(
      readContinuousIncidentWindow(run, iso(1200), conflict, new AbortController().signal),
    ).rejects.toThrow(/contains a conflict/);
    const repeated = fixtures([row(30, 1), row(330, 1)]);
    await expect(
      readContinuousIncidentWindow(run, iso(1200), repeated, new AbortController().signal),
    ).rejects.toThrow(/partition evidence overlaps/);
  });

  it("rejects unready sources and rows outside their requested partition", async () => {
    const unavailable = fixtures([]);
    unavailable.readiness.mockResolvedValueOnce([]);
    await expect(
      readContinuousIncidentWindow(run, iso(1200), unavailable, new AbortController().signal),
    ).rejects.toThrow(/not ready/);
    expect(unavailable.query).not.toHaveBeenCalled();

    const overlapping = fixtures([]);
    overlapping.query.mockResolvedValueOnce([row(300, 1)]);
    await expect(
      readContinuousIncidentWindow(run, iso(1200), overlapping, new AbortController().signal),
    ).rejects.toThrow(/partition evidence overlaps/);
  });

  it("withdraws captured evidence if readiness changes during the read", async () => {
    const dependencies = fixtures([row(30, 1)]);
    dependencies.readiness
      .mockResolvedValueOnce([
        {
          status: "READY",
          catalog_version: D01_CATALOG_VERSION,
          profile_version: D01_PUBLISH_PROFILE_VERSION,
          contract_version: "d01-validated-source-v1",
        },
      ])
      .mockResolvedValueOnce([]);
    await expect(
      readContinuousIncidentWindow(run, iso(1200), dependencies, new AbortController().signal),
    ).rejects.toThrow(/not ready/);
    expect(dependencies.query).toHaveBeenCalledTimes(4);
  });

  it("builds a retrospective snapshot only from the current owner and both source families", async () => {
    const reading = row(600, 1);
    const state = {
      ...row(600, 2),
      source: "mining_ValidatedState",
      profile_version: "",
      scope_id: "B",
      scheduled_running: true,
      state: "running",
    };
    const owner = {
      runId: RUN,
      startedAt: iso(0),
      authorityUntil: iso(1800),
      phase: "running" as const,
      lifetime: { kind: "continuous" as const, generation: "g1" },
      contract: createD01RunContract(),
    };
    const isCurrentOwner = vi.fn().mockResolvedValue(true);
    const provider = createContinuousIncidentProvider(fixtures([reading, state]), isCurrentOwner);
    const result = await provider(owner, new AbortController().signal);
    expect(result).toMatchObject({
      assessmentKind: "rolling-event-time-advisory",
      runId: RUN,
      asOf: iso(1140),
      sourceObservedAt: iso(1230),
    });
    expect(isCurrentOwner).toHaveBeenCalledOnce();
    await expect(
      provider(
        { ...owner, contract: { ...owner.contract, profileVersion: "unsupported" } },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/Unsupported D01 run contract/);
    const incomplete = createContinuousIncidentProvider(fixtures([state]), isCurrentOwner);
    await expect(incomplete(owner, new AbortController().signal)).rejects.toThrow(/incomplete/);
  });
});
