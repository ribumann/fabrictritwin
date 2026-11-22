import { describe, expect, it, vi } from "vitest";
import {
  D01_CATALOG_VERSION,
  D01_CONNECTION_MEASUREMENT_CATALOG_VERSION,
  D01_CONNECTION_PROFILE_VERSION,
} from "@triathlon-twin/simulator/mining";
import { mapConnectionExpectedSet } from "../src/mining/read/connection-reconciliation.js";
import { createMiningConnectionFlowProvider } from "../src/mining/read/connection-flow-provider.js";

const input = {
  runId: "11111111-1111-4111-8111-111111111111",
  asOf: "2026-01-01T12:00:00.000Z",
  expectedEventIds: ["a".repeat(64), "b".repeat(64)],
};

function row(id: string) {
  return {
    Status: "OBSERVED_MATCH",
    RunId: input.runId,
    CatalogVersion: D01_CATALOG_VERSION,
    MeasurementCatalogVersion: D01_CONNECTION_MEASUREMENT_CATALOG_VERSION,
    ProfileVersion: D01_CONNECTION_PROFILE_VERSION,
    AsOf: input.asOf,
    EvidenceScope: "explicit_expected_ids_only",
    ExpectedEventId: id,
    RawCopyCount: 1,
    RawInScopeCopyCount: 1,
    RawOutOfScopeCopyCount: 0,
    RawAcceptedCopyCount: 1,
    RawQuarantinedCopyCount: 0,
    RawBlockedCopyCount: 0,
    RawDuplicateCopyCount: 0,
    RawDistinctPayloadCountCappedAt2: 1,
    RawAcceptedDistinctPayloadCountCappedAt2: 1,
    RawConflict: false,
    ValidatedCopyCount: 1,
    ValidatedDuplicateCopyCount: 0,
    ValidatedDistinctPayloadCountCappedAt2: 1,
    MaterializedDistinctPayloadCountCappedAt2: 1,
    ValidatedConflict: false,
    RawValidatedPayloadMatch: true,
    PayloadMismatch: false,
    Conflict: false,
    RawAcceptedEvent: { event_id: id },
    RawAcceptedSampleTime: "2026-01-01T12:00:00.000Z",
    ValidatedEvent: { event_id: id },
  };
}

describe("connection expected-set evidence", () => {
  it("reports missing and matched identities without claiming run completeness", () => {
    const missing = {
      ...row(input.expectedEventIds[1]),
      Status: "MISSING_FROM_RAW_AND_VALIDATED",
      RawCopyCount: 0,
      RawInScopeCopyCount: 0,
      RawAcceptedCopyCount: 0,
      RawDistinctPayloadCountCappedAt2: 0,
      RawAcceptedDistinctPayloadCountCappedAt2: 0,
      ValidatedCopyCount: 0,
      ValidatedDistinctPayloadCountCappedAt2: 0,
      MaterializedDistinctPayloadCountCappedAt2: 0,
      RawValidatedPayloadMatch: null,
    };
    expect(mapConnectionExpectedSet(input, [row(input.expectedEventIds[0]), missing])).toEqual({
      evidenceScope: "explicit_expected_ids_only",
      evidence: [
        {
          eventId: input.expectedEventIds[0],
          status: "OBSERVED_MATCH",
          rawCopies: 1,
          validatedCopies: 1,
          rawEvent: { event_id: input.expectedEventIds[0] },
          rawSampleTime: "2026-01-01T12:00:00.000Z",
          validatedEvent: { event_id: input.expectedEventIds[0] },
        },
        {
          eventId: input.expectedEventIds[1],
          status: "MISSING_FROM_RAW_AND_VALIDATED",
          rawCopies: 0,
          validatedCopies: 0,
          rawEvent: null,
          rawSampleTime: null,
          validatedEvent: null,
        },
      ],
    });
  });

  it("rejects incomplete, repeated, inconsistent, and wrong-cutoff evidence", () => {
    const good = row(input.expectedEventIds[0]);
    const other = row(input.expectedEventIds[1]);
    for (const rows of [
      [good],
      [good, good],
      [good, { ...other, AsOf: "2026-01-01T12:00:00.0000001Z" }],
      [good, { ...other, RawAcceptedCopyCount: 0 }],
      [good, { ...other, RawValidatedPayloadMatch: false }],
      [good, { ...other, Status: "RAW_ONLY" }],
      [good, { ...other, RawAcceptedEvent: null }],
    ]) {
      expect(() => mapConnectionExpectedSet(input, rows)).toThrow();
    }
  });

  it("preserves raw-only, duplicate, and conflicting evidence", () => {
    const first = row(input.expectedEventIds[0]);
    const second = row(input.expectedEventIds[1]);
    const variants = [
      {
        ...second,
        Status: "RAW_ONLY",
        ValidatedCopyCount: 0,
        ValidatedDistinctPayloadCountCappedAt2: 0,
        MaterializedDistinctPayloadCountCappedAt2: 0,
        RawValidatedPayloadMatch: null,
      },
      {
        ...second,
        Status: "DUPLICATE_MATCH",
        RawCopyCount: 2,
        RawInScopeCopyCount: 2,
        RawAcceptedCopyCount: 2,
        RawDuplicateCopyCount: 1,
      },
      {
        ...second,
        Status: "RAW_VALIDATED_MISMATCH",
        RawValidatedPayloadMatch: false,
        PayloadMismatch: true,
        Conflict: true,
      },
      {
        ...second,
        Status: "VALIDATED_CONFLICT",
        ValidatedCopyCount: 2,
        ValidatedDuplicateCopyCount: 1,
        MaterializedDistinctPayloadCountCappedAt2: 2,
        ValidatedConflict: true,
        Conflict: true,
      },
      {
        ...second,
        Status: "RAW_NOT_ACCEPTED",
        RawAcceptedCopyCount: 0,
        RawQuarantinedCopyCount: 1,
        RawAcceptedDistinctPayloadCountCappedAt2: 0,
        ValidatedCopyCount: 0,
        ValidatedDistinctPayloadCountCappedAt2: 0,
        MaterializedDistinctPayloadCountCappedAt2: 0,
        RawValidatedPayloadMatch: null,
      },
    ];
    for (const variant of variants) {
      expect(mapConnectionExpectedSet(input, [first, variant]).evidence[1].status).toBe(
        variant.Status,
      );
    }
  });

  it("does not interpret unavailable pin or truncation as success", () => {
    for (const Status of [
      "TRUNCATED",
      "INVALID_REQUEST",
      "RUN_PIN_MISSING_OR_AMBIGUOUS",
      "RUN_PIN_RECEIPT_TIME_UNAVAILABLE",
    ]) {
      expect(() => mapConnectionExpectedSet(input, [{ Status }])).toThrow(Status);
    }
  });

  it("uses the supplied cutoff and exact bounded identities when reading evidence", async () => {
    const query = vi.fn(async () => input.expectedEventIds.map(row));
    const signal = new AbortController().signal;
    const result = await createMiningConnectionFlowProvider(query).expectedSet(input, signal);
    expect(query).toHaveBeenCalledWith(
      { ...input, kind: "connection-expected-set", maxRows: input.expectedEventIds.length },
      signal,
    );
    expect(result.evidenceScope).toBe("explicit_expected_ids_only");
  });
});
