import { assertMiningQueryConfiguration, createBoundedMiningQuery } from "./bounded-query.js";
import {
  readMiningOverview,
  type MiningCuratedProvider,
  type MiningCuratedRequest,
} from "./curated-provider.js";
import { mapComparisonRows, mapTrendRows } from "./series-dto.js";

function demoEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    EVENTHOUSE_QUERY_URI: env.MINING_EVENTHOUSE_QUERY_URI,
    EVENTHOUSE_DATABASE_NAME: env.MINING_EVENTHOUSE_DATABASE_NAME,
  };
}

export function assertMiningDemoQueryConfiguration(env: NodeJS.ProcessEnv): void {
  assertMiningQueryConfiguration(demoEnvironment(env));
}

/** Separate public demo path. It reads the configured validated source, not a proof receipt. */
export function createMiningDemoProvider(
  env: NodeJS.ProcessEnv,
  query: ReturnType<typeof createBoundedMiningQuery> = createBoundedMiningQuery(
    demoEnvironment(env),
  ),
  now: () => number = Date.now,
): MiningCuratedProvider {
  return async (input: MiningCuratedRequest, signal: AbortSignal) => {
    if (input.kind === "context") return null;
    if (input.kind === "incidents") {
      throw new Error("Incident assessments are not connected to the public demo.");
    }
    if (input.kind === "overview")
      return readMiningOverview(
        input,
        query,
        now,
        signal,
        env.MINING_INGESTION_RECONCILIATION_ENABLED === "true",
      );
    if (input.kind !== "trend" && input.kind !== "compare") {
      throw new Error("Unsupported public mining read.");
    }
    const runId = input.run.runId;
    const rows = await query({ ...input, runId }, signal);
    signal.throwIfAborted();
    return input.kind === "trend"
      ? mapTrendRows({ ...input, runId }, rows)
      : mapComparisonRows({ ...input, runId }, rows);
  };
}
