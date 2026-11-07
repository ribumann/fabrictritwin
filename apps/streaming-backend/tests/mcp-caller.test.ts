import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetMcpCallerJwksCacheForTests,
  verifyMcpCallerPrincipalId,
} from "../src/auth/mcp-caller.js";

const TENANT_ID = "44444444-4444-4444-4444-444444444444";
const CLIENT_ID = "55555555-5555-5555-5555-555555555555";
const OID = "92f05f07-f5e2-4f1d-b7d8-14146c55a4ec";
const KID = "test-key-1";

function fakeRequest(authorization?: string) {
  return { get: (name: string) => (name.toLowerCase() === "authorization" ? authorization : undefined) } as never;
}

describe("verifyMcpCallerPrincipalId", () => {
  let privateKey: CryptoKey;
  let jwks: { keys: unknown[] };

  beforeEach(async () => {
    const keyPair = await generateKeyPair("RS256");
    privateKey = keyPair.privateKey;
    const publicJwk = await exportJWK(keyPair.publicKey);
    jwks = { keys: [{ ...publicJwk, kid: KID, use: "sig", alg: "RS256" }] };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(jwks), { status: 200, headers: { "content-type": "application/json" } })),
    );
    vi.stubEnv("ASSISTANT_AUTH_TENANT_ID", TENANT_ID);
    vi.stubEnv("ASSISTANT_AUTH_CLIENT_ID", CLIENT_ID);
    resetMcpCallerJwksCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetMcpCallerJwksCacheForTests();
  });

  async function signToken(overrides: Record<string, unknown> = {}): Promise<string> {
    const claims: Record<string, unknown> = {
      oid: OID,
      azp: "b6e1241d-de7c-4cd4-a290-c63b07d0788c",
      ...overrides,
    };
    const builder = new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuedAt()
      .setIssuer(`https://login.microsoftonline.com/${TENANT_ID}/v2.0`)
      .setAudience(CLIENT_ID)
      .setExpirationTime("1h");
    return builder.sign(privateKey);
  }

  it("returns the oid claim for a validly signed, correctly issued/audienced token", async () => {
    const token = await signToken();
    const result = await verifyMcpCallerPrincipalId(fakeRequest(`Bearer ${token}`));
    expect(result).toBe(OID);
  });

  it("accepts the api://<clientId> audience form too", async () => {
    const claims = { oid: OID };
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuedAt()
      .setIssuer(`https://login.microsoftonline.com/${TENANT_ID}/v2.0`)
      .setAudience(`api://${CLIENT_ID}`)
      .setExpirationTime("1h")
      .sign(privateKey);
    const result = await verifyMcpCallerPrincipalId(fakeRequest(`Bearer ${token}`));
    expect(result).toBe(OID);
  });

  it("returns undefined when there is no bearer token", async () => {
    expect(await verifyMcpCallerPrincipalId(fakeRequest(undefined))).toBeUndefined();
    expect(await verifyMcpCallerPrincipalId(fakeRequest("Basic abc123"))).toBeUndefined();
  });

  it("returns undefined for a wrong-issuer token", async () => {
    const token = await new SignJWT({ oid: OID })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuedAt()
      .setIssuer("https://login.microsoftonline.com/wrong-tenant/v2.0")
      .setAudience(CLIENT_ID)
      .setExpirationTime("1h")
      .sign(privateKey);
    expect(await verifyMcpCallerPrincipalId(fakeRequest(`Bearer ${token}`))).toBeUndefined();
  });

  it("returns undefined for a wrong-audience token", async () => {
    const token = await new SignJWT({ oid: OID })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuedAt()
      .setIssuer(`https://login.microsoftonline.com/${TENANT_ID}/v2.0`)
      .setAudience("00000000-0000-0000-0000-000000000000")
      .setExpirationTime("1h")
      .sign(privateKey);
    expect(await verifyMcpCallerPrincipalId(fakeRequest(`Bearer ${token}`))).toBeUndefined();
  });

  it("returns undefined for an expired token", async () => {
    const token = await new SignJWT({ oid: OID })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setIssuer(`https://login.microsoftonline.com/${TENANT_ID}/v2.0`)
      .setAudience(CLIENT_ID)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(privateKey);
    expect(await verifyMcpCallerPrincipalId(fakeRequest(`Bearer ${token}`))).toBeUndefined();
  });

  it("returns undefined for a token signed by a different (untrusted) key", async () => {
    const otherKeyPair = await generateKeyPair("RS256");
    const token = await new SignJWT({ oid: OID })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuedAt()
      .setIssuer(`https://login.microsoftonline.com/${TENANT_ID}/v2.0`)
      .setAudience(CLIENT_ID)
      .setExpirationTime("1h")
      .sign(otherKeyPair.privateKey);
    expect(await verifyMcpCallerPrincipalId(fakeRequest(`Bearer ${token}`))).toBeUndefined();
  });

  it("returns undefined when the token has no oid claim", async () => {
    const token = await new SignJWT({ sub: "no-oid-here" })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuedAt()
      .setIssuer(`https://login.microsoftonline.com/${TENANT_ID}/v2.0`)
      .setAudience(CLIENT_ID)
      .setExpirationTime("1h")
      .sign(privateKey);
    expect(await verifyMcpCallerPrincipalId(fakeRequest(`Bearer ${token}`))).toBeUndefined();
  });

  it("returns undefined when required configuration is missing", async () => {
    vi.stubEnv("ASSISTANT_AUTH_TENANT_ID", "");
    const token = await signToken();
    expect(await verifyMcpCallerPrincipalId(fakeRequest(`Bearer ${token}`))).toBeUndefined();
  });
});
