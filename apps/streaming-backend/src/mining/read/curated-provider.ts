import {
  D01_CATALOG_VERSION,
  D01_PLANT_CATALOG,
  D01_PUBLISH_PROFILE_VERSION,
} from "@triathlon-twin/simulator/mining";
import {
  createD01IncidentRun,
  createD01VersionedIncidentRun,
} from "../../mining-incidents/catalog.js";
import {
  readMiningIncidentJournal,
  type MiningIncidentStore,
} from "../../mining-incidents/runtime.js";
import type { MiningRunRecord } from "../run-coordinator.js";
import type { MiningByteStore } from "../store.js";
import {
  assertMiningQueryConfiguration,
  createBoundedMiningQuery,
  MiningQueryError,
} from "./bounded-query.js";
import { mapCurrentIncidentJournal } from "./incident-dto.js";
import { mapLatestRows } from "./latest-dto.js";
import { MiningReceiptError, readPinnedMiningReceipt } from "./pinned-receipt.js";
import {
  assertReceiptMatchesExpectations,
  type MiningReceiptExpectations,
} from "./receipt-expectations.js";
import { assertReceiptObservationConsistency } from "./receipt-observations.js";
import { parseMiningProofReceipt, type MiningProofReceipt } from "./receipt-schema.js";
import { mapComparisonRows, mapTrendRows } from "./series-dto.js";
import { mapSummaryRows } from "./summary-dto.js";

type Metric = "feed" | "density" | "vibration" | "water-energy";
interface Window {
  start: string;
  end: string;
  metric: Metric;
  binMinutes: 1 | 5;
  maxRows: number;
}
export type MiningCuratedRequest = { run: MiningRunRecord } & (
  | { kind: "context" }
  | { kind: "overview" | "incidents"; asOf: string }
  | ({ kind: "trend"; moduleId: string } & Window)
  | ({ kind: "compare" } & Window)
);

interface Dependencies {
  store: MiningByteStore & Pick<MiningIncidentStore, "read">;
  receiptPin: string;
  /** Protected operator-approved values, never derived from the downloaded receipt. */
  expectations: MiningReceiptExpectations;
  /** Must independently read back the exact native deployment/source; no flag or cached receipt. */
  verifyNative(receipt: MiningProofReceipt, signal: AbortSignal): Promise<void>;
  env?: NodeJS.ProcessEnv;
  query?: ReturnType<typeof createBoundedMiningQuery>;
  now?: () => number;
}

/**
 * Explicit host composition only. No production verifier is supplied or activated here.
 * The HTTP caller must first authorize the viewer/run and read its durable admission.
 */
export function createMiningCuratedProvider(dependencies: Dependencies) {
  const { store, receiptPin, verifyNative } = dependencies;
  const expected = structuredClone(dependencies.expectations);
  const env = { ...(dependencies.env ?? process.env) };
  const query = dependencies.query ?? createBoundedMiningQuery(env);
  const now = dependencies.now ?? Date.now;
  return async (input: MiningCuratedRequest, signal: AbortSignal) => {
    signal.throwIfAborted();
    assertMiningQueryConfiguration(env);
    const runId = input.run.runId;
    if (
      runId !== expected.authorizedRunId ||
      expected.identity.catalogVersion !== D01_CATALOG_VERSION ||
      expected.identity.profileVersion !== D01_PUBLISH_PROFILE_VERSION ||
      expected.identity.sourceContractVersion !== "d01-validated-source-v1" ||
      env.EVENTHOUSE_QUERY_URI !== expected.target.endpoint ||
      env.MINING_EVENTHOUSE_QUERY_URI !== expected.target.endpoint ||
      env.EVENTHOUSE_DATABASE_NAME !== expected.target.databaseName ||
      env.MINING_EVENTHOUSE_DATABASE_NAME !== expected.target.databaseName
    ) {
      throw new MiningReceiptError("Curated read does not match the independently approved scope.");
    }
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    const active = controller.signal;
    try {
      const envelope = await readPinnedMiningReceipt(store, receiptPin, active);
      const receipt = parseMiningProofReceipt(envelope.value);
      assertReceiptMatchesExpectations(receipt, expected);
      assertReceiptObservationConsistency(receipt);
      if (Date.parse(receipt.issuedAtUtc) > now()) {
        throw new MiningReceiptError("Curated proof receipt is from the future.");
      }
      await verifyNative(structuredClone(receipt), active);
      active.throwIfAborted();
      const definition = input.run.contract
        ? createD01VersionedIncidentRun({ ...input.run, contract: input.run.contract })
        : createD01IncidentRun(input.run);
      const journal = await readMiningIncidentJournal(store, definition, {
        signal: active,
      });
      active.throwIfAborted();
      if (!journal) throw new MiningQueryError("upstream", "The incident journal is unavailable.");
      const incidents = mapCurrentIncidentJournal({ run: input.run, journal });
      if (Date.parse(incidents.asOf) > now()) {
        throw new MiningQueryError("malformed", "The incident assessment is from the future.");
      }
      if (input.kind === "context") return null;
      if (input.kind === "incidents") {
        if (Date.parse(incidents.asOf) > Date.parse(input.asOf)) {
          throw new MiningQueryError("invalid", "Historical incident replay is not available.");
        }
        return incidents;
      }
      if (input.kind === "trend") {
        const rows = await query({ ...input, runId }, active);
        active.throwIfAborted();
        return mapTrendRows({ ...input, runId }, rows);
      }
      if (input.kind === "compare") {
        const rows = await query({ ...input, runId }, active);
        active.throwIfAborted();
        return mapComparisonRows({ ...input, runId }, rows);
      }
      const end = input.asOf;
      const start = new Date(Date.parse(end) - 5 * 60_000).toISOString();
      const [latestRows, summaryRows] = await Promise.all([
        query({ kind: "latest", runId, asOf: end, maxRows: 1000 }, active),
        query({ kind: "summary", runId, start, end, maxRows: 1 }, active),
      ]);
      active.throwIfAborted();
      const latest = mapLatestRows({ runId, asOf: end }, latestRows);
      const summary = mapSummaryRows({ runId, start, end }, summaryRows);
      const modules = D01_PLANT_CATALOG.modules.map((module) => ({
        moduleId: module.id,
        // State is not an engineering operating limit or propagated incident evidence.
        status:
          latest.states[module.line]?.status === "stopped"
            ? ("stopped" as const)
            : ("unknown" as const),
      }));
      const qualities = latest.readings.map((reading) => reading.quality);
      const quality =
        (["bad", "uncertain", "stale", "missing"] as const).find((item) =>
          qualities.includes(item),
        ) ?? "good";
      return {
        plantId: "D01" as const,
        runId,
        catalogVersion: D01_CATALOG_VERSION,
        asOf: end,
        refreshedAt: new Date(now()).toISOString(),
        quality,
        latest: { modules, readings: latest.readings },
        summary,
      };
    } finally {
      signal.removeEventListener("abort", cancel);
      controller.abort();
    }
  };
}

export type MiningCuratedProvider = ReturnType<typeof createMiningCuratedProvider>;
