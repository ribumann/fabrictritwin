import {
  createDefaultDailyGenerationStore,
  type Race,
  type RaceDistance,
  type RaceSplit,
} from "@triathlon-twin/simulator";

const TOTAL_DISTANCE_METERS: Record<RaceDistance, number> = {
  olympic: 51_930,
  "70.3": 113_537,
  full: 226_605,
};

interface RaceReadStore {
  readLakehousePayload(
    athleteId: string,
    environment: string,
  ): Promise<{ races: Race[] } | null>;
}

export interface RaceCatalog {
  findRaceForAthlete(athleteId: string, raceId: string): Promise<Race | null>;
}

export interface LiveRaceViewResponse {
  raceId: string;
  athleteId: string;
  name: string;
  distance: RaceDistance;
  status: Race["status"];
  goalTimeSeconds: number;
  latestSplit: RaceSplit | null;
  projectedFinishTimeSeconds: number | null;
  progressPct: number | null;
  lastUpdatedAt: string | null;
}

export interface RaceSummaryResponse {
  raceId: string;
  athleteId: string;
  name: string;
  distance: RaceDistance;
  status: Race["status"];
  goalTimeSeconds: number;
  predictedFinishTimeSeconds: number | null;
  actualFinishTimeSeconds: number | null;
  pacingEvennessStdDev: number | null;
  completedAt: string | null;
}

export interface CreateRaceCatalogOptions {
  environment?: string;
  store?: RaceReadStore;
}

interface RaceRuntimeState {
  athleteId: string;
  raceId: string;
  splits: RaceSplit[];
  status: "live" | "completed";
  predictedFinishTimeSeconds: number | null;
  latestProjectedFinishTimeSeconds: number | null;
  lastUpdatedAt: string | null;
  completedAt: string | null;
}

function resolveEnvironment(environment?: string): string {
  return environment ?? process.env.SIMULATOR_ENVIRONMENT ?? "dev";
}

function computeProgressPct(distance: RaceDistance, coveredMeters: number): number {
  return Math.min(
    100,
    Math.max(0, (coveredMeters / TOTAL_DISTANCE_METERS[distance]) * 100),
  );
}

function computePacingEvennessStdDev(splits: readonly RaceSplit[]): number | null {
  if (splits.length === 0) {
    return null;
  }

  const deltas = splits.map(
    (split) => split.currentPaceSecPerKm - split.plannedPaceSecPerKm,
  );
  const mean = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  const variance =
    deltas.reduce((sum, value) => sum + (value - mean) ** 2, 0) / deltas.length;
  return Math.round(Math.sqrt(variance) * 100) / 100;
}

class OneLakeRaceCatalog implements RaceCatalog {
  private readonly environment: string;

  constructor(
    environment: string,
    private readonly store: RaceReadStore,
  ) {
    this.environment = environment;
  }

  async findRaceForAthlete(athleteId: string, raceId: string): Promise<Race | null> {
    const payload = await this.store.readLakehousePayload(athleteId, this.environment);
    return payload?.races.find((race) => race.raceId === raceId) ?? null;
  }
}

export class RaceStateStore {
  private readonly runtimeStateByRaceId = new Map<string, RaceRuntimeState>();

  startRace(args: { athleteId: string; raceId: string }): void {
    this.runtimeStateByRaceId.set(args.raceId, {
      athleteId: args.athleteId,
      raceId: args.raceId,
      splits: [],
      status: "live",
      predictedFinishTimeSeconds: null,
      latestProjectedFinishTimeSeconds: null,
      lastUpdatedAt: null,
      completedAt: null,
    });
  }

  recordSplit(args: {
    athleteId: string;
    raceId: string;
    split: RaceSplit;
    projectedFinishTimeSeconds: number;
  }): void {
    const current =
      this.runtimeStateByRaceId.get(args.raceId) ??
      ({
        athleteId: args.athleteId,
        raceId: args.raceId,
        splits: [],
        status: "live",
        predictedFinishTimeSeconds: null,
        latestProjectedFinishTimeSeconds: null,
        lastUpdatedAt: null,
        completedAt: null,
      } satisfies RaceRuntimeState);

    current.athleteId = args.athleteId;
    current.splits = [...current.splits, args.split];
    current.predictedFinishTimeSeconds ??= args.projectedFinishTimeSeconds;
    current.latestProjectedFinishTimeSeconds = args.projectedFinishTimeSeconds;
    current.lastUpdatedAt = args.split.timestamp;
    if (args.split.isFinish) {
      current.status = "completed";
      current.completedAt = args.split.timestamp;
    }

    this.runtimeStateByRaceId.set(args.raceId, current);
  }

  getLiveView(race: Race): LiveRaceViewResponse {
    const runtime = this.runtimeStateByRaceId.get(race.raceId);
    const latestSplit = runtime?.splits.at(-1) ?? null;

    return {
      raceId: race.raceId,
      athleteId: race.athleteId,
      name: race.name,
      distance: race.distance,
      status: runtime?.status ?? race.status,
      goalTimeSeconds: race.goalTimeSeconds,
      latestSplit,
      projectedFinishTimeSeconds:
        runtime?.latestProjectedFinishTimeSeconds ?? race.predictedFinishTimeSeconds,
      progressPct: latestSplit
        ? computeProgressPct(race.distance, latestSplit.distanceCoveredMeters)
        : race.status === "completed"
          ? 100
          : null,
      lastUpdatedAt: runtime?.lastUpdatedAt ?? null,
    };
  }

  getSummary(race: Race): RaceSummaryResponse | null {
    const runtime = this.runtimeStateByRaceId.get(race.raceId);

    if (runtime?.status === "completed") {
      return {
        raceId: race.raceId,
        athleteId: race.athleteId,
        name: race.name,
        distance: race.distance,
        status: "completed",
        goalTimeSeconds: race.goalTimeSeconds,
        predictedFinishTimeSeconds: runtime.predictedFinishTimeSeconds,
        actualFinishTimeSeconds: runtime.latestProjectedFinishTimeSeconds,
        pacingEvennessStdDev: computePacingEvennessStdDev(runtime.splits),
        completedAt: runtime.completedAt,
      };
    }

    if (race.status === "completed") {
      return {
        raceId: race.raceId,
        athleteId: race.athleteId,
        name: race.name,
        distance: race.distance,
        status: "completed",
        goalTimeSeconds: race.goalTimeSeconds,
        predictedFinishTimeSeconds: race.predictedFinishTimeSeconds,
        actualFinishTimeSeconds: race.actualFinishTimeSeconds,
        pacingEvennessStdDev: race.pacingEvennessStdDev,
        completedAt: null,
      };
    }

    return null;
  }

  resetForTests(): void {
    this.runtimeStateByRaceId.clear();
  }
}

export function createRaceCatalog(
  options: CreateRaceCatalogOptions = {},
): RaceCatalog {
  return new OneLakeRaceCatalog(
    resolveEnvironment(options.environment),
    options.store ?? createDefaultDailyGenerationStore(),
  );
}

export const raceStateStore = new RaceStateStore();
