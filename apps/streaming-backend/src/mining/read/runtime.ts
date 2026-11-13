import { configuredMiningStore } from "../blob-store.js";
import { assertMiningQueryConfiguration } from "./bounded-query.js";
import { createMiningCuratedProvider } from "./curated-provider.js";
import { createMiningNativeVerifier } from "./native-verifier.js";
import { canonicalJson, MiningReceiptError } from "./pinned-receipt.js";
import type { MiningReceiptExpectations } from "./receipt-expectations.js";
import {
  miningSemanticFunctions,
  parseMiningProofIdentity,
  parseMiningProofTarget,
} from "./receipt-schema.js";

const hash = /^[0-9a-f]{64}$/;
const uuid4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function invalid(): never {
  throw new MiningReceiptError("Protected mining read configuration is missing or invalid.");
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const entries = Object.entries(value);
  if (entries.length !== keys.length || entries.some(([key]) => !keys.includes(key))) invalid();
  return Object.fromEntries(entries);
}

function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid();
  return value;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

/** Configuration is protected host input, not a downloaded receipt or a readiness assertion. */
export function parseMiningReadConfiguration(textValue: string | undefined) {
  if (!textValue || Buffer.byteLength(textValue, "utf8") > 16_384) invalid();
  let value: unknown;
  try {
    value = JSON.parse(textValue);
  } catch {
    invalid();
  }
  canonicalJson(value);
  const root = object(value, ["schemaVersion", "receiptPin", "expectations", "native"]);
  if (root.schemaVersion !== 1) invalid();
  const expected = object(root.expectations, [
    "authorizedRunId",
    "canaryRunId",
    "target",
    "identity",
    "canaryFixtureSha256",
    "semanticFixtureSha256",
    "semanticContracts",
  ]);
  const native = object(root.native, [
    "managedIdentityPrincipalId",
    "eventstreamNativeDefinitionSha256",
    "eventhouseNativeDefinitionSetSha256",
  ]);
  if (!Array.isArray(expected.semanticContracts)) invalid();
  const semanticContracts = expected.semanticContracts.map((value: unknown) => {
    const item = object(value, [
      "functionName",
      "assertionCount",
      "resultRowCount",
      "outputSha256",
    ]);
    const functionName = miningSemanticFunctions.find((name) => name === item.functionName);
    if (!functionName) invalid();
    return {
      functionName,
      assertionCount: count(item.assertionCount),
      resultRowCount: count(item.resultRowCount),
      outputSha256: text(item.outputSha256, hash),
    };
  });
  if (
    semanticContracts.length !== miningSemanticFunctions.length ||
    new Set(semanticContracts.map((item) => item.functionName)).size !==
      miningSemanticFunctions.length
  )
    invalid();
  const expectations: MiningReceiptExpectations = {
    authorizedRunId: text(expected.authorizedRunId, uuid4),
    canaryRunId: text(expected.canaryRunId, uuid4),
    target: parseMiningProofTarget(expected.target),
    identity: parseMiningProofIdentity(expected.identity),
    canaryFixtureSha256: text(expected.canaryFixtureSha256, hash),
    semanticFixtureSha256: text(expected.semanticFixtureSha256, hash),
    semanticContracts,
  };
  return {
    receiptPin: text(root.receiptPin, hash),
    expectations,
    native: {
      target: expectations.target,
      managedIdentityPrincipalId: text(native.managedIdentityPrincipalId, guid),
      deploymentObservation: {
        eventstreamNativeDefinitionSha256: text(native.eventstreamNativeDefinitionSha256, hash),
        eventhouseNativeDefinitionSetSha256: text(native.eventhouseNativeDefinitionSetSha256, hash),
      },
    },
  };
}

/** Lazy read-only composition: authorization and durable admission remain the router's responsibility. */
export function configuredMiningCuratedProvider(environment: NodeJS.ProcessEnv = process.env) {
  const env = { ...environment };
  if (env.MINING_READ_ENABLED !== "true") return undefined;
  return async (...args: Parameters<ReturnType<typeof createMiningCuratedProvider>>) => {
    args[1].throwIfAborted();
    const configuration = parseMiningReadConfiguration(env.MINING_READ_CONFIGURATION_JSON);
    assertMiningQueryConfiguration(env);
    if (
      configuration.expectations.authorizedRunId !== env.MINING_APPROVED_RUN_ID ||
      configuration.expectations.target.tenantId !== env.ASSISTANT_AUTH_TENANT_ID ||
      configuration.expectations.identity.catalogVersion !== env.MINING_APPROVED_CATALOG_VERSION ||
      configuration.expectations.identity.profileVersion !== env.MINING_APPROVED_PROFILE_VERSION
    )
      invalid();
    const store = configuredMiningStore(env);
    if (!store) throw new MiningReceiptError("The dedicated mining read store is not configured.");
    return createMiningCuratedProvider({
      store,
      receiptPin: configuration.receiptPin,
      expectations: configuration.expectations,
      verifyNative: createMiningNativeVerifier(configuration.native, env),
      env,
    })(...args);
  };
}
