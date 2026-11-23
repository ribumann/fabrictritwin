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
import { mapMiningCrossRunTrendRows } from "./cross-run-trend-dto.js";
import { D01_CATALOG_VERSION } from "@triathlon-twin/simulator/mining";

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
        env.MINING_INGESTION_RECONCILIATION_ENABLED === "true" &&
          input.run.connectionProfileContract === undefined,
      );
    if (input.kind !== "trend" && input.kind !== "compare") {
      throw new Error("Unsupported public mining read.");
    }
    const runId = input.run.runId;
    if (
      input.kind === "trend" &&
      (input.metric === "sorter-feed" ||
        input.metric === "motor-current" ||
        input.metric === "bearing-temperature" ||
        input.metric === "feed-pressure")
    ) {
      if (!input.asOf || input.maxRows !== 1000)
        throw new MiningQueryError(
          "invalid",
          "Scoped trend requires an evidence cutoff and 1000-row bound.",
        );
      const scoped = {
        start: input.start,
        end: input.end,
        asOf: input.asOf,
        metric: input.metric,
        binMinutes: input.binMinutes,
        runId,
        moduleId: input.moduleId,
      };
      const rows = await query({ ...scoped, kind: "cross-run-trend", maxRows: 1000 }, signal);
      signal.throwIfAborted();
      const data = mapMiningCrossRunTrendRows(scoped, rows, now);
      return {
        plantId: "D01" as const,
        runId,
        catalogVersion: D01_CATALOG_VERSION,
        moduleId: input.moduleId,
        metric: input.metric,
        windowStart: input.start,
        windowEnd: input.end,
        binMinutes: input.binMinutes,
        crossRun: true,
        start: data.start,
        end: data.end,
        asOf: data.asOf,
        profileVersion: data.profileVersion,
        points: data.points,
        rows: data.points.map((point) => ({ ...point, timestamp: point.binStart })),
      };
    }
    if (
      input.metric !== "feed" &&
      input.metric !== "density" &&
      input.metric !== "vibration" &&
      input.metric !== "water-energy"
    )
      throw new MiningQueryError("invalid", "Unsupported mining series metric.");
    if (input.kind === "compare" && input.metric === "water-energy")
      throw new MiningQueryError("invalid", "Unsupported mining comparison metric.");
    if (input.kind === "trend") {
      const legacy = { ...input, runId, metric: input.metric };
      const rows = await query(legacy, signal);
      signal.throwIfAborted();
      return mapTrendRows(legacy, rows);
    }
    const legacy = { ...input, runId, metric: input.metric };
    const rows = await query(legacy, signal);
    signal.throwIfAborted();
    return mapComparisonRows(legacy, rows);
  };
}
