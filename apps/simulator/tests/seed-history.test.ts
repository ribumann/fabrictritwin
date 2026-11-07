import { describe, expect, it } from "vitest";
import type {
  SeedHistoryFreshResult,
  SeedHistoryLakehouseResult,
  SeedHistoryStore,
  SessionMetricPublisher,
} from "../src/services/seed-history.js";
import { deriveGoalRaceId, seedHistory } from "../src/services/seed-history.js";

class InMemorySeedHistoryStore implements SeedHistoryStore {
  public existing: SeedHistoryFreshResult | null = null;
  public lakehouseWrites = 0;
  public lastPayload: Parameters<SeedHistoryStore["writeLakehouseFiles"]>[0]["payload"] | undefined;

  async getExistingSeed(): Promise<SeedHistoryFreshResult | null> {
    return this.existing;
  }

  async writeLakehouseFiles(
    input: Parameters<SeedHistoryStore["writeLakehouseFiles"]>[0],
  ): Promise<SeedHistoryLakehouseResult> {
    this.lakehouseWrites += 1;
    this.lastPayload = input.payload;

    return {
      mode: "files-pending-load",
      dataRootPath: `demo-lakehouse/Files/history-seeding/${input.environment}/${input.athleteId}`,
      manifestPath: `demo-lakehouse/Files/history-seeding/${input.environment}/${input.athleteId}/seed-manifest.json`,
      files: {
        Athlete: "Athlete.jsonl",
        TrainingBlock: "TrainingBlock.jsonl",
        TrainingBlockPhase: "TrainingBlockPhase.jsonl",
        TrainingSession: "TrainingSession.jsonl",
        RecoveryMetrics: "RecoveryMetrics.jsonl",
        NutritionLog: "NutritionLog.jsonl",
        SleepSession: "SleepSession.jsonl",
        Race: "Race.jsonl",
        Equipment: "Equipment.jsonl",
      },
      rowCounts: {
        Athlete: 1,
        TrainingBlock: 1,
        TrainingBlockPhase: input.payload.phases.length,
        TrainingSession: input.payload.sessions.length,
        RecoveryMetrics: input.payload.recoveryMetrics.length,
        NutritionLog: input.payload.nutritionLogs.length,
        SleepSession: input.payload.sleepSessions.length,
        Race: input.payload.races.length,
        Equipment: input.payload.equipment.length,
      },
      caveat:
        "Rows were written to the Lakehouse Files area only; a follow-up Fabric notebook/Data Pipeline must load Files/ into Delta Tables/ before dashboards can query them as Lakehouse tables.",
    };
  }

  async writeCompletionMarker(result: SeedHistoryFreshResult): Promise<void> {
    this.existing = result;
  }
}

class InMemorySessionMetricPublisher implements SessionMetricPublisher {
  public publishedCount = 0;

  async publish(metrics: Parameters<SessionMetricPublisher["publish"]>[0]): Promise<number> {
    this.publishedCount += metrics.length;
    return metrics.length;
  }

  describeTarget() {
    return {
      fullyQualifiedNamespace: "triathlon-demo.servicebus.windows.net",
      eventHubName: "seed-history",
      mappingName: "sessionmetric_json_map" as const,
      route: "eventstream-custom-endpoint" as const,
    };
  }
}

describe("seedHistory", () => {
  it("builds the 16-week seeded dataset, persists Lakehouse files, and publishes SessionMetric telemetry", async () => {
    const store = new InMemorySeedHistoryStore();
    const publisher = new InMemorySessionMetricPublisher();

    const result = await seedHistory(
      {
        athleteId: "11111111-1111-4111-8111-111111111111",
        referenceDate: "2026-09-03",
        environment: "test",
        seed: 424_242,
      },
      {
        store,
        sessionMetricPublisher: publisher,
        now: () => new Date("2026-09-03T12:00:00.000Z"),
        runIdFactory: () => "run-seed-001",
      },
    );

    expect(result.outcome).toBe("seeded");
    expect(result.status).toBe("completed");
    expect(result.counts.TrainingBlockPhase).toBe(4);
    expect(result.counts.TrainingSession).toBe(112);
    expect(result.counts.RecoveryMetrics).toBe(112);
    expect(result.counts.SleepSession).toBe(112);
    expect(result.counts.Race).toBe(3);
    expect(result.counts.Equipment).toBe(3);
    expect(result.counts.SessionMetric).toBeGreaterThan(0);
    expect(result.eventhouse.publishedSessionMetricCount).toBe(result.counts.SessionMetric);
    expect(result.lakehouse.mode).toBe("files-pending-load");
    expect(result.anomalies).toHaveLength(3);
    expect(store.lakehouseWrites).toBe(1);
    expect(publisher.publishedCount).toBe(result.counts.SessionMetric);
  });

  it("assigns the seeded athlete's goal race the id deriveGoalRaceId computes for the same athleteId/seed", async () => {
    const store = new InMemorySeedHistoryStore();
    const publisher = new InMemorySessionMetricPublisher();
    const athleteId = "11111111-1111-4111-8111-111111111111";
    const seed = 424_242;

    await seedHistory(
      { athleteId, referenceDate: "2026-09-03", environment: "test", seed },
      {
        store,
        sessionMetricPublisher: publisher,
        now: () => new Date("2026-09-03T12:00:00.000Z"),
        runIdFactory: () => "run-seed-001",
      },
    );

    const expectedGoalRaceId = deriveGoalRaceId(athleteId, seed);
    const raceIds = store.lastPayload?.races.map((race) => race.raceId) ?? [];
    expect(raceIds).toContain(expectedGoalRaceId);
  });

  it("returns an idempotent no-op result when the athlete already has a completion marker", async () => {
    const store = new InMemorySeedHistoryStore();
    const publisher = new InMemorySessionMetricPublisher();

    const initial = (await seedHistory(
      {
        athleteId: "11111111-1111-4111-8111-111111111111",
        referenceDate: "2026-09-03",
        environment: "test",
        seed: 424_242,
      },
      {
        store,
        sessionMetricPublisher: publisher,
        now: () => new Date("2026-09-03T12:00:00.000Z"),
        runIdFactory: () => "run-seed-001",
      },
    )) as SeedHistoryFreshResult;

    const repeated = await seedHistory(
      {
        athleteId: "11111111-1111-4111-8111-111111111111",
        referenceDate: "2026-09-03",
        environment: "test",
        seed: 424_242,
      },
      {
        store,
        sessionMetricPublisher: publisher,
        now: () => new Date("2026-09-03T12:05:00.000Z"),
        runIdFactory: () => "run-seed-002",
      },
    );

    expect(repeated.outcome).toBe("already-seeded");
    expect(repeated.status).toBe("already-seeded");
    expect(repeated.runId).toBe(initial.runId);
    expect(repeated.existingStatus).toBe("completed");
    expect(store.lakehouseWrites).toBe(1);
    expect(publisher.publishedCount).toBe(initial.counts.SessionMetric);
  });

  it("coalesces concurrent calls for the same athlete/environment into a single execution (regression for duplicate-seed race)", async () => {
    const store = new InMemorySeedHistoryStore();
    const publisher = new InMemorySessionMetricPublisher();
    const options = {
      athleteId: "11111111-1111-4111-8111-111111111111",
      referenceDate: "2026-09-03",
      environment: "test",
      seed: 424_242,
    };
    const dependencies = {
      store,
      sessionMetricPublisher: publisher,
      now: () => new Date("2026-09-03T12:00:00.000Z"),
      runIdFactory: () => "run-seed-001",
    };

    // Fire both calls without awaiting the first -- without coalescing, both would race past the
    // "not yet seeded" check and each perform a full seed (duplicate Lakehouse writes + duplicate
    // SessionMetric publishes).
    const [first, second] = await Promise.all([seedHistory(options, dependencies), seedHistory(options, dependencies)]);

    expect(store.lakehouseWrites).toBe(1);
    expect(publisher.publishedCount).toBe((first as SeedHistoryFreshResult).counts.SessionMetric);
    expect(first).toBe(second);
    expect((first as SeedHistoryFreshResult).outcome).toBe("seeded");
  });
});
