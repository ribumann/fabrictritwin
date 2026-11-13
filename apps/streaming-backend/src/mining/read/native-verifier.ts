import { createHash } from "node:crypto";
import {
  accessToken,
  assertMiningQueryConfiguration,
  assertPublicCloudMetadata,
  identityEndpoint,
  MiningQueryError,
  readJson,
  type MiningTokenResource,
} from "./bounded-query.js";
import { canonicalJson } from "./pinned-receipt.js";
import type { MiningProofReceipt } from "./receipt-schema.js";

type NativeReceipt = Pick<MiningProofReceipt, "target"> & {
  deploymentObservation: Pick<
    MiningProofReceipt["deploymentObservation"],
    "eventstreamNativeDefinitionSha256" | "eventhouseNativeDefinitionSetSha256"
  >;
};

/** Independently protected native expectations, never populated from the receipt being checked. */
export interface MiningNativeExpectations extends NativeReceipt {
  managedIdentityPrincipalId: string;
}

const KUSTO: MiningTokenResource = "https://kusto.kusto.windows.net";
const FABRIC: MiningTokenResource = "https://api.fabric.microsoft.com";
const DEADLINE_MS = 9_000;
const MAX_BYTES = 1_048_576;
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha256 = /^[0-9a-f]{64}$/;
const nativeSchemaCommand =
  ".show database schema as csl script with " +
  "(ShowObfuscatedStrings=false, IncludeSecuritySettings=true, " +
  "IncludeEncodingPolicies=true, IncludeIngestionMappings=true) " +
  "| project NativeDefinition=tostring(pack_all())";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(): never {
  throw new MiningQueryError("malformed", "Invalid or incomplete mining native definition.");
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** V1 contract: hash every exact decoded part, sorted by its unique path. */
export function hashMiningNativeEventstream(value: unknown): string {
  const definition = record(value) ? value.definition : undefined;
  const parts = record(definition) ? definition.parts : undefined;
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 100) invalid();
  const paths = new Set<string>();
  const manifest: { path: string; sha256: string }[] = [];
  let bytes = 0;
  for (const part of parts) {
    if (
      !record(part) ||
      typeof part.path !== "string" ||
      !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(part.path) ||
      part.path.split("/").some((segment) => segment === "." || segment === "..") ||
      paths.has(part.path) ||
      part.payloadType !== "InlineBase64" ||
      typeof part.payload !== "string" ||
      !part.payload
    )
      invalid();
    const decoded = Buffer.from(part.payload, "base64");
    bytes += decoded.length;
    if (decoded.toString("base64") !== part.payload || bytes > MAX_BYTES) invalid();
    if (part.path === "eventstream.json") {
      try {
        if (!record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded)))) {
          invalid();
        }
      } catch {
        invalid();
      }
    }
    paths.add(part.path);
    manifest.push({ path: part.path, sha256: createHash("sha256").update(decoded).digest("hex") });
  }
  if (!paths.has("eventstream.json")) invalid();
  manifest.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return digest({ contract: "d01-native-eventstream-v1", parts: manifest });
}

function tableRows(value: unknown, columns: Record<string, string>): Record<string, unknown>[] {
  if (
    !record(value) ||
    typeof value.TableName !== "string" ||
    !Array.isArray(value.Columns) ||
    value.Columns.length !== Object.keys(columns).length ||
    !Array.isArray(value.Rows) ||
    value.Rows.length > 1000
  )
    invalid();
  const names: string[] = [];
  for (const column of value.Columns) {
    if (
      !record(column) ||
      typeof column.ColumnName !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_]*$/.test(column.ColumnName) ||
      names.includes(column.ColumnName) ||
      !Object.hasOwn(columns, column.ColumnName) ||
      column.ColumnType !== columns[column.ColumnName]
    )
      invalid();
    names.push(column.ColumnName);
  }
  return value.Rows.map((row: unknown) => {
    if (!Array.isArray(row) || row.length !== names.length || row.includes(undefined)) invalid();
    return Object.fromEntries(names.map((name, index) => [name, row[index]]));
  });
}

/** V1 management envelope, including its table of contents and successful completion status. */
export function hashMiningNativeDatabase(value: unknown): string {
  if (
    !record(value) ||
    Object.keys(value).some((key) => key !== "Tables" && key !== "Exceptions") ||
    (value.Exceptions !== undefined &&
      (!Array.isArray(value.Exceptions) || value.Exceptions.length !== 0)) ||
    !Array.isArray(value.Tables) ||
    value.Tables.length !== 4
  )
    invalid();
  const primary = tableRows(value.Tables[0], { NativeDefinition: "string" });
  const properties = tableRows(value.Tables[1], { Value: "string" });
  const status = tableRows(value.Tables[2], {
    Timestamp: "datetime",
    Severity: "int",
    SeverityName: "string",
    StatusCode: "int",
    StatusDescription: "string",
    Count: "int",
    RequestId: "guid",
    ActivityId: "guid",
    SubActivityId: "guid",
    ClientActivityId: "string",
  });
  const contents = tableRows(value.Tables[3], {
    Ordinal: "long",
    Kind: "string",
    Name: "string",
    Id: "string",
    PrettyName: "string",
  });
  const kinds = ["QueryResult", "QueryProperties", "QueryStatus"];
  const names = ["PrimaryResult", "@ExtendedProperties", "QueryStatus"];
  if (
    contents.length !== 3 ||
    contents.some(
      (row, index) =>
        row.Ordinal !== index || row.Kind !== kinds[index] || row.Name !== names[index],
    ) ||
    primary.length < 1 ||
    properties.length !== 1 ||
    typeof properties[0].Value !== "string" ||
    status.length < 1 ||
    status.some(
      (row) =>
        !Number.isInteger(row.Severity) ||
        typeof row.Severity !== "number" ||
        row.Severity < 4 ||
        row.Severity > 6 ||
        row.StatusCode !== 0,
    )
  )
    invalid();
  let statements: string[];
  try {
    if (!record(JSON.parse(properties[0].Value))) invalid();
    statements = primary.map((row) => {
      if (Object.keys(row).length !== 1 || typeof row.NativeDefinition !== "string") invalid();
      const source: unknown = JSON.parse(row.NativeDefinition);
      if (
        !record(source) ||
        Object.keys(source).length !== 1 ||
        typeof source.DatabaseSchemaScript !== "string" ||
        !source.DatabaseSchemaScript.trim()
      )
        invalid();
      return source.DatabaseSchemaScript;
    });
  } catch {
    invalid();
  }
  return digest({ contract: "d01-native-kql-schema-v1", statements });
}

function assertTokenPrincipal(
  token: string,
  expected: MiningNativeExpectations,
  clientId: string,
  resource: MiningTokenResource,
  now: number,
): void {
  let claims: unknown;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) invalid();
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new MiningQueryError("malformed", "Invalid mining native identity token.");
  }
  if (
    !record(claims) ||
    claims.tid !== expected.target.tenantId ||
    claims.oid !== expected.managedIdentityPrincipalId ||
    (claims.appid ?? claims.azp) !== clientId ||
    claims.aud !== resource ||
    typeof claims.exp !== "number" ||
    !Number.isFinite(claims.exp) ||
    claims.exp * 1000 <= now + DEADLINE_MS ||
    typeof claims.nbf !== "number" ||
    !Number.isFinite(claims.nbf) ||
    claims.nbf * 1000 > now
  )
    throw new MiningQueryError("configuration", "Mining native identity claims do not match.");
}

/**
 * Fresh, read-only native drift verification. This neither issues a receipt nor activates mining.
 * The host must still validate the full pinned receipt, approved run and all semantic expectations.
 */
export function createMiningNativeVerifier(
  expectations: MiningNativeExpectations,
  environment: NodeJS.ProcessEnv = process.env,
  options: { fetch?: typeof fetch; now?: () => number } = {},
) {
  const expected = structuredClone(expectations);
  const env = { ...environment };
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  return async (receipt: NativeReceipt, signal: AbortSignal): Promise<void> => {
    assertMiningQueryConfiguration(env);
    const { target, deploymentObservation: pins } = expected;
    if (
      target.cloud !== "AzurePublic" ||
      !target.environment ||
      ![
        target.tenantId,
        target.subscriptionId,
        target.workspaceId,
        target.eventstreamId,
        target.eventhouseWorkspaceId,
        target.kqlDatabaseId,
        expected.managedIdentityPrincipalId,
      ].every((id) => typeof id === "string" && guid.test(id)) ||
      target.endpoint !== env.EVENTHOUSE_QUERY_URI ||
      target.databaseName !== env.EVENTHOUSE_DATABASE_NAME ||
      !sha256.test(pins.eventstreamNativeDefinitionSha256) ||
      !sha256.test(pins.eventhouseNativeDefinitionSetSha256) ||
      canonicalJson(receipt.target) !== canonicalJson(target) ||
      receipt.deploymentObservation.eventstreamNativeDefinitionSha256 !==
        pins.eventstreamNativeDefinitionSha256 ||
      receipt.deploymentObservation.eventhouseNativeDefinitionSetSha256 !==
        pins.eventhouseNativeDefinitionSetSha256
    )
      throw new MiningQueryError(
        "configuration",
        "Mining native target or protected pins do not match.",
      );
    if (signal.aborted)
      throw new MiningQueryError("cancelled", "Mining native verification cancelled.");
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, DEADLINE_MS);
    const cancel = () => controller.abort();
    signal.addEventListener("abort", cancel, { once: true });
    const read = async (url: string | URL, init: RequestInit, maxBytes: number) => {
      controller.signal.throwIfAborted();
      const value = await readJson(
        await request(url, {
          ...init,
          redirect: "error",
          signal: controller.signal,
        }),
        maxBytes,
      );
      controller.signal.throwIfAborted();
      return value;
    };
    try {
      const endpoint = target.endpoint.replace(/\/$/, "");
      assertPublicCloudMetadata(
        await read(
          `${endpoint}/v1/rest/auth/metadata`,
          { headers: { "Cache-Control": "no-cache" } },
          16_384,
        ),
      );
      const tokens = await Promise.all(
        [FABRIC, KUSTO].map(async (resource) => {
          const token = accessToken(
            await read(
              identityEndpoint(env, resource),
              {
                headers: { "X-IDENTITY-HEADER": env.IDENTITY_HEADER! },
              },
              16_384,
            ),
            env.MINING_MANAGED_IDENTITY_CLIENT_ID!,
            now(),
            resource,
          );
          assertTokenPrincipal(
            token,
            expected,
            env.MINING_MANAGED_IDENTITY_CLIENT_ID!,
            resource,
            now(),
          );
          return token;
        }),
      );
      const headers = (token: string) => ({
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "x-ms-readonly": "true",
      });
      const [eventstream, database, item] = await Promise.all([
        read(
          `${FABRIC}/v1/workspaces/${target.workspaceId}/eventstreams/${target.eventstreamId}/getDefinition`,
          { method: "POST", headers: headers(tokens[0]) },
          MAX_BYTES,
        ),
        read(
          `${endpoint}/v1/rest/mgmt`,
          {
            method: "POST",
            headers: headers(tokens[1]),
            body: JSON.stringify({ db: target.databaseName, csl: nativeSchemaCommand }),
          },
          MAX_BYTES,
        ),
        read(
          `${FABRIC}/v1/workspaces/${target.eventhouseWorkspaceId}/kqlDatabases/${target.kqlDatabaseId}`,
          { headers: headers(tokens[0]) },
          16_384,
        ),
      ]);
      const itemProperties = record(item) ? item.properties : undefined;
      if (
        !record(item) ||
        item.id !== target.kqlDatabaseId ||
        item.workspaceId !== target.eventhouseWorkspaceId ||
        item.type !== "KQLDatabase" ||
        item.displayName !== target.databaseName ||
        !record(itemProperties) ||
        itemProperties.databaseType !== "ReadWrite" ||
        typeof itemProperties.queryServiceUri !== "string" ||
        itemProperties.queryServiceUri.replace(/\/$/, "") !== endpoint
      )
        throw new MiningQueryError("configuration", "Mining native database item binding changed.");
      if (
        hashMiningNativeEventstream(eventstream) !== pins.eventstreamNativeDefinitionSha256 ||
        hashMiningNativeDatabase(database) !== pins.eventhouseNativeDefinitionSetSha256
      )
        throw new MiningQueryError("upstream", "Mining native deployment has drifted.");
      controller.signal.throwIfAborted();
    } catch (cause) {
      if (controller.signal.aborted) {
        throw new MiningQueryError(
          timedOut ? "timeout" : "cancelled",
          timedOut
            ? "Mining native verification exceeded its deadline."
            : "Mining native verification cancelled.",
        );
      }
      if (cause instanceof MiningQueryError) throw cause;
      throw new MiningQueryError("upstream", "Mining native verification failed.");
    } finally {
      controller.abort();
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
    }
  };
}
