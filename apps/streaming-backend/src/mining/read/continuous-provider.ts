import type { ContinuousMiningRunRecord } from "../run-coordinator.js";
import { createBoundedMiningQuery, MiningQueryError } from "./bounded-query.js";
import { mapContinuousThroughput } from "./continuous-dto.js";
import { mapContinuousSummaryRows } from "./continuous-summary-dto.js";

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
    const summaryRows = query(
      {
        kind: "continuous-summary-windows",
        runId: run.runId,
        end: asOf,
        maxRows: 3,
      },
      signal,
    ).catch((cause: unknown) => {
      if (signal.aborted) throw cause;
      if (
        cause instanceof MiningQueryError &&
        (cause.code === "timeout" || cause.code === "upstream")
      ) {
        return null;
      }
      throw cause;
    });
    const [rows, summaries] = await Promise.all([rowsPromise, summaryRows]);
    signal.throwIfAborted();
    return {
      ...mapContinuousThroughput(run, asOf, rows),
      continuousSummary: mapContinuousSummaryRows(run, asOf, summaries),
    };
  };
}
