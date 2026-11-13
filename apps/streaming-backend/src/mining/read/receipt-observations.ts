import { MiningReceiptError } from "./pinned-receipt.js";
import type { MiningProofReceipt } from "./receipt-schema.js";

/** Necessary internal consistency only; this does not establish trusted readiness. */
export function assertReceiptObservationConsistency(receipt: MiningProofReceipt): void {
  const classifier = receipt.classifierObservation;
  if (classifier.sourceReadinessStatus !== "READY") {
    throw new MiningReceiptError("Receipt source observation is not ready.");
  }
  for (const kind of ["telemetry", "state"] as const) {
    const raw = receipt.canaryObservation[kind];
    const classified = classifier[kind];
    if (
      raw.expectedDistinctEventIds !== 1 ||
      raw.observedDistinctEventIds !== 1 ||
      raw.observedCopies < 1 ||
      raw.exactLexemeCopies !== raw.observedCopies ||
      raw.rawIngestionNonNullCopies !== raw.observedCopies ||
      raw.wrongDestinationCopies !== 0 ||
      classified.rawCopies !== raw.observedCopies ||
      classified.classifierRows !== classified.rawCopies ||
      classified.acceptedRows !== classified.classifierRows ||
      classified.receivedAtMatchRows !== classified.classifierRows ||
      classified.blockedRows !== 0 ||
      classified.quarantinedRows !== 0 ||
      classified.deduplicatedRows !== 1 ||
      classified.deduplicatedCopies !== classified.classifierRows ||
      classified.dedupConflictRows !== 0 ||
      classified.dedupReceivedAtMatchRows !== 1
    ) {
      throw new MiningReceiptError("Receipt canary or classifier observation is inconsistent.");
    }
  }
  if (
    receipt.semanticObservation.querySetSha256 !== receipt.identity.querySetSha256 ||
    receipt.semanticObservation.contracts.some(
      (contract) =>
        contract.mismatchCount !== 0 || contract.assertionCount !== contract.observedAssertionCount,
    )
  ) {
    throw new MiningReceiptError("Receipt semantic observation is inconsistent.");
  }
}
