import { createHash } from "node:crypto";
import {
  DEFAULT_HISTORY_SEED,
  generateSeedHistoryDataset,
  type SeedHistoryDataset,
  type TrainingSession,
} from "@triathlon-twin/simulator";
import type {
  ActiveAlert,
  ActiveAlertsResponse,
  AthleteAnalysesResponse,
  RealtimeInsightsService,
} from "./realtime-insights.js";

export const SYNTHETIC_ATHLETE_ID = "11111111-1111-4111-8111-111111111111";
export const SYNTHETIC_REFERENCE_DATE = "2026-09-07";

export interface SyntheticProvenance {
  source: "synthetic";
  seed: number;
  referenceDate: string;
  label: "Deterministic synthetic demo data; not live athlete data.";
}

export interface SyntheticInsightsOptions {
  seed?: number;
  referenceDate?: string;
}

const DAY_MS = 86_400_000;
const round = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));
const mean = (values: readonly number[]): number | null =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

function dailyLoads(dataset: SeedHistoryDataset): Map<string, number> {
  const loads = new Map<string, number>();
  for (const session of dataset.sessions) {
    if (session.status !== "completed" || session.rpe === null) {
      continue;
    }
    const date = session.plannedDate.slice(0, 10);
    loads.set(date, (loads.get(date) ?? 0) + session.plannedDurationMinutes * session.rpe);
  }
  return loads;
}

function trailingMean(loads: Map<string, number>, asOf: string, days: number): number | null {
  const end = Date.parse(asOf);
  return mean(
    [...loads]
      .filter(([date]) => Date.parse(date) > end - days * DAY_MS && date <= asOf)
      .map(([, load]) => load),
  );
}

function carbRate(session: TrainingSession): number {
  if (session.rpe !== null) {
    return session.rpe >= 8 ? 90 : session.rpe >= 6 ? 60 : session.rpe >= 4 ? 45 : 30;
  }
  if (/\b(Threshold|VO2|Zone5)\b/i.test(session.targetZone)) {
    return 90;
  }
  return /\b(Tempo|Zone4)\b/i.test(session.targetZone) ? 60 : 45;
}

/**
 * In-memory implementations of the history-backed Eventhouse analyses.
 * This snapshot has no live telemetry, so it cannot emit high-HR or race-drift alerts.
 */
export class SyntheticInsightsService implements RealtimeInsightsService {
  private readonly dataset: SeedHistoryDataset;
  private readonly provenance: SyntheticProvenance;

  constructor(options: SyntheticInsightsOptions = {}) {
    const seed = options.seed ?? DEFAULT_HISTORY_SEED;
    const referenceDate = options.referenceDate ?? SYNTHETIC_REFERENCE_DATE;
    this.dataset = generateSeedHistoryDataset({
      athleteId: SYNTHETIC_ATHLETE_ID,
      referenceDate,
      seed,
    });
    this.provenance = {
      source: "synthetic",
      seed,
      referenceDate,
      label: "Deterministic synthetic demo data; not live athlete data.",
    };
  }

  private requireAthlete(athleteId: string): void {
    if (athleteId !== this.dataset.athlete.athleteId) {
      throw new Error("Athlete is not present in the synthetic dataset.");
    }
  }

  async getAnalyses(athleteId: string): Promise<AthleteAnalysesResponse> {
    this.requireAthlete(athleteId);
    const loads = dailyLoads(this.dataset);
    const loadDate = [...loads.keys()].sort().at(-1);
    const acute = loadDate ? trailingMean(loads, loadDate, 7) : null;
    const chronic = loadDate ? trailingMean(loads, loadDate, 28) : null;
    const recovery = this.dataset.recoveryMetrics;
    const latest = [...recovery].sort((a, b) => b.date.localeCompare(a.date))[0];
    const hrvMean = mean(recovery.map((row) => row.hrv));
    const rhrMean = mean(recovery.map((row) => row.restingHeartRate));
    const hrvStdev =
      hrvMean !== null && recovery.length > 1
        ? Math.sqrt(
            recovery.reduce((sum, row) => sum + (row.hrv - hrvMean) ** 2, 0) /
              (recovery.length - 1),
          )
        : 0;
    let recoveryScore: number | null = null;
    if (latest && hrvMean !== null && rhrMean !== null) {
      const z = hrvStdev > 0 ? (latest.hrv - hrvMean) / hrvStdev : 0;
      recoveryScore = round(
        ((0.35 * (clamp(z, -3, 3) + 3)) / 6) * 100 +
          0.25 * latest.sleepScore +
          ((0.2 * (10 - latest.sorenessScore)) / 10) * 100 +
          ((0.2 * (clamp(rhrMean - latest.restingHeartRate, -10, 10) + 10)) / 20) * 100,
        1,
      );
    }
    const sleepDate = this.dataset.sleepSessions
      .map((row) => row.date)
      .sort()
      .at(-1);
    const sleepMean = sleepDate
      ? mean(
          this.dataset.sleepSessions
            .filter(
              (row) =>
                row.date <= sleepDate && Date.parse(row.date) > Date.parse(sleepDate) - 7 * DAY_MS,
            )
            .map((row) => row.totalSleepMinutes),
        )
      : null;
    const phaseMean = (name: "Peak" | "Taper"): number | null => {
      const phase = this.dataset.phases.find((row) => row.phase === name);
      const value = phase
        ? mean(
            [...loads]
              .filter(([date]) => date >= phase.startDate && date <= phase.endDate)
              .map(([, load]) => load),
          )
        : null;
      return value === null ? null : round(value, 1);
    };
    const peak = phaseMean("Peak");
    const taper = phaseMean("Taper");
    const fueling = this.fuelingCandidates().sort((a, b) =>
      b.session.plannedDate.localeCompare(a.session.plannedDate),
    )[0];
    const asOf = [loadDate, latest?.date, sleepDate, fueling?.session.plannedDate]
      .filter((date): date is string => Boolean(date))
      .map((date) => Date.parse(date));
    return {
      acuteChronicWorkloadRatio:
        acute !== null && chronic !== null && chronic > 0 ? round(acute / chronic, 2) : null,
      recoveryScore,
      nutritionAdequacy: fueling?.ratio ?? null,
      sleepDebtMinutes: sleepMean !== null ? round(480 - round(sleepMean, 1), 1) : null,
      taperIndex: peak !== null && peak > 0 && taper !== null ? round(taper / peak, 2) : null,
      asOf: asOf.length ? new Date(Math.max(...asOf)).toISOString() : null,
      provenance: { ...this.provenance },
    };
  }

  private fuelingCandidates() {
    return this.dataset.sessions
      .filter((session) => session.status === "live")
      .map((session) => {
        const start = Date.parse(session.plannedDate);
        const demand = (carbRate(session) * session.plannedDurationMinutes) / 60;
        const carbs = this.dataset.nutritionLogs
          .filter(
            (row) =>
              Date.parse(row.date) >= start - 3 * 3_600_000 &&
              Date.parse(row.date) <= start + session.plannedDurationMinutes * 60_000,
          )
          .reduce((sum, row) => sum + row.carbsGrams, 0);
        return { session, demand, carbs, ratio: demand > 0 ? round(carbs / demand, 2) : null };
      });
  }

  async getActiveAlerts(athleteId: string): Promise<ActiveAlertsResponse> {
    this.requireAthlete(athleteId);
    const alerts: ActiveAlert[] = [];
    const addAlert = (
      type: ActiveAlert["type"],
      raisedAt: string,
      identity: string,
      detail: string,
      context: ActiveAlert["context"],
    ): void => {
      const digest = createHash("sha256")
        .update(`synthetic|${athleteId}|${type}|${identity}|${raisedAt}`)
        .digest("hex");
      alerts.push({
        alertId: `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`,
        type,
        raisedAt,
        detail,
        context: { ...context, source: "synthetic" },
      });
    };
    const analyses = await this.getAnalyses(athleteId);
    const acwr = analyses.acuteChronicWorkloadRatio;
    const loads = dailyLoads(this.dataset);
    const loadDate = [...loads.keys()].sort().at(-1);
    if (acwr !== null && (acwr < 0.8 || acwr > 1.5) && loadDate) {
      addAlert(
        "acwr",
        new Date(loadDate).toISOString(),
        loadDate,
        `Synthetic Acute:Chronic Workload Ratio is ${acwr}, outside the safe 0.8-1.5 range.`,
        {
          acwr,
          avgLoad7d: trailingMean(loads, loadDate, 7),
          avgLoad28d: trailingMean(loads, loadDate, 28),
        },
      );
    }
    const now = Date.parse(this.dataset.referenceDate);
    for (const session of this.dataset.sessions) {
      const overdueHours = round((now - Date.parse(session.plannedDate)) / 3_600_000, 1);
      if ((session.status === "planned" || session.status === "missed") && overdueHours >= 48) {
        addAlert(
          "missed-session",
          session.plannedDate,
          session.sessionId,
          `Synthetic ${session.discipline} session has not been completed ${overdueHours} hours after its planned time.`,
          {
            sessionId: session.sessionId,
            plannedDate: session.plannedDate,
            overdueHours,
            discipline: session.discipline,
            status: session.status,
          },
        );
      }
    }
    for (const { session, ratio, carbs, demand } of this.fuelingCandidates()) {
      if (ratio !== null && ratio < 0.5) {
        addAlert(
          "fueling-shortfall",
          session.plannedDate,
          session.sessionId,
          `Synthetic ${session.discipline} session fueling is only ${ratio} of estimated carbohydrate demand.`,
          {
            sessionId: session.sessionId,
            discipline: session.discipline,
            adequacyRatio: ratio,
            recentCarbsGrams: carbs,
            estimatedCarbDemandGrams: demand,
          },
        );
      }
    }
    return {
      alerts: alerts.sort(
        (a, b) => b.raisedAt.localeCompare(a.raisedAt) || a.alertId.localeCompare(b.alertId),
      ),
      provenance: { ...this.provenance },
    };
  }
}
