
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Request } from "express";

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let cachedJwksTenantId: string | undefined;

function getJwks(tenantId: string): ReturnType<typeof createRemoteJWKSet> {
  if (!cachedJwks || cachedJwksTenantId !== tenantId) {
    cachedJwks = createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`),
    );
    cachedJwksTenantId = tenantId;
  }
  return cachedJwks;
}

/** Test-only hook: clears the cached JWKS client so tests can swap tenants/mocks per-case. */
export function resetMcpCallerJwksCacheForTests(): void {
  cachedJwks = undefined;
  cachedJwksTenantId = undefined;
}

/**
 * Verifies the request's bearer token's signature, issuer, and audience against this API's
 * own Easy-Auth configuration (`ASSISTANT_AUTH_TENANT_ID` / `ASSISTANT_AUTH_CLIENT_ID` --
 * the same settings `assistant-auth.ts` uses for `/ask`), and returns the token's `oid`
 * (Entra object id) claim on success. Returns `undefined` for any failure -- missing
 * bearer, malformed/expired/wrong-signature token, issuer/audience mismatch, or missing
 * configuration -- so callers fail closed to "not authorized" rather than throwing.
 */
export async function verifyMcpCallerPrincipalId(req: Request): Promise<string | undefined> {
  const authorization = req.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return undefined;
  }

  const tenantId = process.env.ASSISTANT_AUTH_TENANT_ID?.trim();
  const clientId = process.env.ASSISTANT_AUTH_CLIENT_ID?.trim();
  if (!tenantId || !clientId) {
    return undefined;
  }

  const token = authorization.slice(7);
  try {
    const { payload } = await jwtVerify(token, getJwks(tenantId), {
      issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      audience: [clientId, `api://${clientId}`],
    });
    return typeof payload.oid === "string" ? payload.oid : undefined;
  } catch {
    return undefined;
  }
}
