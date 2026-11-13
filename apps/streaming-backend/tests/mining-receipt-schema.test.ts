import { describe, expect, it } from "vitest";
import { parseMiningProofReceipt } from "../src/mining/read/receipt-schema.js";
import { assertReceiptObservationConsistency } from "../src/mining/read/receipt-observations.js";
import { assertReceiptMatchesExpectations } from "../src/mining/read/receipt-expectations.js";

const id = "11111111-1111-4111-8111-111111111111";
const hash = "a".repeat(64);
const commit = "b".repeat(40);
const names = [
  "mining_PlantLatest",
  "mining_PlantSummary",
  "mining_AssetTrend",
  "mining_ActiveIncidents",
  "mining_CompareLines",
];
const count = {
  expectedDistinctEventIds: 1,
  observedDistinctEventIds: 1,
  observedCopies: 1,
  exactLexemeCopies: 1,
  rawIngestionNonNullCopies: 1,
  wrongDestinationCopies: 0,
};
const classifierCounts = {
  rawCopies: 1,
  classifierRows: 1,
  acceptedRows: 1,
  receivedAtMatchRows: 1,
  blockedRows: 0,
  quarantinedRows: 0,
  deduplicatedRows: 1,
  deduplicatedCopies: 1,
  dedupConflictRows: 0,
  dedupReceivedAtMatchRows: 1,
};

function receipt() {
  return {
    schemaVersion: 1,
    receiptId: id,
    issuedAtUtc: "2026-01-01T00:00:03.1234567Z",
    authorizedRunId: id,
    issuer: { tenantId: id, principalObjectId: id, collectorCommitSha: commit },
    target: {
      cloud: "AzurePublic",
      environment: "test",
      tenantId: id,
      subscriptionId: id,
      workspaceId: id,
      eventstreamId: id,
      eventhouseWorkspaceId: id,
      kqlDatabaseId: id,
      endpoint: "https://example.invalid",
      databaseName: "database",
    },
    identity: {
      plantId: "D01",
      catalogVersion: "catalog",
      profileVersion: "profile",
      sourceContractVersion: "source",
      sourceCommitSha: commit,
      sourceFilesSha256: {
        MiningSchema: hash,
        MiningValidation: hash,
        MiningQueries: hash,
      },
      querySetSha256: hash,
    },
    deploymentObservation: {
      observedAtUtc: "2026-01-01T00:00:00Z",
      eventstreamNativeDefinitionSha256: hash,
      eventhouseNativeDefinitionSetSha256: hash,
    },
    canaryObservation: {
      observedAtUtc: "2026-01-01T00:00:01Z",
      fixtureSha256: hash,
      runId: id,
      telemetry: { ...count },
      state: { ...count },
    },
    classifierObservation: {
      observedAtUtc: "2026-01-01T00:00:01.5Z",
      sourceReadinessStatus: "READY",
      telemetry: { ...classifierCounts },
      state: { ...classifierCounts },
    },
    semanticObservation: {
      observedAtUtc: "2026-01-01T00:00:02Z",
      fixtureSha256: hash,
      querySetSha256: hash,
      contracts: names.map((functionName) => ({
        functionName,
        assertionCount: 1,
        observedAssertionCount: 1,
        mismatchCount: 0,
        resultRowCount: 1,
        outputSha256: hash,
      })),
    },
  };
}

describe("proof receipt structural parser", () => {
  it("parses a structurally valid but not necessarily trusted receipt", () => {
    const value = receipt();
    expect(parseMiningProofReceipt(value)).toEqual(value);
  });

  it("rejects unknown fields at every nested level and malformed identifiers", () => {
    const extra = receipt();
    Object.assign(extra.identity.sourceFilesSha256, { extra: hash });
    expect(() => parseMiningProofReceipt(extra)).toThrow("schema");
    const badId = receipt();
    badId.authorizedRunId = id.toUpperCase().replace("1111", "AAAA");
    expect(() => parseMiningProofReceipt(badId)).toThrow("schema");
    const badHash = receipt();
    badHash.identity.querySetSha256 = "A".repeat(64);
    expect(() => parseMiningProofReceipt(badHash)).toThrow("schema");
  });

  it("requires one of each semantic function and safe nonnegative counts", () => {
    const duplicate = receipt();
    duplicate.semanticObservation.contracts[0].functionName = names[1];
    expect(() => parseMiningProofReceipt(duplicate)).toThrow("schema");
    const badCount = receipt();
    badCount.canaryObservation.telemetry.observedCopies = Number.MAX_SAFE_INTEGER + 1;
    expect(() => parseMiningProofReceipt(badCount)).toThrow("schema");
  });

  it("enforces valid UTC dates and chronological order to sub-millisecond precision", () => {
    const invalid = receipt();
    invalid.deploymentObservation.observedAtUtc = "2026-02-30T00:00:00Z";
    expect(() => parseMiningProofReceipt(invalid)).toThrow("schema");
    const reversed = receipt();
    reversed.semanticObservation.observedAtUtc = "2026-01-01T00:00:03.1234568Z";
    expect(() => parseMiningProofReceipt(reversed)).toThrow("schema");
  });

  it("rejects endpoint credentials and optionally accepts compiler-only self-test provenance", () => {
    const unsafe = receipt();
    unsafe.target.endpoint = "https://user:password@example.invalid";
    expect(() => parseMiningProofReceipt(unsafe)).toThrow("schema");
    const withSelfTest = {
      ...receipt(),
      engineSelfTest: {
        scope: "CompilerFixtureOnly",
        payloadSha256: hash,
        fixtureSha256: hash,
        checkCount: 2,
        passedCheckCount: 1,
        resultRowCount: 1,
      },
    };
    expect(parseMiningProofReceipt(withSelfTest)).toEqual(withSelfTest);
  });

  it("allows duplicate delivery only with matching classified and deduplicated evidence", () => {
    const value = receipt();
    Object.assign(value.canaryObservation.telemetry, {
      observedCopies: 2,
      exactLexemeCopies: 2,
      rawIngestionNonNullCopies: 2,
    });
    Object.assign(value.classifierObservation.telemetry, {
      rawCopies: 2,
      classifierRows: 2,
      acceptedRows: 2,
      receivedAtMatchRows: 2,
      deduplicatedCopies: 2,
    });
    expect(() => assertReceiptObservationConsistency(parseMiningProofReceipt(value))).not.toThrow();
    value.classifierObservation.telemetry.dedupReceivedAtMatchRows = 0;
    expect(() => assertReceiptObservationConsistency(parseMiningProofReceipt(value))).toThrow(
      "inconsistent",
    );
  });

  it("rejects blocked, mismatched and partial evidence without claiming readiness", () => {
    const value = receipt();
    value.classifierObservation.sourceReadinessStatus = "BLOCKED";
    expect(() => assertReceiptObservationConsistency(parseMiningProofReceipt(value))).toThrow(
      "not ready",
    );
    value.classifierObservation.sourceReadinessStatus = "READY";
    value.canaryObservation.state.wrongDestinationCopies = 1;
    expect(() => assertReceiptObservationConsistency(parseMiningProofReceipt(value))).toThrow(
      "inconsistent",
    );
    value.canaryObservation.state.wrongDestinationCopies = 0;
    value.semanticObservation.contracts[0].observedAssertionCount = 0;
    expect(() => assertReceiptObservationConsistency(parseMiningProofReceipt(value))).toThrow(
      "inconsistent",
    );
  });

  it("compares independently supplied target, run, fixtures and semantic results", () => {
    const parsed = parseMiningProofReceipt(receipt());
    const expected = {
      authorizedRunId: parsed.authorizedRunId,
      canaryRunId: parsed.canaryObservation.runId,
      target: { ...parsed.target },
      identity: { ...parsed.identity, sourceFilesSha256: { ...parsed.identity.sourceFilesSha256 } },
      canaryFixtureSha256: parsed.canaryObservation.fixtureSha256,
      semanticFixtureSha256: parsed.semanticObservation.fixtureSha256,
      semanticContracts: parsed.semanticObservation.contracts.map((item) => ({ ...item })),
    };
    expect(() => assertReceiptMatchesExpectations(parsed, expected)).not.toThrow();
    expected.target.endpoint = "https://different.invalid";
    expect(() => assertReceiptMatchesExpectations(parsed, expected)).toThrow("target or identity");
    expected.target.endpoint = parsed.target.endpoint;
    expected.semanticContracts[0].outputSha256 = "f".repeat(64);
    expect(() => assertReceiptMatchesExpectations(parsed, expected)).toThrow("semantic results");
  });
});
