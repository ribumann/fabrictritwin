import { describe, expect, it, vi } from "vitest";
import {
  createMiningNativeVerifier,
  hashMiningNativeDatabase,
  hashMiningNativeEventstream,
  type MiningNativeExpectations,
} from "../src/mining/read/native-verifier.js";

const uri = "https://example.z6.kusto.fabric.microsoft.com";
const clientId = "11111111-2222-4333-8444-555555555555";
const principalId = "22222222-2222-4222-8222-222222222222";
const tenantId = "33333333-3333-4333-8333-333333333333";
const fabric = "https://api.fabric.microsoft.com";
const kusto = "https://kusto.kusto.windows.net";
const now = () => Date.parse("2026-01-01T12:00:00.000Z");
const env = {
  EVENTHOUSE_QUERY_URI: uri,
  MINING_EVENTHOUSE_QUERY_URI: uri,
  EVENTHOUSE_DATABASE_NAME: "ExistingDatabase",
  MINING_EVENTHOUSE_DATABASE_NAME: "ExistingDatabase",
  MINING_CURATED_SOURCE_VERSION: "d01-validated-source-v1",
  MINING_CURATED_QUERY_VERSION: "d01-g5-query-v1",
  MINING_MANAGED_IDENTITY_CLIENT_ID: clientId,
  IDENTITY_ENDPOINT: "http://127.0.0.1:1234/identity",
  IDENTITY_HEADER: "test-broker-header",
};
const metadata = {
  AzureAD: {
    LoginEndpoint: "https://login.microsoftonline.com",
    LoginMfaRequired: false,
    KustoServiceResourceId: kusto,
  },
};

function eventstream() {
  return {
    definition: {
      parts: ["eventstream.json", "eventstreamProperties.json", ".platform"].map((path) => ({
        path,
        payload: Buffer.from('{"fixture":true}').toString("base64"),
        payloadType: "InlineBase64",
      })),
    },
  };
}

function table(name: string, columns: Record<string, string>, rows: unknown[][]) {
  return {
    TableName: name,
    Columns: Object.entries(columns).map(([ColumnName, ColumnType]) => ({
      ColumnName,
      ColumnType,
    })),
    Rows: rows,
  };
}

function database() {
  return {
    Tables: [
      table("Table_0", { NativeDefinition: "string" }, [
        [
          JSON.stringify({
            DatabaseSchemaScript: ".create table MiningTelemetryRaw (runId:string)",
          }),
        ],
        [
          JSON.stringify({
            DatabaseSchemaScript: ".alter table MiningTelemetryRaw policy ingestiontime true",
          }),
        ],
        [
          JSON.stringify({
            DatabaseSchemaScript: ".create function mining_PlantLatest() { MiningTelemetryRaw }",
          }),
        ],
      ]),
      table("Table_1", { Value: "string" }, [["{}"]]),
      table(
        "Table_2",
        {
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
        },
        [
          [
            new Date(now()).toISOString(),
            4,
            "Info",
            0,
            "Complete",
            1,
            principalId,
            principalId,
            principalId,
            "fixture",
          ],
        ],
      ),
      table(
        "Table_3",
        {
          Ordinal: "long",
          Kind: "string",
          Name: "string",
          Id: "string",
          PrettyName: "string",
        },
        [
          [0, "QueryResult", "PrimaryResult", principalId, ""],
          [1, "QueryProperties", "@ExtendedProperties", principalId, ""],
          [2, "QueryStatus", "QueryStatus", principalId, ""],
        ],
      ),
    ],
  };
}

function databaseItem() {
  return {
    id: principalId,
    workspaceId: clientId,
    type: "KQLDatabase",
    displayName: "ExistingDatabase",
    properties: { databaseType: "ReadWrite", queryServiceUri: uri },
  };
}

function expectations(): MiningNativeExpectations {
  return {
    target: {
      cloud: "AzurePublic",
      environment: "test",
      tenantId,
      subscriptionId: principalId,
      workspaceId: clientId,
      eventstreamId: principalId,
      eventhouseWorkspaceId: clientId,
      kqlDatabaseId: principalId,
      endpoint: uri,
      databaseName: "ExistingDatabase",
    },
    deploymentObservation: {
      eventstreamNativeDefinitionSha256: hashMiningNativeEventstream(eventstream()),
      eventhouseNativeDefinitionSetSha256: hashMiningNativeDatabase(database()),
    },
    managedIdentityPrincipalId: principalId,
  };
}

function token(resource: string, change: Record<string, unknown> = {}) {
  const claims = {
    tid: tenantId,
    oid: principalId,
    appid: clientId,
    aud: resource,
    exp: now() / 1000 + 300,
    nbf: now() / 1000 - 300,
    ...change,
  };
  return {
    access_token: `fixture.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`,
    token_type: "Bearer",
    resource,
    client_id: clientId,
    expires_on: String(now() / 1000 + 300),
  };
}

interface FixtureOptions {
  stream?: unknown;
  schema?: unknown;
  metadata?: unknown;
  status?: number;
  claims?: Record<string, unknown>;
  item?: unknown;
}

function fixture(options: FixtureOptions = {}) {
  const request = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/rest/auth/metadata")
      return Response.json(options.metadata ?? metadata);
    if (url.hostname === "127.0.0.1") {
      return Response.json(token(url.searchParams.get("resource")!, options.claims));
    }
    if (url.hostname === "api.fabric.microsoft.com") {
      if (url.pathname.includes("/kqlDatabases/")) {
        return Response.json(options.item ?? databaseItem());
      }
      return Response.json(options.stream ?? eventstream(), {
        status: options.status ?? 200,
        headers: { Location: "https://not-approved.example/operation", "Retry-After": "30" },
      });
    }
    if (url.pathname === "/v1/rest/mgmt") return Response.json(options.schema ?? database());
    throw new Error("Unexpected native verifier request.");
  });
  const expected = expectations();
  return {
    expected,
    request,
    verify: createMiningNativeVerifier(expected, env, { fetch: request, now }),
  };
}

const signal = () => new AbortController().signal;

describe("fresh native mining verification", () => {
  it("uses the exact protected targets, selected identity, two audiences and read-only native command", async () => {
    const f = fixture();
    await f.verify(f.expected, signal());
    expect(f.request).toHaveBeenCalledTimes(6);
    expect(f.request.mock.calls[0][0]).toBe(`${uri}/v1/rest/auth/metadata`);
    const identities = f.request.mock.calls.filter(([url]) =>
      String(url).startsWith("http://127."),
    );
    expect(identities.map(([url]) => new URL(String(url)).searchParams.get("resource"))).toEqual([
      fabric,
      kusto,
    ]);
    for (const [url, init] of identities) {
      expect(new URL(String(url)).searchParams.get("client_id")).toBe(clientId);
      expect(init?.headers).toEqual({ "X-IDENTITY-HEADER": env.IDENTITY_HEADER });
    }
    const streamRead = f.request.mock.calls.find(([url]) => String(url).startsWith(fabric))!;
    expect(streamRead[0]).toBe(
      `${fabric}/v1/workspaces/${clientId}/eventstreams/${principalId}/getDefinition`,
    );
    expect(streamRead[1]?.method).toBe("POST");
    const schemaRead = f.request.mock.calls.find(([url]) => String(url).endsWith("/v1/rest/mgmt"))!;
    expect(schemaRead[0]).toBe(`${uri}/v1/rest/mgmt`);
    expect(JSON.parse(String(schemaRead[1]?.body))).toEqual({
      db: "ExistingDatabase",
      csl: ".show database schema as csl script with (ShowObfuscatedStrings=false, IncludeSecuritySettings=true, IncludeEncodingPolicies=true, IncludeIngestionMappings=true) | project NativeDefinition=tostring(pack_all())",
    });
    for (const call of [streamRead, schemaRead]) {
      expect(call[1]?.headers).toMatchObject({
        "x-ms-readonly": "true",
        "Cache-Control": "no-cache",
      });
      expect(call[1]?.headers).not.toHaveProperty("X-IDENTITY-HEADER");
    }
    expect(f.request.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
    expect(new Set(f.request.mock.calls.map(([, init]) => init?.signal)).size).toBe(1);
  });

  it("rejects foreign target, receipt self-pins and missing protected configuration before I/O", async () => {
    const f = fixture();
    const wrongTarget = structuredClone(f.expected);
    wrongTarget.target.workspaceId = tenantId;
    await expect(f.verify(wrongTarget, signal())).rejects.toMatchObject({ code: "configuration" });
    const selfPinned = structuredClone(f.expected);
    selfPinned.deploymentObservation.eventstreamNativeDefinitionSha256 = "f".repeat(64);
    await expect(f.verify(selfPinned, signal())).rejects.toMatchObject({ code: "configuration" });
    for (const change of [
      { MINING_EVENTHOUSE_DATABASE_NAME: "ForeignDatabase" },
      { MINING_MANAGED_IDENTITY_CLIENT_ID: "" },
      { IDENTITY_ENDPOINT: "http://foreign.example/identity" },
    ]) {
      await expect(
        createMiningNativeVerifier(
          f.expected,
          { ...env, ...change },
          {
            fetch: f.request,
            now,
          },
        )(f.expected, signal()),
      ).rejects.toMatchObject({ code: "configuration" });
    }
    const invalidPin = structuredClone(f.expected);
    invalidPin.deploymentObservation.eventhouseNativeDefinitionSetSha256 = "";
    await expect(
      createMiningNativeVerifier(invalidPin, env, { fetch: f.request, now })(invalidPin, signal()),
    ).rejects.toMatchObject({ code: "configuration" });
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each([
    { oid: clientId },
    { tid: clientId },
    { appid: principalId },
    { aud: "https://not-approved.example" },
    { exp: now() / 1000 + 1 },
    { nbf: now() / 1000 + 1 },
  ])("rejects mismatched token claims before sending them to any service: %j", async (claims) => {
    const f = fixture({ claims });
    await expect(f.verify(f.expected, signal())).rejects.toMatchObject({ code: "configuration" });
    expect(
      f.request.mock.calls.every(
        ([url]) =>
          String(url).endsWith("/v1/rest/auth/metadata") || String(url).startsWith("http://127."),
      ),
    ).toBe(true);
  });

  it.each([202, 302, 401, 403, 429, 500])(
    "fails closed on HTTP %s, without following operations or retrying",
    async (status) => {
      const f = fixture({ status });
      await expect(f.verify(f.expected, signal())).rejects.toMatchObject({ code: "upstream" });
      expect(f.request).toHaveBeenCalledTimes(6);
      expect(
        f.request.mock.calls.filter(([url]) => String(url).endsWith("/getDefinition")),
      ).toHaveLength(1);
    },
  );

  it("rejects foreign cloud metadata before requesting tokens", async () => {
    const f = fixture({
      metadata: { AzureAD: { ...metadata.AzureAD, KustoServiceResourceId: fabric } },
    });
    await expect(f.verify(f.expected, signal())).rejects.toMatchObject({ code: "configuration" });
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it.each([
    { id: clientId },
    { workspaceId: tenantId },
    { displayName: "ForeignDatabase" },
    { type: "Lakehouse" },
    { properties: { databaseType: "Shortcut", queryServiceUri: uri } },
    { properties: { databaseType: "ReadWrite", queryServiceUri: `${uri}/foreign` } },
  ])("rejects a native KQL item that no longer binds the exact target: %j", async (change) => {
    const f = fixture({ item: { ...databaseItem(), ...change } });
    await expect(f.verify(f.expected, signal())).rejects.toMatchObject({ code: "configuration" });
  });

  it("uses the independently pinned Eventhouse workspace, not the Eventstream workspace", async () => {
    const f = fixture({ item: { ...databaseItem(), workspaceId: tenantId } });
    const expected = expectations();
    expected.target.eventhouseWorkspaceId = tenantId;
    await createMiningNativeVerifier(expected, env, { fetch: f.request, now })(expected, signal());
    expect(
      f.request.mock.calls.some(
        ([url]) =>
          String(url) === `${fabric}/v1/workspaces/${tenantId}/kqlDatabases/${principalId}`,
      ),
    ).toBe(true);
  });

  it("rehashes all native parts and all script statements on every invocation", async () => {
    const stream = eventstream();
    const schema = database();
    const f = fixture({ stream, schema });
    await f.verify(f.expected, signal());
    stream.definition.parts[1].payload = Buffer.from('{"changed":true}').toString("base64");
    await expect(f.verify(f.expected, signal())).rejects.toThrow("drifted");
    stream.definition.parts[1].payload = eventstream().definition.parts[1].payload;
    schema.Tables[0].Rows[1] = [
      JSON.stringify({
        DatabaseSchemaScript: ".alter table MiningTelemetryRaw policy ingestiontime false",
      }),
    ];
    await expect(f.verify(f.expected, signal())).rejects.toThrow("drifted");
    expect(f.request).toHaveBeenCalledTimes(18);
  });

  it("captures protected expectations, environment and dependencies rather than mutable references", async () => {
    const f = fixture();
    const expected = expectations();
    const suppliedEnv = { ...env };
    const options = { fetch: f.request, now };
    const verify = createMiningNativeVerifier(expected, suppliedEnv, options);
    expected.target.workspaceId = tenantId;
    suppliedEnv.MINING_MANAGED_IDENTITY_CLIENT_ID = "";
    options.fetch = vi.fn();
    await verify(f.expected, signal());
    expect(f.request).toHaveBeenCalledTimes(6);
    expect(options.fetch).not.toHaveBeenCalled();
  });

  it("bounds native response bytes", async () => {
    const f = fixture({ stream: { padding: "x".repeat(1_048_576) } });
    await expect(f.verify(f.expected, signal())).rejects.toMatchObject({ code: "overflow" });
  });

  it("propagates cancellation and cancels sibling operations on upstream failure", async () => {
    const f = fixture();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(f.verify(f.expected, cancelled.signal)).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(f.request).not.toHaveBeenCalled();
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/v1/rest/mgmt")) {
        return new Promise<Response>((_, reject) => {
          init!.signal!.addEventListener("abort", () => reject(new Error("Sibling aborted")), {
            once: true,
          });
        });
      }
      return f.request(input, init);
    });
    const verify = createMiningNativeVerifier(f.expected, env, { fetch: request, now });
    const controller = new AbortController();
    const pending = verify(f.expected, controller.signal);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(6));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(request.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);

    const failure = fixture({ status: 403 });
    const siblingAborted = vi.fn();
    const failedRequest = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/v1/rest/mgmt")) {
        return new Promise<Response>((_, reject) => {
          init!.signal!.addEventListener(
            "abort",
            () => {
              siblingAborted();
              reject(new Error("Sibling aborted"));
            },
            { once: true },
          );
        });
      }
      return failure.request(input, init);
    });
    await expect(
      createMiningNativeVerifier(failure.expected, env, { fetch: failedRequest, now })(
        failure.expected,
        signal(),
      ),
    ).rejects.toMatchObject({
      code: "upstream",
    });
    expect(siblingAborted).toHaveBeenCalledTimes(1);
  });

  it("has one deadline across all native operations without retries", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn(
        (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_, reject) => {
            init!.signal!.addEventListener("abort", () => reject(new Error("Deadline")), {
              once: true,
            });
          }),
      );
      const expected = expectations();
      const pending = createMiningNativeVerifier(expected, env, { fetch: request, now })(
        expected,
        signal(),
      );
      const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(9000);
      await assertion;
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("native snapshot hash contracts", () => {
  it("makes part order irrelevant but retains exact part bytes and paths", () => {
    const original = eventstream();
    const reordered = eventstream();
    reordered.definition.parts.reverse();
    expect(hashMiningNativeEventstream(reordered)).toBe(hashMiningNativeEventstream(original));
    reordered.definition.parts.push({
      path: "extra.json",
      payloadType: "InlineBase64",
      payload: Buffer.from("{}").toString("base64"),
    });
    expect(hashMiningNativeEventstream(reordered)).not.toBe(hashMiningNativeEventstream(original));
  });

  it("rejects duplicate/missing/unsafe parts, invalid base64 and invalid topology JSON", () => {
    const original = eventstream();
    const parts = original.definition.parts;
    for (const invalidParts of [
      [],
      parts.slice(1),
      [...parts, parts[0]],
      [{ ...parts[0], path: "../eventstream.json" }],
      [{ ...parts[0], payload: "!!!" }],
      [{ ...parts[0], payloadType: "Foreign" }],
      [{ ...parts[0], payload: Buffer.from("broken").toString("base64") }],
    ])
      expect(() => hashMiningNativeEventstream({ definition: { parts: invalidParts } })).toThrow();
  });

  it("rejects missing completion, incorrect table contents, partial errors and malformed native rows", () => {
    const cases = [
      () => ({ ...database(), Exceptions: ["partial"] }),
      () => ({ Tables: database().Tables.slice(0, 3) }),
      () => ({ ...database(), Errors: ["partial"] }),
      () => {
        const v = database();
        v.Tables[2].Rows[0][1] = 2;
        return v;
      },
      () => {
        const v = database();
        v.Tables[2].Rows[0][1] = 3;
        return v;
      },
      () => {
        const v = database();
        v.Tables[2].Rows[0][3] = 1;
        return v;
      },
      () => {
        const v = database();
        v.Tables[2].Rows = [];
        return v;
      },
      () => {
        const v = database();
        v.Tables[3].Rows[0][1] = "QueryStatus";
        return v;
      },
      () => {
        const v = database();
        v.Tables[0].Rows = [];
        return v;
      },
      () => {
        const v = database();
        v.Tables[0].Rows[0] = ["not-json"];
        return v;
      },
      () => {
        const v = database();
        v.Tables[0].Columns[0].ColumnType = "long";
        return v;
      },
      () => {
        const v = database();
        v.Tables[0].Rows[0] = ['{"DatabaseSchemaScript":""}'];
        return v;
      },
    ];
    for (const change of cases) expect(() => hashMiningNativeDatabase(change())).toThrow();
  });
});
