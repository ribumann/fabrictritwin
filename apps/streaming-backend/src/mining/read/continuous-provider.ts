import type { ContinuousMiningRunRecord } from "../run-coordinator.js";
import { createBoundedMiningQuery, MiningQueryError } from "./bounded-query.js";
import { mapContinuousThroughput } from "./continuous-dto.js";

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
    const rows = await query(
      {
        kind: "continuous-throughput",
        runId: run.runId,
        asOf,
        maxRows: 3,
      },
      signal,
    );
    signal.throwIfAborted();
    return mapContinuousThroughput(run, asOf, rows);
  };
}
