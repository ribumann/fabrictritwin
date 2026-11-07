import {
  createRealtimeInsightsService,
  isRealtimeInsightsConfigured,
  type ActiveAlert,
  type ActiveAlertsService,
} from "./realtime-insights.js";
import {
  realtimeStreamBroker,
  type RealtimeStreamBroker,
} from "./realtime-stream.js";

export interface CreateAlertListenerOptions {
  alertsService?: ActiveAlertsService;
  athleteIds?: readonly string[];
  pollIntervalMs?: number;
  streamBroker?: RealtimeStreamBroker;
}

const DEFAULT_ALERT_POLL_INTERVAL_MS = 30_000;

function getPollIntervalMs(): number {
  const raw = process.env.ALERT_POLL_INTERVAL_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ALERT_POLL_INTERVAL_MS;
}

function resolveConfiguredAthleteIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const rawMap = env.ATHLETE_PRINCIPAL_MAP?.trim();
  if (!rawMap) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawMap) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return [];
    }

    return [...new Set(Object.values(parsed).filter((value): value is string => typeof value === "string" && value.length > 0))];
  } catch {
    return [];
  }
}

export class PollingAlertListener {
  private readonly seenAlertsByAthlete = new Map<string, Map<string, string>>();
  private timer: NodeJS.Timeout | undefined;
  private activePoll: Promise<void> | undefined;

  constructor(
    private readonly alertsService: ActiveAlertsService,
    private readonly athleteIds: readonly string[],
    private readonly streamBroker: RealtimeStreamBroker,
    private readonly pollIntervalMs: number,
  ) {}

  start(): boolean {
    if (this.timer || this.athleteIds.length === 0) {
      return this.athleteIds.length > 0;
    }

    void this.pollNow();
    this.timer = setInterval(() => {
      void this.pollNow();
    }, this.pollIntervalMs);
    this.timer.unref?.();
    return true;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async pollNow(): Promise<void> {
    if (this.activePoll) {
      await this.activePoll;
      return;
    }

    this.activePoll = this.pollAthletes().finally(() => {
      this.activePoll = undefined;
    });
    await this.activePoll;
  }

  private async pollAthletes(): Promise<void> {
    for (const athleteId of this.athleteIds) {
      try {
        const { alerts } = await this.alertsService.getActiveAlerts(athleteId);
        this.publishNewAlerts(athleteId, alerts);
      } catch (error) {
        console.error("[streaming-backend] alert poll failed", { athleteId, error });
      }
    }
  }

  private publishNewAlerts(athleteId: string, alerts: readonly ActiveAlert[]): void {
    const previousAlerts = this.seenAlertsByAthlete.get(athleteId) ?? new Map<string, string>();
    const nextAlerts = new Map<string, string>();

    for (const alert of alerts) {
      nextAlerts.set(alert.alertId, alert.raisedAt);
      if (previousAlerts.get(alert.alertId) === alert.raisedAt) {
        continue;
      }

      this.streamBroker.publishAlert(athleteId, alert);
    }

    this.seenAlertsByAthlete.set(athleteId, nextAlerts);
  }
}

export function createDefaultAlertListener(
  options: CreateAlertListenerOptions = {},
): PollingAlertListener | undefined {
  const athleteIds = [...(options.athleteIds ?? resolveConfiguredAthleteIds())];
  if (!options.alertsService && (!isRealtimeInsightsConfigured() || athleteIds.length === 0)) {
    return undefined;
  }

  return new PollingAlertListener(
    options.alertsService ?? createRealtimeInsightsService(),
    athleteIds,
    options.streamBroker ?? realtimeStreamBroker,
    options.pollIntervalMs ?? getPollIntervalMs(),
  );
}

