import { MiningReceiptError } from "./pinned-receipt.js";

type JsonRecord = Record<string, unknown>;

export interface MiningProofReceipt {
  schemaVersion: 1;
  receiptId: string;
  issuedAtUtc: string;
  authorizedRunId: string;
  issuer: { tenantId: string; principalObjectId: string; collectorCommitSha: string };
  target: {
    cloud: "AzurePublic";
    environment: string;
    tenantId: string;
    subscriptionId: string;
    workspaceId: string;
    eventstreamId: string;
    eventhouseWorkspaceId: string;
    kqlDatabaseId: string;
    endpoint: string;
    databaseName: string;
  };
  identity: {
    plantId: "D01";
    catalogVersion: string;
    profileVersion: string;
    sourceContractVersion: string;
    sourceCommitSha: string;
    sourceFilesSha256: {
      MiningSchema: string;
      MiningValidation: string;
      MiningQueries: string;
    };
    querySetSha256: string;
  };
  deploymentObservation: {
    observedAtUtc: string;
    eventstreamNativeDefinitionSha256: string;
    eventhouseNativeDefinitionSetSha256: string;
  };
  canaryObservation: {
    observedAtUtc: string;
    fixtureSha256: string;
    runId: string;
    telemetry: CanaryCounts;
    state: CanaryCounts;
  };
  classifierObservation: {
    observedAtUtc: string;
    sourceReadinessStatus: string;
    telemetry: ClassifierCounts;
    state: ClassifierCounts;
  };
  semanticObservation: {
    observedAtUtc: string;
    fixtureSha256: string;
    querySetSha256: string;
    contracts: SemanticContract[];
  };
  engineSelfTest?: {
    scope: "CompilerFixtureOnly";
    payloadSha256: string;
    fixtureSha256: string;
    checkCount: number;
    passedCheckCount: number;
    resultRowCount: number;
  };
}

interface CanaryCounts {
  expectedDistinctEventIds: number;
  observedDistinctEventIds: number;
  observedCopies: number;
  exactLexemeCopies: number;
  rawIngestionNonNullCopies: number;
  wrongDestinationCopies: number;
}

interface ClassifierCounts {
  rawCopies: number;
  classifierRows: number;
  acceptedRows: number;
  receivedAtMatchRows: number;
  blockedRows: number;
  quarantinedRows: number;
  deduplicatedRows: number;
  deduplicatedCopies: number;
  dedupConflictRows: number;
  dedupReceivedAtMatchRows: number;
}

interface SemanticContract {
  functionName:
    | "mining_PlantLatest"
    | "mining_PlantSummary"
    | "mining_AssetTrend"
    | "mining_ActiveIncidents"
    | "mining_CompareLines";
  assertionCount: number;
  observedAssertionCount: number;
  mismatchCount: number;
  resultRowCount: number;
  outputSha256: string;
}

const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256 = /^[0-9a-f]{64}$/;
const commit = /^[0-9a-f]{40}$/;
const functions = [
  "mining_PlantLatest",
  "mining_PlantSummary",
  "mining_AssetTrend",
  "mining_ActiveIncidents",
  "mining_CompareLines",
];

function fail(): never {
  throw new MiningReceiptError("Receipt schema is invalid.");
}

function object(value: unknown, required: string[], optional: string[] = []): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const record = value as JsonRecord;
  const keys = Object.keys(record);
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  )
    return fail();
  return record;
}

function string(value: unknown, pattern?: RegExp): string {
  if (typeof value !== "string" || !value || (pattern && !pattern.test(value))) return fail();
  return value;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return fail();
  return value;
}

function instant(value: unknown): string {
  const text = string(value);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(text)) return fail();
  const time = Date.parse(text);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== text.slice(0, 19)) {
    return fail();
  }
  return text;
}

function orderedInstant(value: string): string {
  const [whole, fraction = ""] = value.slice(0, -1).split(".");
  return `${whole}.${fraction.padEnd(7, "0")}`;
}

function counts(value: unknown): CanaryCounts {
  const item = object(value, [
    "expectedDistinctEventIds",
    "observedDistinctEventIds",
    "observedCopies",
    "exactLexemeCopies",
    "rawIngestionNonNullCopies",
    "wrongDestinationCopies",
  ]);
  return {
    expectedDistinctEventIds: count(item.expectedDistinctEventIds),
    observedDistinctEventIds: count(item.observedDistinctEventIds),
    observedCopies: count(item.observedCopies),
    exactLexemeCopies: count(item.exactLexemeCopies),
    rawIngestionNonNullCopies: count(item.rawIngestionNonNullCopies),
    wrongDestinationCopies: count(item.wrongDestinationCopies),
  };
}

function classifierCounts(value: unknown): ClassifierCounts {
  const item = object(value, [
    "rawCopies",
    "classifierRows",
    "acceptedRows",
    "receivedAtMatchRows",
    "blockedRows",
    "quarantinedRows",
    "deduplicatedRows",
    "deduplicatedCopies",
    "dedupConflictRows",
    "dedupReceivedAtMatchRows",
  ]);
  return {
    rawCopies: count(item.rawCopies),
    classifierRows: count(item.classifierRows),
    acceptedRows: count(item.acceptedRows),
    receivedAtMatchRows: count(item.receivedAtMatchRows),
    blockedRows: count(item.blockedRows),
    quarantinedRows: count(item.quarantinedRows),
    deduplicatedRows: count(item.deduplicatedRows),
    deduplicatedCopies: count(item.deduplicatedCopies),
    dedupConflictRows: count(item.dedupConflictRows),
    dedupReceivedAtMatchRows: count(item.dedupReceivedAtMatchRows),
  };
}

function endpoint(value: unknown): string {
  const text = string(value);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail();
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    return fail();
  return text;
}

/** Structural parsing only. A parsed receipt does not establish trusted readiness. */
export function parseMiningProofReceipt(value: unknown): MiningProofReceipt {
  const root = object(
    value,
    [
      "schemaVersion",
      "receiptId",
      "issuedAtUtc",
      "authorizedRunId",
      "issuer",
      "target",
      "identity",
      "deploymentObservation",
      "canaryObservation",
      "classifierObservation",
      "semanticObservation",
    ],
    ["engineSelfTest"],
  );
  if (root.schemaVersion !== 1) return fail();
  const issuer = object(root.issuer, ["tenantId", "principalObjectId", "collectorCommitSha"]);
  const target = object(root.target, [
    "cloud",
    "environment",
    "tenantId",
    "subscriptionId",
    "workspaceId",
    "eventstreamId",
    "eventhouseWorkspaceId",
    "kqlDatabaseId",
    "endpoint",
    "databaseName",
  ]);
  const identity = object(root.identity, [
    "plantId",
    "catalogVersion",
    "profileVersion",
    "sourceContractVersion",
    "sourceCommitSha",
    "sourceFilesSha256",
    "querySetSha256",
  ]);
  const source = object(identity.sourceFilesSha256, [
    "MiningSchema",
    "MiningValidation",
    "MiningQueries",
  ]);
  const deployment = object(root.deploymentObservation, [
    "observedAtUtc",
    "eventstreamNativeDefinitionSha256",
    "eventhouseNativeDefinitionSetSha256",
  ]);
  const canary = object(root.canaryObservation, [
    "observedAtUtc",
    "fixtureSha256",
    "runId",
    "telemetry",
    "state",
  ]);
  const classifier = object(root.classifierObservation, [
    "observedAtUtc",
    "sourceReadinessStatus",
    "telemetry",
    "state",
  ]);
  const semantic = object(root.semanticObservation, [
    "observedAtUtc",
    "fixtureSha256",
    "querySetSha256",
    "contracts",
  ]);
  if (
    target.cloud !== "AzurePublic" ||
    identity.plantId !== "D01" ||
    !Array.isArray(semantic.contracts)
  ) {
    return fail();
  }
  const contracts: SemanticContract[] = semantic.contracts.map((value: unknown) => {
    const item = object(value, [
      "functionName",
      "assertionCount",
      "observedAssertionCount",
      "mismatchCount",
      "resultRowCount",
      "outputSha256",
    ]);
    const name = string(item.functionName);
    if (!functions.includes(name)) return fail();
    return {
      functionName: name as SemanticContract["functionName"],
      assertionCount: count(item.assertionCount),
      observedAssertionCount: count(item.observedAssertionCount),
      mismatchCount: count(item.mismatchCount),
      resultRowCount: count(item.resultRowCount),
      outputSha256: string(item.outputSha256, sha256),
    };
  });
  if (
    contracts.length !== functions.length ||
    new Set(contracts.map((item) => item.functionName)).size !== functions.length
  ) {
    return fail();
  }
  const issuedAtUtc = instant(root.issuedAtUtc);
  const deployedAt = instant(deployment.observedAtUtc);
  const canaryAt = instant(canary.observedAtUtc);
  const classifierAt = instant(classifier.observedAtUtc);
  const semanticAt = instant(semantic.observedAtUtc);
  const times = [deployedAt, canaryAt, classifierAt, semanticAt, issuedAtUtc].map(orderedInstant);
  if (times.some((time, index) => index > 0 && time < times[index - 1])) return fail();
  let engineSelfTest: MiningProofReceipt["engineSelfTest"];
  if (Object.hasOwn(root, "engineSelfTest")) {
    const item = object(root.engineSelfTest, [
      "scope",
      "payloadSha256",
      "fixtureSha256",
      "checkCount",
      "passedCheckCount",
      "resultRowCount",
    ]);
    if (item.scope !== "CompilerFixtureOnly") return fail();
    engineSelfTest = {
      scope: "CompilerFixtureOnly",
      payloadSha256: string(item.payloadSha256, sha256),
      fixtureSha256: string(item.fixtureSha256, sha256),
      checkCount: count(item.checkCount),
      passedCheckCount: count(item.passedCheckCount),
      resultRowCount: count(item.resultRowCount),
    };
  }
  return {
    schemaVersion: 1,
    receiptId: string(root.receiptId, uuid4),
    issuedAtUtc,
    authorizedRunId: string(root.authorizedRunId, uuid4),
    issuer: {
      tenantId: string(issuer.tenantId, guid),
      principalObjectId: string(issuer.principalObjectId, guid),
      collectorCommitSha: string(issuer.collectorCommitSha, commit),
    },
    target: {
      cloud: "AzurePublic",
      environment: string(target.environment),
      tenantId: string(target.tenantId, guid),
      subscriptionId: string(target.subscriptionId, guid),
      workspaceId: string(target.workspaceId, guid),
      eventstreamId: string(target.eventstreamId, guid),
      eventhouseWorkspaceId: string(target.eventhouseWorkspaceId, guid),
      kqlDatabaseId: string(target.kqlDatabaseId, guid),
      endpoint: endpoint(target.endpoint),
      databaseName: string(target.databaseName),
    },
    identity: {
      plantId: "D01",
      catalogVersion: string(identity.catalogVersion),
      profileVersion: string(identity.profileVersion),
      sourceContractVersion: string(identity.sourceContractVersion),
      sourceCommitSha: string(identity.sourceCommitSha, commit),
      sourceFilesSha256: {
        MiningSchema: string(source.MiningSchema, sha256),
        MiningValidation: string(source.MiningValidation, sha256),
        MiningQueries: string(source.MiningQueries, sha256),
      },
      querySetSha256: string(identity.querySetSha256, sha256),
    },
    deploymentObservation: {
      observedAtUtc: deployedAt,
      eventstreamNativeDefinitionSha256: string(
        deployment.eventstreamNativeDefinitionSha256,
        sha256,
      ),
      eventhouseNativeDefinitionSetSha256: string(
        deployment.eventhouseNativeDefinitionSetSha256,
        sha256,
      ),
    },
    canaryObservation: {
      observedAtUtc: canaryAt,
      fixtureSha256: string(canary.fixtureSha256, sha256),
      runId: string(canary.runId, uuid4),
      telemetry: counts(canary.telemetry),
      state: counts(canary.state),
    },
    classifierObservation: {
      observedAtUtc: classifierAt,
      sourceReadinessStatus: string(classifier.sourceReadinessStatus),
      telemetry: classifierCounts(classifier.telemetry),
      state: classifierCounts(classifier.state),
    },
    semanticObservation: {
      observedAtUtc: semanticAt,
      fixtureSha256: string(semantic.fixtureSha256, sha256),
      querySetSha256: string(semantic.querySetSha256, sha256),
      contracts,
    },
    ...(engineSelfTest && { engineSelfTest }),
  };
}
