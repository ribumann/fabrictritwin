import { assertMiningQueryConfiguration, createBoundedMiningQuery } from "./bounded-query.js";
import {
  readMiningOverview,
  type MiningCuratedProvider,
  type MiningCuratedRequest,
} from "./curated-provider.js";
import { mapComparisonRows, mapTrendRows } from "./series-dto.js";
import { configuredMiningStore } from "../blob-store.js";
import { MiningQueryError } from "./bounded-query.js";
import {
  assertFabricIncidentSourceReady,
  assertReconciledIncidentObservations,
  createFabricIncidentSource,
} from "../../mining-incidents/fabric-source.js";
import { demoIncidentPath } from "../../mining-incidents/demo-runtime.js";
import { createD01VersionedIncidentRun } from "../../mining-incidents/catalog.js";
import {
  readMiningIncidentJournal,
  type MiningIncidentStore,
} from "../../mining-incidents/runtime.js";
import { mapCurrentIncidentJournal } from "./incident-dto.js";
import { mapMiningIngestion } from "./ingestion-dto.js";
import { assertBoundedMiningRun } from "../run-coordinator.js";

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
  store: Pick<MiningIncidentStore, "read"> | undefined = configuredMiningStore(env),
): MiningCuratedProvider {
  return async (input: MiningCuratedRequest, signal: AbortSignal) => {
    assertBoundedMiningRun(input.run);
    if (input.kind === "context") return null;
    if (input.kind === "incidents") {
      if (
        env.MINING_INGESTION_RECONCILIATION_ENABLED !== "true" ||
        !store ||
        !input.run.contract ||
        input.run.phase !== "publisher_complete"
      ) {
        throw new MiningQueryError(
          "upstream",
          "Incident reconciliation is awaiting a completed demo run.",
        );
      }
      const capturedAt = new Date(now()).toISOString();
      const [readiness, ingestion] = await Promise.all([
        query({ kind: "source-readiness", runId: input.run.runId, maxRows: 1 }, signal),
        query({ kind: "ingestion", runId: input.run.runId, asOf: capturedAt, maxRows: 5 }, signal),
      ]);
      assertFabricIncidentSourceReady(readiness);
      if (mapMiningIngestion(input.run, capturedAt, ingestion).status !== "complete") {
        throw new MiningQueryError(
          "upstream",
          "Incident reconciliation is awaiting complete validated ingestion.",
        );
      }
      const definition = createD01VersionedIncidentRun({
        ...input.run,
        contract: input.run.contract,
      });
      const journal = await readMiningIncidentJournal(
        { read: (path, currentSignal) => store.read(demoIncidentPath(path), currentSignal) },
        definition,
        { signal, includeObservations: true },
      );
      if (!journal || journal.asOf !== input.run.stopAt || !journal.sourceObservedAt) {
        throw new MiningQueryError(
          "upstream",
          "The durable incident reconciliation is not complete.",
        );
      }
      assertReconciledIncidentObservations(input.run, journal.observations ?? []);
      if (
        Date.parse(journal.asOf) > Date.parse(input.asOf) ||
        Date.parse(journal.sourceObservedAt) > now()
      ) {
        throw new MiningQueryError(
          "malformed",
          "Incident evidence is beyond the requested or current time.",
        );
      }
      const source = await createFabricIncidentSource(definition, query, now).read({
        runId: input.run.runId,
        asOf: input.run.stopAt,
        committed: [],
        signal,
      });
      assertReconciledIncidentObservations(input.run, source.observations, journal.observations);
      const confirmation = await query(
        {
          kind: "ingestion",
          runId: input.run.runId,
          asOf: new Date(now()).toISOString(),
          maxRows: 5,
        },
        signal,
      );
      if (
        mapMiningIngestion(input.run, new Date(now()).toISOString(), confirmation).status !==
        "complete"
      ) {
        throw new MiningQueryError(
          "upstream",
          "Incident ingestion reconciliation changed during the read.",
        );
      }
      signal.throwIfAborted();
      const mapped = mapCurrentIncidentJournal({ run: input.run, journal });
      return {
        ...mapped,
        assessmentKind: "reconciled-event-time" as const,
        sourceObservedAt: journal.sourceObservedAt,
        refreshedAt: new Date(now()).toISOString(),
        totalIncidents: mapped.incidents.length,
        incidents: mapped.incidents.slice(0, 20),
      };
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
