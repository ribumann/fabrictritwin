import { MiningReceiptError } from "./pinned-receipt.js";
import type { MiningProofReceipt } from "./receipt-schema.js";

type Contract = MiningProofReceipt["semanticObservation"]["contracts"][number];

/** Expected values must come from independently protected operator-approved configuration. */
export interface MiningReceiptExpectations {
  authorizedRunId: string;
  canaryRunId: string;
  target: MiningProofReceipt["target"];
  identity: MiningProofReceipt["identity"];
  canaryFixtureSha256: string;
  semanticFixtureSha256: string;
  semanticContracts: Array<
    Pick<Contract, "functionName" | "assertionCount" | "resultRowCount" | "outputSha256">
  >;
}

/**
 * Compares receipt claims to expected values. This alone is not proof: callers still need
 * independent authorization, protected configuration and fresh native readback.
 */
export function assertReceiptMatchesExpectations(
  receipt: MiningProofReceipt,
  expected: MiningReceiptExpectations,
): void {
  const target = receipt.target;
  const identity = receipt.identity;
  if (
    receipt.authorizedRunId !== expected.authorizedRunId ||
    receipt.canaryObservation.runId !== expected.canaryRunId ||
    receipt.canaryObservation.fixtureSha256 !== expected.canaryFixtureSha256 ||
    receipt.semanticObservation.fixtureSha256 !== expected.semanticFixtureSha256 ||
    target.cloud !== expected.target.cloud ||
    target.environment !== expected.target.environment ||
    target.tenantId !== expected.target.tenantId ||
    target.subscriptionId !== expected.target.subscriptionId ||
    target.workspaceId !== expected.target.workspaceId ||
    target.eventstreamId !== expected.target.eventstreamId ||
    target.eventhouseWorkspaceId !== expected.target.eventhouseWorkspaceId ||
    target.kqlDatabaseId !== expected.target.kqlDatabaseId ||
    target.endpoint !== expected.target.endpoint ||
    target.databaseName !== expected.target.databaseName ||
    identity.plantId !== expected.identity.plantId ||
    identity.catalogVersion !== expected.identity.catalogVersion ||
    identity.profileVersion !== expected.identity.profileVersion ||
    identity.sourceContractVersion !== expected.identity.sourceContractVersion ||
    identity.sourceCommitSha !== expected.identity.sourceCommitSha ||
    identity.sourceFilesSha256.MiningSchema !== expected.identity.sourceFilesSha256.MiningSchema ||
    identity.sourceFilesSha256.MiningValidation !==
      expected.identity.sourceFilesSha256.MiningValidation ||
    identity.sourceFilesSha256.MiningQueries !==
      expected.identity.sourceFilesSha256.MiningQueries ||
    identity.querySetSha256 !== expected.identity.querySetSha256
  ) {
    throw new MiningReceiptError("Receipt does not match approved target or identity.");
  }
  const contracts = receipt.semanticObservation.contracts;
  if (
    expected.semanticContracts.length !== contracts.length ||
    new Set(expected.semanticContracts.map((item) => item.functionName)).size !==
      contracts.length ||
    contracts.some((item) => {
      const expectedItem = expected.semanticContracts.find(
        (candidate) => candidate.functionName === item.functionName,
      );
      return (
        !expectedItem ||
        item.assertionCount !== expectedItem.assertionCount ||
        item.resultRowCount !== expectedItem.resultRowCount ||
        item.outputSha256 !== expectedItem.outputSha256
      );
    })
  ) {
    throw new MiningReceiptError("Receipt does not match approved semantic results.");
  }
}
