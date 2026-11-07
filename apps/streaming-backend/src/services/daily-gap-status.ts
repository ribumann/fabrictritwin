import {
  createDefaultDailyGenerationStore,
  type DailyGenerationGapRecord,
} from "@triathlon-twin/simulator";

export interface DataGapStatusResponse {
  athleteId: string;
  lastGeneratedDate: string | null;
  lastRunAt: string | null;
  gapDetected: boolean;
  activeGaps: DailyGenerationGapRecord[];
}

interface DailyGapReadStore {
  readDailyGenerationState(
    athleteId: string,
    environment: string,
  ): Promise<{
    lastGeneratedDate: string;
    lastRunAt: string;
    activeGaps: DailyGenerationGapRecord[];
  } | null>;
}

export interface DataGapStatusService {
  getStatus(athleteId: string): Promise<DataGapStatusResponse>;
}

export interface CreateDataGapStatusServiceOptions {
  environment?: string;
  store?: DailyGapReadStore;
}

function resolveEnvironment(environment?: string): string {
  return environment ?? process.env.SIMULATOR_ENVIRONMENT ?? "dev";
}

class OneLakeDataGapStatusService implements DataGapStatusService {
  private readonly environment: string;

  constructor(
    environment: string,
    private readonly store: DailyGapReadStore,
  ) {
    this.environment = environment;
  }

  async getStatus(athleteId: string): Promise<DataGapStatusResponse> {
    const state = await this.store.readDailyGenerationState(
      athleteId,
      this.environment,
    );

    return {
      athleteId,
      lastGeneratedDate: state?.lastGeneratedDate ?? null,
      lastRunAt: state?.lastRunAt ?? null,
      gapDetected: (state?.activeGaps.length ?? 0) > 0,
      activeGaps: state?.activeGaps ?? [],
    };
  }
}

export function createDataGapStatusService(
  options: CreateDataGapStatusServiceOptions = {},
): DataGapStatusService {
  return new OneLakeDataGapStatusService(
    resolveEnvironment(options.environment),
    options.store ?? createDefaultDailyGenerationStore(),
  );
}
