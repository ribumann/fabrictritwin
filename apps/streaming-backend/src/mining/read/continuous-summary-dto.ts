import { D01_CATALOG_VERSION } from "@triathlon-twin/simulator/mining";
import type { ContinuousMiningRunRecord } from "../run-coordinator.js";
import { MiningQueryError } from "./bounded-query.js";
import { mapSummaryRows } from "./summary-dto.js";

const sourceContractVersion = "d01-validated-source-v1";
const definitions = [
  { window: "30m", durationMs: 30 * 60_000 },
  { window: "2h", durationMs: 2 * 60 * 60_000 },
  { window: "24h", durationMs: 24 * 60 * 60_000 },
] as const;
type WindowId = (typeof definitions)[number]["window"];

function malformed(): never {
  throw new MiningQueryError("malformed", "Invalid continuous Mining summary evidence.");
}

function unavailableMetric(unit: "m\u00b3/t" | "kWh/t", windowStart: string, windowEnd: string) {
  return {
    value: null,
    unit,
    coverage: null,
    quality: "unavailable" as const,
    windowStart,
    windowEnd,
  };
}

function unavailableWindow(
  window: WindowId,
  end: string,
  durationMs: number,
  status: "QUERY_UNAVAILABLE" | "SOURCE_REJECTED",
) {
  const start = new Date(Date.parse(end) - durationMs).toISOString();
  return {
    window,
    windowStart: start,
    windowEnd: end,
    status,
    grossProcessWaterIntensity: unavailableMetric("m\u00b3/t", start, end),
    energyIntensity: unavailableMetric("kWh/t", start, end),
  };
}

function rejectedBatch(run: ContinuousMiningRunRecord, asOf: string) {
  return {
    plantId: "D01" as const,
    runId: run.runId,
    generation: run.lifetime.generation,
    catalogVersion: D01_CATALOG_VERSION,
    sourceContractVersion,
    asOf,
    windows: definitions.map(({ window, durationMs }) =>
      unavailableWindow(window, asOf, durationMs, "SOURCE_REJECTED"),
    ),
  };
}

function mapWindow(
  runId: string,
  end: string,
  window: WindowId,
  durationMs: number,
  row: Record<string, unknown> | null,
) {
  const endTime = Date.parse(end);
  const start = new Date(endTime - durationMs).toISOString();
  if (!row) return unavailableWindow(window, end, durationMs, "QUERY_UNAVAILABLE");
  const { window_id: _windowId, ...summaryRow } = row;
  try {
    const summary = mapSummaryRows({ runId, start, end }, [summaryRow]);
    return {
      window,
      windowStart: start,
      windowEnd: end,
      status: String(row.status),
      grossProcessWaterIntensity: summary.grossProcessWaterIntensity,
      energyIntensity: summary.energyIntensity,
    };
  } catch (cause) {
    if (
      cause instanceof MiningQueryError &&
      (cause.code === "upstream" || cause.code === "malformed")
    )
      return unavailableWindow(window, end, durationMs, "SOURCE_REJECTED");
    throw cause;
  }
}

/** Maps three fixed, exact-run PlantSummary windows without joining publisher runs. */
export function mapContinuousSummaryRows(
  run: ContinuousMiningRunRecord,
  asOf: string,
  rows: Record<string, unknown>[] | null,
) {
  const end = Date.parse(asOf);
  if (!Number.isFinite(end) || new Date(end).toISOString() !== asOf) return malformed();
  if (rows !== null && (!Array.isArray(rows) || rows.length !== definitions.length)) {
    return rejectedBatch(run, asOf);
  }
  const byWindow = new Map<WindowId, Record<string, unknown>>();
  for (const row of rows ?? []) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return rejectedBatch(run, asOf);
    const window = row.window_id;
    if (
      typeof window !== "string" ||
      !definitions.some((definition) => definition.window === window) ||
      byWindow.has(window as WindowId)
    ) {
      return rejectedBatch(run, asOf);
    }
    byWindow.set(window as WindowId, row);
  }
  if (rows !== null && byWindow.size !== definitions.length) return rejectedBatch(run, asOf);
  return {
    plantId: "D01" as const,
    runId: run.runId,
    generation: run.lifetime.generation,
    catalogVersion: D01_CATALOG_VERSION,
    sourceContractVersion,
    asOf,
    windows: definitions.map(({ window, durationMs }) =>
      mapWindow(run.runId, asOf, window, durationMs, byWindow.get(window) ?? null),
    ),
  };
}
