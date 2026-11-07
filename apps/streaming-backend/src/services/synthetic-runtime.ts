import { randomUUID } from "node:crypto";
import {
  DEFAULT_HISTORY_SEED,
  createLiveSessionGenerator,
  createRaceDayGenerator,
  generateSeedHistoryDataset,
  type LiveSessionTick,
  type RaceDayTick,
  type TrainingDiscipline,
} from "@triathlon-twin/simulator";
import { RaceStateStore } from "./race-state.js";
import { realtimeStreamBroker, type RealtimeStreamBroker } from "./realtime-stream.js";
import {
  SYNTHETIC_ATHLETE_ID,
  SYNTHETIC_REFERENCE_DATE,
  SyntheticInsightsService,
} from "./synthetic-insights.js";

const WINDOW_MS = 60_000;
const MAX_STARTS = 2;
const INTERVAL_MS = 1_000;
const SAMPLES = 16;
const HISTORY_LIMIT = 10;

export type SyntheticRun = {
  runId: string;
  kind: "session" | "race";
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  endedAt: string | null;
  error: string | null;
};

interface RuntimeOptions {
  broker?: RealtimeStreamBroker;
  now?: () => number;
  intervalMs?: number;
  sessionGenerator?: typeof createLiveSessionGenerator;
  raceGenerator?: typeof createRaceDayGenerator;
}

/** Process-local demo state. No storage, distributed locking, or cloud clients. */
export class SyntheticRuntime {
  readonly dataset = generateSeedHistoryDataset({
    athleteId: SYNTHETIC_ATHLETE_ID,
    referenceDate: SYNTHETIC_REFERENCE_DATE,
    seed: DEFAULT_HISTORY_SEED,
  });
  readonly insights = new SyntheticInsightsService({ dataset: this.dataset });
  readonly race = this.dataset.races.find(
    (race) => race.raceId === this.dataset.trainingBlock.goalRaceId,
  )!;
  readonly raceState = new RaceStateStore();
  readonly provenance = {
    source: "synthetic" as const,
    seed: DEFAULT_HISTORY_SEED,
    referenceDate: SYNTHETIC_REFERENCE_DATE,
    label: "Deterministic synthetic demo data; not live athlete data." as const,
  };
  private readonly broker: RealtimeStreamBroker;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly sessionGenerator: typeof createLiveSessionGenerator;
  private readonly raceGenerator: typeof createRaceDayGenerator;
  private starts: number[] = [];
  private runs: SyntheticRun[] = [];
  private active: SyntheticRun | null = null;
  private timer: NodeJS.Timeout | undefined;
  private latestSession: LiveSessionTick["session"] | null = null;
  private metrics: LiveSessionTick["metric"][] = [];
  private progressPct = 0;

  constructor(options: RuntimeOptions = {}) {
    this.broker = options.broker ?? realtimeStreamBroker;
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? INTERVAL_MS;
    this.sessionGenerator = options.sessionGenerator ?? createLiveSessionGenerator;
    this.raceGenerator = options.raceGenerator ?? createRaceDayGenerator;
  }

  status() {
    const now = this.now();
    const recentStarts = this.starts.filter((time) => now - time < WINDOW_MS);
    const latest = this.active ?? this.runs[0] ?? null;
    return {
      runId: latest?.runId ?? null,
      status: latest?.status ?? "idle",
      kind: latest?.kind ?? null,
      progressPct: latest ? this.progressPct : 0,
      retryAfterSeconds:
        recentStarts.length >= MAX_STARTS
          ? Math.max(1, Math.ceil((recentStarts[0]! + WINDOW_MS - now) / 1000))
          : 0,
      summary:
        latest?.status === "completed"
          ? latest.kind === "race"
            ? this.raceState.getSummary(this.race)
            : this.latestSession
              ? {
                  session: this.publicSession(),
                  sampleCount: this.metrics.length,
                  latestMetric: this.metrics.at(-1) ?? null,
                }
              : null
          : null,
      error: latest?.error ?? null,
      activeRun: this.active ? { ...this.active } : null,
      recentRuns: this.runs.map((run) => ({ ...run })),
      maxStartsPerMinute: MAX_STARTS,
      scope: "single-process" as const,
      persistence: "memory" as const,
    };
  }

  context() {
    const athleteId = SYNTHETIC_ATHLETE_ID;
    const raceId = this.race.raceId;
    const loads = new Map<string, number>();
    for (const session of this.dataset.sessions) {
      if (session.status !== "completed" || session.rpe === null) continue;
      const date = session.plannedDate.slice(0, 10);
      loads.set(date, (loads.get(date) ?? 0) + session.plannedDurationMinutes * session.rpe);
    }
    return {
      athleteId,
      raceId,
      defaultAthleteId: athleteId,
      selectedAthleteId: athleteId,
      defaultRaceId: raceId,
      selectedRaceId: raceId,
      assistantPanelAvailable: true,
      directMcpPanelAvailable: false,
      provenance: this.provenance,
      history: [...loads]
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-28)
        .map(([date, trainingLoad]) => ({ date, trainingLoad })),
      runtime: this.status(),
      capabilities: {
        simulation: true,
        cancellation: true,
        assistant: "deterministic-no-llm",
        directMcp: false,
      },
      simulationNote:
        "Synthetic simulation only; state and limits are per process and reset on restart.",
    };
  }

  session() {
    return { session: this.publicSession(), metrics: this.metrics, provenance: this.provenance };
  }

  private publicSession() {
    // The generator's domain model calls generated sessions "live". This is an
    // in-memory demo, so never expose that source as if it were real telemetry.
    return this.latestSession ? { ...this.latestSession, source: "synthetic" as const } : null;
  }

  start(
    kind: "session" | "race",
    discipline: TrainingDiscipline = "run",
  ):
    | { outcome: "started"; run: SyntheticRun }
    | { outcome: "busy"; run: SyntheticRun }
    | { outcome: "rate-limited"; retryAfter: number } {
    if (this.active) return { outcome: "busy", run: { ...this.active } };
    const now = this.now();
    this.starts = this.starts.filter((time) => now - time < WINDOW_MS);
    if (this.starts.length >= MAX_STARTS) {
      return {
        outcome: "rate-limited",
        retryAfter: Math.max(1, Math.ceil((this.starts[0]! + WINDOW_MS - now) / 1000)),
      };
    }
    this.starts.push(now);
    const run: SyntheticRun = {
      runId: randomUUID(),
      kind,
      status: "running",
      startedAt: new Date(now).toISOString(),
      endedAt: null,
      error: null,
    };
    this.active = run;
    this.progressPct = 0;
    this.runs.unshift(run);
    this.runs.length = Math.min(this.runs.length, HISTORY_LIMIT);
    if (kind === "race")
      this.raceState.startRace({ athleteId: SYNTHETIC_ATHLETE_ID, raceId: this.race.raceId });
    else {
      this.latestSession = null;
      this.metrics = [];
    }

    // Generator IDs, time and seed are independent of runId.
    const execute = () => {
      try {
        const iterator =
          kind === "race"
            ? this.raceGenerator({
                raceId: this.race.raceId,
                date: SYNTHETIC_REFERENCE_DATE,
                distance: this.race.distance,
                seed: DEFAULT_HISTORY_SEED,
                splitCount: SAMPLES,
              })
            : this.sessionGenerator({
                athleteId: SYNTHETIC_ATHLETE_ID,
                discipline,
                plannedDate: `${SYNTHETIC_REFERENCE_DATE}T06:00:00.000Z`,
                seed: DEFAULT_HISTORY_SEED,
                sampleCount: SAMPLES,
              });
        const tick = () => {
          if (this.active !== run) return;
          try {
            const result = iterator.next();
            if (result.done) {
              this.finish(run, "completed");
              return;
            }
            if (kind === "race") {
              const value = result.value as RaceDayTick;
              this.progressPct = Math.round(((value.splitIndex + 1) / value.splitCount) * 100);
              this.raceState.recordSplit({
                athleteId: SYNTHETIC_ATHLETE_ID,
                raceId: this.race.raceId,
                split: value.split,
                projectedFinishTimeSeconds: value.projectedFinishTimeSeconds,
              });
              this.broker.publishRaceSplit(SYNTHETIC_ATHLETE_ID, this.race.raceId, value.split);
              if (value.isFinal) {
                this.finish(run, "completed");
                return;
              }
            } else {
              const value = result.value as LiveSessionTick;
              this.progressPct = Math.round(((value.sampleIndex + 1) / value.sampleCount) * 100);
              this.latestSession = value.session;
              this.metrics.push(value.metric);
              this.broker.publishMetric(
                SYNTHETIC_ATHLETE_ID,
                value.session.sessionId,
                value.metric,
              );
              if (value.isFinal) {
                this.latestSession = { ...value.session, status: "completed" };
                this.broker.publishSessionStatus(
                  SYNTHETIC_ATHLETE_ID,
                  value.session.sessionId,
                  "completed",
                );
                this.finish(run, "completed");
                return;
              }
            }
            this.timer = setTimeout(tick, this.intervalMs);
            this.timer.unref?.();
          } catch (error) {
            this.fail(run, error);
          }
        };
        tick();
      } catch (error) {
        this.fail(run, error);
      }
    };
    // Return the accepted run before work begins, including on synchronous failures.
    this.timer = setTimeout(execute, 0);
    this.timer.unref?.();
    return { outcome: "started", run: { ...run } };
  }

  cancel(runId: string): SyntheticRun | null {
    if (!this.active || this.active.runId !== runId) return null;
    const run = this.active;
    this.finish(run, "cancelled");
    return { ...run };
  }

  close(): void {
    if (this.active) this.finish(this.active, "cancelled");
  }

  private fail(run: SyntheticRun, error: unknown): void {
    console.error("[streaming-backend] synthetic simulation failed", { runId: run.runId, error });
    this.finish(run, "failed");
  }

  private finish(run: SyntheticRun, status: "completed" | "cancelled" | "failed"): void {
    if (this.active !== run) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    run.status = status;
    run.endedAt = new Date(this.now()).toISOString();
    run.error = status === "failed" ? "Synthetic simulation failed; see server logs." : null;
    this.active = null;
    if (status !== "completed" && run.kind === "race") this.raceState.resetForTests();
    if (status !== "completed" && this.latestSession && run.kind === "session") {
      this.latestSession = { ...this.latestSession, status: "missed" };
      try {
        this.broker.publishSessionStatus(
          SYNTHETIC_ATHLETE_ID,
          this.latestSession.sessionId,
          "missed",
        );
      } catch (error) {
        console.error("[streaming-backend] synthetic session status broadcast failed", error);
      }
    }
    try {
      this.broker.publish({
        athleteId: SYNTHETIC_ATHLETE_ID,
        frame: { type: "simulationStatus", runId: run.runId, status },
      });
    } catch (error) {
      console.error("[streaming-backend] synthetic status broadcast failed", error);
    }
  }
}
