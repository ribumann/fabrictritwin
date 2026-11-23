import { toD01ConnectionMeasurementBindingRecords } from "@triathlon-twin/simulator/mining";
import { createBoundedMiningQuery } from "./bounded-query.js";
import { mapConnectionLatest, mapConnectionTrend } from "./connection-flow-dto.js";
import { mapLiveConnectionLatest, mapLiveConnectionTrend } from "./connection-live-dto.js";
import {
  mapConnectionExpectedSet,
  mapConnectionRunRowTotals,
} from "./connection-reconciliation.js";

type Query = ReturnType<typeof createBoundedMiningQuery>;

/** Callers must authorize and revalidate the pinned run around each read. */
export function createMiningConnectionFlowProvider(query: Query) {
  return {
    async liveLatest(asOf: string, signal: AbortSignal) {
      const rows = await query(
        {
          kind: "connection-live-latest",
          asOf,
          maxRows: toD01ConnectionMeasurementBindingRecords().length,
        },
        signal,
      );
      signal.throwIfAborted();
      return mapLiveConnectionLatest(asOf, rows);
    },
    async liveTrend(
      input: { start: string; end: string; streamIds: readonly string[]; windowSeconds: 30 | 60 },
      signal: AbortSignal,
    ) {
      const rows = await query({ ...input, kind: "connection-live-trend", maxRows: 1000 }, signal);
      signal.throwIfAborted();
      return mapLiveConnectionTrend(input, rows);
    },
    async runRowTotals(input: { runId: string; asOf: string }, signal: AbortSignal) {
      const rows = await query({ ...input, kind: "connection-run-row-totals", maxRows: 1 }, signal);
      signal.throwIfAborted();
      return mapConnectionRunRowTotals(input, rows);
    },
    async expectedSet(
      input: { runId: string; asOf: string; expectedEventIds: readonly string[] },
      signal: AbortSignal,
    ) {
      const rows = await query(
        { ...input, kind: "connection-expected-set", maxRows: input.expectedEventIds.length },
        signal,
      );
      signal.throwIfAborted();
      return mapConnectionExpectedSet(input, rows);
    },
    async latest(
      input: { runId: string; runStartedAt: string; asOf: string; streamIds: readonly string[] },
      signal: AbortSignal,
    ) {
      const rows = await query(
        {
          ...input,
          kind: "connection-latest",
          maxRows: toD01ConnectionMeasurementBindingRecords().length,
        },
        signal,
      );
      signal.throwIfAborted();
      return mapConnectionLatest(input, rows);
    },
    async trend(
      input: {
        runId: string;
        runStartedAt: string;
        start: string;
        end: string;
        streamIds: readonly string[];
        windowSeconds: 30 | 60;
      },
      signal: AbortSignal,
    ) {
      const rows = await query({ ...input, kind: "connection-trend", maxRows: 1000 }, signal);
      signal.throwIfAborted();
      return mapConnectionTrend(input, rows);
    },
  };
}
