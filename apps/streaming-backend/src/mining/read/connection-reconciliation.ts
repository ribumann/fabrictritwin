import {
  D01_CATALOG_VERSION,
  D01_CONNECTION_MEASUREMENT_CATALOG_VERSION,
  D01_CONNECTION_PROFILE_VERSION,
} from "@triathlon-twin/simulator/mining";
import { MiningQueryError } from "./bounded-query.js";

type Row = Record<string, unknown>;

const statuses = [
  "OBSERVED_MATCH",
  "DUPLICATE_MATCH",
  "MISSING_FROM_RAW_AND_VALIDATED",
  "VALIDATED_WITHOUT_RAW",
  "VALIDATED_WITHOUT_ACCEPTED_RAW",
  "RAW_NOT_ACCEPTED",
  "RAW_OUT_OF_SCOPE",
  "RAW_ONLY",
  "RAW_CONFLICT",
  "VALIDATED_CONFLICT",
  "RAW_VALIDATED_MISMATCH",
] as const;
type Status = (typeof statuses)[number];

function malformed(): never {
  throw new MiningQueryError("malformed", "Invalid connection reconciliation evidence.");
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return malformed();
  return value;
}

function instant(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(value)) {
    return malformed();
  }
  const parsed = Date.parse(value);
  const ms = value.replace(
    /(?:\.(\d{1,7}))?Z$/,
    (_, fraction: string | undefined) => `.${(fraction ?? "").padEnd(3, "0").slice(0, 3)}Z`,
  );
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== ms) return malformed();
  return value.replace(
    /(?:\.(\d{1,7}))?Z$/,
    (_, fraction: string | undefined) => `.${(fraction ?? "").padEnd(7, "0")}Z`,
  );
}

/** Evidence covers only supplied identities, not the completeness of a run schedule. */
export function mapConnectionExpectedSet(
  input: { runId: string; asOf: string; expectedEventIds: readonly string[] },
  rows: Row[],
) {
  if (
    !Array.isArray(input.expectedEventIds) ||
    input.expectedEventIds.length < 1 ||
    input.expectedEventIds.length > 200 ||
    new Set(input.expectedEventIds).size !== input.expectedEventIds.length ||
    input.expectedEventIds.some((id) => !/^[0-9a-f]{64}$/.test(id))
  ) {
    throw new MiningQueryError("invalid", "Invalid mining connection expected event set.");
  }
  const cutoff = instant(input.asOf);
  if (
    rows.length === 1 &&
    [
      "INVALID_REQUEST",
      "TRUNCATED",
      "RUN_PIN_MISSING_OR_AMBIGUOUS",
      "RUN_PIN_RECEIPT_TIME_UNAVAILABLE",
    ].includes(String(rows[0].Status))
  ) {
    throw new MiningQueryError(
      rows[0].Status === "TRUNCATED" ? "overflow" : "upstream",
      `Connection reconciliation returned ${String(rows[0].Status)}.`,
    );
  }
  if (rows.length !== input.expectedEventIds.length) return malformed();
  const pending = new Set(input.expectedEventIds);
  const evidence = rows.map((row) => {
    if (
      row.RunId !== input.runId ||
      row.CatalogVersion !== D01_CATALOG_VERSION ||
      row.MeasurementCatalogVersion !== D01_CONNECTION_MEASUREMENT_CATALOG_VERSION ||
      row.ProfileVersion !== D01_CONNECTION_PROFILE_VERSION ||
      instant(row.AsOf) !== cutoff ||
      row.EvidenceScope !== "explicit_expected_ids_only" ||
      typeof row.ExpectedEventId !== "string" ||
      !pending.delete(row.ExpectedEventId) ||
      !statuses.includes(row.Status as Status)
    )
      return malformed();
    const raw = count(row.RawCopyCount);
    const inScope = count(row.RawInScopeCopyCount);
    const outOfScope = count(row.RawOutOfScopeCopyCount);
    const accepted = count(row.RawAcceptedCopyCount);
    const quarantined = count(row.RawQuarantinedCopyCount);
    const blocked = count(row.RawBlockedCopyCount);
    const rawDuplicates = count(row.RawDuplicateCopyCount);
    const validated = count(row.ValidatedCopyCount);
    const validatedDuplicates = count(row.ValidatedDuplicateCopyCount);
    const rawFingerprints = count(row.RawDistinctPayloadCountCappedAt2);
    const acceptedFingerprints = count(row.RawAcceptedDistinctPayloadCountCappedAt2);
    const validatedFingerprints = count(row.ValidatedDistinctPayloadCountCappedAt2);
    const materializedFingerprints = count(row.MaterializedDistinctPayloadCountCappedAt2);
    const comparable =
      accepted > 0 && validated > 0 && acceptedFingerprints === 1 && validatedFingerprints === 1;
    if (
      inScope + outOfScope !== raw ||
      accepted + quarantined + blocked !== inScope ||
      rawDuplicates !== Math.max(0, raw - 1) ||
      validatedDuplicates !== Math.max(0, validated - 1) ||
      [rawFingerprints, acceptedFingerprints, validatedFingerprints, materializedFingerprints].some(
        (n) => n > 2,
      ) ||
      rawFingerprints > raw ||
      acceptedFingerprints > accepted ||
      validatedFingerprints > validated ||
      materializedFingerprints > validated ||
      typeof row.RawConflict !== "boolean" ||
      typeof row.ValidatedConflict !== "boolean" ||
      typeof row.PayloadMismatch !== "boolean" ||
      typeof row.Conflict !== "boolean" ||
      ![null, true, false].includes(row.RawValidatedPayloadMatch as boolean | null) ||
      row.ValidatedConflict !== (validatedFingerprints > 1 || materializedFingerprints > 1) ||
      (comparable
        ? typeof row.RawValidatedPayloadMatch !== "boolean"
        : row.RawValidatedPayloadMatch !== null) ||
      row.PayloadMismatch !==
        (accepted > 0 &&
          validated > 0 &&
          (!comparable || row.RawValidatedPayloadMatch === false)) ||
      row.Conflict !== (row.RawConflict || row.ValidatedConflict || row.PayloadMismatch)
    )
      return malformed();
    const expectedStatus = row.RawConflict
      ? "RAW_CONFLICT"
      : row.ValidatedConflict
        ? "VALIDATED_CONFLICT"
        : row.PayloadMismatch
          ? "RAW_VALIDATED_MISMATCH"
          : raw === 0 && validated === 0
            ? "MISSING_FROM_RAW_AND_VALIDATED"
            : raw === 0
              ? "VALIDATED_WITHOUT_RAW"
              : accepted === 0 && validated > 0
                ? "VALIDATED_WITHOUT_ACCEPTED_RAW"
                : accepted === 0 && inScope > 0
                  ? "RAW_NOT_ACCEPTED"
                  : accepted === 0 && outOfScope > 0
                    ? "RAW_OUT_OF_SCOPE"
                    : validated === 0
                      ? "RAW_ONLY"
                      : rawDuplicates > 0 || validatedDuplicates > 0
                        ? "DUPLICATE_MATCH"
                        : "OBSERVED_MATCH";
    if (
      row.Status !== expectedStatus ||
      ((expectedStatus === "OBSERVED_MATCH" || expectedStatus === "DUPLICATE_MATCH") &&
        row.RawValidatedPayloadMatch !== true)
    )
      return malformed();
    if (
      accepted > 0 &&
      (typeof row.RawAcceptedEvent !== "object" ||
        row.RawAcceptedEvent === null ||
        Array.isArray(row.RawAcceptedEvent) ||
        typeof row.RawAcceptedSampleTime !== "string")
    )
      return malformed();
    if (
      validated > 0 &&
      (typeof row.ValidatedEvent !== "object" ||
        row.ValidatedEvent === null ||
        Array.isArray(row.ValidatedEvent))
    )
      return malformed();
    return {
      eventId: row.ExpectedEventId,
      status: expectedStatus,
      rawCopies: raw,
      validatedCopies: validated,
      rawEvent: accepted > 0 ? (row.RawAcceptedEvent as Record<string, unknown>) : null,
      rawSampleTime: accepted > 0 ? (row.RawAcceptedSampleTime as string) : null,
      validatedEvent: validated > 0 ? (row.ValidatedEvent as Record<string, unknown>) : null,
    };
  });
  if (pending.size) return malformed();
  return { evidenceScope: "explicit_expected_ids_only" as const, evidence };
}

export function mapConnectionRunRowTotals(input: { runId: string; asOf: string }, rows: Row[]) {
  if (
    rows.length !== 1 ||
    rows[0].Status !== "OK" ||
    rows[0].RunId !== input.runId ||
    instant(rows[0].AsOf) !== instant(input.asOf)
  )
    return malformed();
  return {
    rawRows: count(rows[0].RawRows),
    validatedRows: count(rows[0].ValidatedRows),
    rawReceiptTimeMissing: count(rows[0].RawReceiptTimeMissing),
    validatedReceiptTimeMissing: count(rows[0].ValidatedReceiptTimeMissing),
  };
}
