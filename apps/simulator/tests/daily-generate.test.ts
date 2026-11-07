import { describe, expect, it, vi } from "vitest";
import { deriveSeed } from "../src/generators/random.js";
import { generateTrainingSessionsForDateRange } from "../src/generators/periodization.js";
import type {
  DailyGenerationState,
  DailyGenerationStore,
  DailyGenerationNotebookLoader,
} from "../src/services/daily-generate.js";
import { dailyGenerateAthlete, runDailyGenerationJob } from "../src/services/daily-generate.js";
import type {
  SeedHistoryFreshResult,
  SeedHistoryLakehouseResult,
  SeedHistoryStore,
  SessionMetricPublisher,
} from "../src/services/seed-history.js";
import { deriveGoalRaceId, seedHistory } from "../src/services/seed-history.js";

type LakehouseSeedPayload = Parameters<SeedHistoryStore["writeLakehouseFiles"]>[0]["payload"];

class InMemoryDailyGenerationStore implements SeedHistoryStore, DailyGenerationStore {
  public manifests = new Map<string, SeedHistoryFreshResult>();
  public payloads = new Map<string, LakehouseSeedPayload>();
  public states = new Map<string, DailyGenerationState>();
  public lakehouseWrites = 0;

  private key(athleteId: string, environment: string): string {
    return `${environment}:${athleteId}`;
  }

  async getExistingSeed(athleteId: string, environment: string): Promise<SeedHistoryFreshResult | null> {
    return this.manifests.get(this.key(athleteId, environment)) ?? null;
  }

  async writeLakehouseFiles(
    input: Parameters<SeedHistoryStore["writeLakehouseFiles"]>[0],
  ): Promise<SeedHistoryLakehouseResult> {
    this.lakehouseWrites += 1;
    this.payloads.set(this.key(input.athleteId, input.environment), structuredClone(input.payload));

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
    this.manifests.set(this.key(result.athleteId, result.environment), structuredClone(result));
  }

  async listSeededAthleteIds(environment: string): Promise<string[]> {
    return [...this.manifests.values()]
      .filter((manifest) => manifest.environment === environment)
      .map((manifest) => manifest.athleteId)
      .sort();
  }

  async readLakehousePayload(athleteId: string, environment: string): Promise<LakehouseSeedPayload | null> {
    return structuredClone(this.payloads.get(this.key(athleteId, environment)) ?? null);
  }

  async readDailyGenerationState(athleteId: string, environment: string): Promise<DailyGenerationState | null> {
    return structuredClone(this.states.get(this.key(athleteId, environment)) ?? null);
  }

  async writeDailyGenerationState(state: DailyGenerationState): Promise<string> {
    this.states.set(this.key(state.athleteId, state.environment), structuredClone(state));
    return `demo-lakehouse/Files/history-seeding/${state.environment}/${state.athleteId}/daily-generation-state.json`;
  }
}

class InMemorySessionMetricPublisher implements SessionMetricPublisher {
  async publish(metrics: Parameters<SessionMetricPublisher["publish"]>[0]): Promise<number> {
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

class RecordingNotebookLoader implements DailyGenerationNotebookLoader {
  public calls: Array<{ environment: string; athleteId?: string }> = [];

  async run(args: { environment: string; athleteId?: string }) {
    this.calls.push(args);
    return {
      attempted: true,
      status: "completed" as const,
      workspaceId: "workspace-1",
      notebookId: "notebook-1",
      jobInstanceId: "job-1",
    };
  }
}

async function seedBaseline(
  store: InMemoryDailyGenerationStore,
  athleteId = "11111111-1111-4111-8111-111111111111",
): Promise<LakehouseSeedPayload> {
  const publisher = new InMemorySessionMetricPublisher();
  const environment = "test";
  const seed = 424_242;

  await seedHistory(
    {
      athleteId,
      goalRaceId: deriveGoalRaceId(athleteId, seed),
      referenceDate: "2026-09-03",
      environment,
      seed,
    },
    {
      store,
      sessionMetricPublisher: publisher,
      now: () => new Date("2026-09-03T12:00:00.000Z"),
      runIdFactory: () => "run-seed-001",
    },
  );

  return (await store.readLakehousePayload(athleteId, environment))!;
}

describe("dailyGenerateAthlete", () => {
  it("is idempotent for the same calendar day and does not duplicate per-day records", async () => {
    const store = new InMemoryDailyGenerationStore();
    await seedBaseline(store);

    const first = await dailyGenerateAthlete(
      {
        athleteId: "11111111-1111-4111-8111-111111111111",
        environment: "test",
        targetDate: "2026-09-04",
        seed: 424_242,
      },
      {
        store,
        now: () => new Date("2026-09-04T03:00:00.000Z"),
        runIdFactory: () => "daily-run-001",
      },
    );

    const second = await dailyGenerateAthlete(
      {
        athleteId: "11111111-1111-4111-8111-111111111111",
        environment: "test",
        targetDate: "2026-09-04",
        seed: 424_242,
      },
      {
        store,
        now: () => new Date("2026-09-04T03:05:00.000Z"),
        runIdFactory: () => "daily-run-002",
      },
    );

    const payload = (await store.readLakehousePayload("11111111-1111-4111-8111-111111111111", "test"))!;
    expect(first.outcome).toBe("generated");
    expect(second.outcome).toBe("already-generated");
    expect(store.lakehouseWrites).toBe(2); // one seed write + one daily write
    expect(new Set(payload.recoveryMetrics.map((record) => `${record.athleteId}|${record.date}`)).size).toBe(payload.recoveryMetrics.length);
    expect(new Set(payload.sleepSessions.map((record) => `${record.athleteId}|${record.date}`)).size).toBe(payload.sleepSessions.length);
    expect(new Set(payload.nutritionLogs.map((record) => `${record.athleteId}|${record.date}|${record.mealType}`)).size).toBe(payload.nutritionLogs.length);
    expect(payload.recoveryMetrics.filter((record) => record.date === "2026-09-04")).toHaveLength(1);
    expect(payload.sleepSessions.filter((record) => record.date === "2026-09-04")).toHaveLength(1);
    expect(store.states.get("test:11111111-1111-4111-8111-111111111111")?.lastGeneratedDate).toBe("2026-09-04");

    // Regression guard: daily-generated sessions must be immediately queryable as completed
    // training (status "completed" with a non-null rpe), matching how the initial history seed
    // treats past days. A daily session stuck at "planned"/null forever is invisible to every
    // completed-session query (dashboards, the Athlete Assistant, FR-006/FR-007 KQL analyses).
    const generatedSessionsForToday = payload.sessions.filter((session) => session.plannedDate.startsWith("2026-09-04"));
    expect(generatedSessionsForToday.length).toBeGreaterThan(0);
    for (const session of generatedSessionsForToday) {
      expect(session.status).toBe("completed");
      expect(session.rpe).not.toBeNull();
      expect(session.source).toBe("daily-generated");
    }
  });

  it("flags missed days instead of silently backfilling them", async () => {
    const store = new InMemoryDailyGenerationStore();
    await seedBaseline(store);

    const result = await dailyGenerateAthlete(
      {
        athleteId: "11111111-1111-4111-8111-111111111111",
        environment: "test",
        targetDate: "2026-09-06",
        seed: 424_242,
      },
      {
        store,
        now: () => new Date("2026-09-06T03:00:00.000Z"),
        runIdFactory: () => "daily-run-gap",
      },
    );

    const payload = (await store.readLakehousePayload("11111111-1111-4111-8111-111111111111", "test"))!;
    expect(result.gap.status).toBe("gap-detected");
    expect(result.gap.missedDates).toEqual(["2026-09-04", "2026-09-05"]);
    expect(payload.recoveryMetrics.some((record) => record.date === "2026-09-04")).toBe(false);
    expect(payload.recoveryMetrics.some((record) => record.date === "2026-09-05")).toBe(false);
    expect(payload.recoveryMetrics.some((record) => record.date === "2026-09-06")).toBe(true);
    expect(store.states.get("test:11111111-1111-4111-8111-111111111111")?.activeGaps).toEqual([
      {
        fromDate: "2026-09-04",
        toDate: "2026-09-05",
        missedDates: ["2026-09-04", "2026-09-05"],
        gapDays: 2,
        detectedOn: "2026-09-06",
      },
    ]);
  });

  it("continues from the seeded training block instead of generating a fresh shifted plan", async () => {
    const store = new InMemoryDailyGenerationStore();
    const baseline = await seedBaseline(store);

    await dailyGenerateAthlete(
      {
        athleteId: "11111111-1111-4111-8111-111111111111",
        environment: "test",
        targetDate: "2026-09-04",
        seed: 424_242,
      },
      {
        store,
        now: () => new Date("2026-09-04T03:00:00.000Z"),
        runIdFactory: () => "daily-run-plan",
      },
    );

    const payload = (await store.readLakehousePayload("11111111-1111-4111-8111-111111111111", "test"))!;
    const generatedSessions = payload.sessions.filter((session) => session.plannedDate.startsWith("2026-09-04"));
    const continuedPhases = baseline.phases.map((phase, index) =>
      index === baseline.phases.length - 1 ? { ...phase, endDate: "2026-09-04" } : phase,
    );
    const expected = generateTrainingSessionsForDateRange({
      trainingBlock: { ...baseline.trainingBlock, endDate: "2026-09-04" },
      phases: continuedPhases,
      startDate: "2026-09-04",
      endDate: "2026-09-04",
      seed: deriveSeed(deriveSeed(424_242, "11111111-1111-4111-8111-111111111111"), "periodization"),
    }).map((session) => ({
      ...session,
      source: "daily-generated" as const,
    }));
    const freshWindow = generateTrainingSessionsForDateRange({
      trainingBlock: {
        ...baseline.trainingBlock,
        startDate: "2026-05-16",
        endDate: "2026-09-04",
      },
      phases: [
        { ...baseline.phases[0]!, startDate: "2026-05-16", endDate: "2026-06-29" },
        { ...baseline.phases[1]!, startDate: "2026-06-30", endDate: "2026-08-07" },
        { ...baseline.phases[2]!, startDate: "2026-08-08", endDate: "2026-08-24" },
        { ...baseline.phases[3]!, startDate: "2026-08-25", endDate: "2026-09-04" },
      ],
      startDate: "2026-09-04",
      endDate: "2026-09-04",
      seed: deriveSeed(deriveSeed(424_242, "11111111-1111-4111-8111-111111111111"), "periodization"),
    }).map((session) => ({
      ...session,
      source: "daily-generated" as const,
    }));

    expect(generatedSessions).toEqual(expected);
    expect(generatedSessions).not.toEqual(freshWindow);
    expect(generatedSessions.every((session) => session.trainingBlockId === baseline.trainingBlock.trainingBlockId)).toBe(true);
  });
});

describe("runDailyGenerationJob", () => {
  it("loads the Fabric notebook once after generating one or more athletes", async () => {
    const store = new InMemoryDailyGenerationStore();
    const notebookLoader = new RecordingNotebookLoader();
    await seedBaseline(store);
    await seedBaseline(store, "22222222-2222-4222-8222-222222222222");

    const result = await runDailyGenerationJob(
      {
        environment: "test",
        targetDate: "2026-09-04",
        seed: 424_242,
      },
      {
        store,
        notebookLoader,
        now: () => new Date("2026-09-04T03:00:00.000Z"),
        runIdFactory: () => "daily-run-job",
      },
    );

    expect(result.athleteIds).toEqual(["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]);
    expect(result.notebookLoad.status).toBe("completed");
    expect(notebookLoader.calls).toEqual([{ environment: "test" }]);
  });

  it("retries a failed table load from persisted generation state without rewriting daily files", async () => {
    const store = new InMemoryDailyGenerationStore();
    await seedBaseline(store);
    const options = { environment: "test", targetDate: "2026-09-04", seed: 424_242 };
    const failedLoader = { run: vi.fn().mockRejectedValue(new Error("UserAccessTokenException")) };

    await expect(runDailyGenerationJob(options, { store, notebookLoader: failedLoader })).rejects.toThrow("UserAccessTokenException");
    expect(failedLoader.run).toHaveBeenCalledOnce();
    expect(store.states.get("test:11111111-1111-4111-8111-111111111111")?.lastGeneratedDate).toBe("2026-09-04");
    expect(store.lakehouseWrites).toBe(2);

    // Model a new process: only durable Files/manifests/state survive, not loader state.
    const restartedStore = new InMemoryDailyGenerationStore();
    restartedStore.manifests = structuredClone(store.manifests);
    restartedStore.payloads = structuredClone(store.payloads);
    restartedStore.states = structuredClone(store.states);
    const notebookLoader = new RecordingNotebookLoader();
    const result = await runDailyGenerationJob(options, { store: restartedStore, notebookLoader });

    expect(result.athleteResults[0]?.outcome).toBe("already-generated");
    expect(result.athleteResults[0]?.lakehouseChanged).toBe(false);
    expect(restartedStore.lakehouseWrites).toBe(0);
    expect(restartedStore.payloads).toEqual(store.payloads);
    expect(notebookLoader.calls).toEqual([{ environment: "test" }]);
    expect(result.notebookLoad.status).toBe("completed");
  });

  it("still fails when the load fails again for already-generated data", async () => {
    const store = new InMemoryDailyGenerationStore();
    await seedBaseline(store);
    const options = { environment: "test", targetDate: "2026-09-04" };
    const notebookLoader = { run: vi.fn().mockRejectedValue(new Error("Notebook load failed")) };

    await expect(runDailyGenerationJob(options, { store, notebookLoader })).rejects.toThrow("Notebook load failed");
    await expect(runDailyGenerationJob(options, { store, notebookLoader })).rejects.toThrow("Notebook load failed");

    expect(notebookLoader.run).toHaveBeenCalledTimes(2);
    expect(store.lakehouseWrites).toBe(2);
  });

  it("loads existing seeded files even when the target date needs no new generation", async () => {
    const store = new InMemoryDailyGenerationStore();
    await seedBaseline(store);
    const notebookLoader = new RecordingNotebookLoader();

    const result = await runDailyGenerationJob(
      { environment: "test", targetDate: "2026-09-03" },
      { store, notebookLoader },
    );

    expect(result.athleteResults[0]?.outcome).toBe("already-generated");
    expect(store.lakehouseWrites).toBe(1);
    expect(notebookLoader.calls).toEqual([{ environment: "test" }]);
    expect(result.notebookLoad.status).toBe("completed");
  });

  it("only skips the notebook when there are no seeded athletes", async () => {
    const store = new InMemoryDailyGenerationStore();
    const notebookLoader = new RecordingNotebookLoader();

    const result = await runDailyGenerationJob({ environment: "test" }, { store, notebookLoader });

    expect(result.notebookLoad).toEqual({ attempted: false, status: "skipped-no-athletes" });
    expect(notebookLoader.calls).toEqual([]);
  });
});
