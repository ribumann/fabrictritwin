import { createBoundedMiningQuery, MiningQueryError } from "./bounded-query.js";
import { mapMiningCrossRunTrendRows } from "./cross-run-trend-dto.js";
import type { MiningCrossRunTrendRequest } from "./cross-run-trend-query.js";

export function createMiningCrossRunTrendProvider(
  env: NodeJS.ProcessEnv,
  query: ReturnType<typeof createBoundedMiningQuery> = createBoundedMiningQuery({
    ...env,
    EVENTHOUSE_QUERY_URI: env.MINING_EVENTHOUSE_QUERY_URI,
    EVENTHOUSE_DATABASE_NAME: env.MINING_EVENTHOUSE_DATABASE_NAME,
  }),
) {
  return async (input: MiningCrossRunTrendRequest, signal: AbortSignal) => {
    if (env.MINING_CONTINUOUS_READ_ENABLED !== "true") {
      throw new MiningQueryError("configuration", "Continuous Mining reads are disabled.");
    }
    const rows = await query({ ...input, kind: "cross-run-trend", maxRows: 1000 }, signal);
    signal.throwIfAborted();
    return mapMiningCrossRunTrendRows(input, rows);
  };
}
