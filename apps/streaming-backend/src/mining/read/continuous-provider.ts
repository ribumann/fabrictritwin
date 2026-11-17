import type { ContinuousMiningRunRecord } from "../run-coordinator.js";
import { createBoundedMiningQuery, MiningQueryError } from "./bounded-query.js";
import { mapContinuousThroughput } from "./continuous-dto.js";
import { mapContinuousSummaryRows } from "./continuous-summary-dto.js";

type SummaryRead =
  | { rows: Record<string, unknown>[]; failure: null }
  | { rows: null; failure: "QUERY_UNAVAILABLE" | "SOURCE_REJECTED" };

export function createMiningContinuousProvider(
  env: NodeJS.ProcessEnv,
  query: ReturnType<typeof createBoundedMiningQuery> = createBoundedMiningQuery({
    ...env,
    EVENTHOUSE_QUERY_URI: env.MINING_EVENTHOUSE_QUERY_URI,
    EVENTHOUSE_DATABASE_NAME: env.MINING_EVENTHOUSE_DATABASE_NAME,
  }),
) {
  return async (run: ContinuousMiningRunRecord, asOf: string, signal: AbortSignal) => {
    if (env.MINING_CONTINUOUS_READ_ENABLED !== "true") {
      throw new MiningQueryError("configuration", "Continuous Mining reads are disabled.");
    }
    const rowsPromise = query(
      {
        kind: "continuous-throughput",
        runId: run.runId,
        asOf,
        maxRows: 59,
      },
      signal,
    );
    const summaryRows: Promise<SummaryRead> = query(
      {
        kind: "continuous-summary-windows",
        runId: run.runId,
        end: asOf,
        maxRows: 3,
      },
      signal,
    ).then<SummaryRead, SummaryRead>(
      (rows) => ({ rows, failure: null }),
      (cause: unknown): SummaryRead => {
        if (signal.aborted) throw cause;
        if (cause instanceof MiningQueryError) {
          if (cause.code === "timeout" || cause.code === "upstream") {
            return { rows: null, failure: "QUERY_UNAVAILABLE" };
          }
          if (cause.code === "malformed" || cause.code === "overflow") {
            return { rows: null, failure: "SOURCE_REJECTED" };
          }
        }
        throw cause;
      },
    );
    const [rows, summary] = await Promise.all([rowsPromise, summaryRows]);
    signal.throwIfAborted();
    return {
      ...mapContinuousThroughput(run, asOf, rows),
      continuousSummary: mapContinuousSummaryRows(
        run,
        asOf,
        summary.rows,
        summary.rows === null ? summary.failure : undefined,
      ),
    };
  };
}
