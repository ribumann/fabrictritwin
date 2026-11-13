import {
  createRemoteJWKSet,
  customFetch,
  errors,
  jwksCache,
  jwtVerify,
  type JWKSCacheInput,
  type JWTPayload,
} from "jose";
import type { Request } from "express";

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let cachedJwksTenantId: string | undefined;
let miningJwksCache: JWKSCacheInput = {};
let miningJwksTenantId: string | undefined;

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
  miningJwksCache = {};
  miningJwksTenantId = undefined;
}

function getCancellableJwks(tenantId: string, signal: AbortSignal) {
  if (miningJwksTenantId !== tenantId) {
    miningJwksCache = {};
    miningJwksTenantId = tenantId;
  }
  return createRemoteJWKSet(
    new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`),
    {
      [jwksCache]: miningJwksCache,
      [customFetch]: async (url, options) => {
        const response = await fetch(url, {
          ...options,
          signal: AbortSignal.any([signal, options.signal]),
        });
        if (response.status !== 200 || !response.body) {
          await response.body?.cancel();
          throw new Error("Identity provider key response is unavailable.");
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > 1_048_576) throw new Error("Identity provider key response is too large.");
            chunks.push(value);
          }
        } catch (error) {
          await reader.cancel();
          throw error;
        } finally {
          reader.releaseLock();
        }
        return new Response(Buffer.concat(chunks), { status: 200 });
      },
    },
  );
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
  try {
    return await verifyMcpCallerPrincipalIdWithErrors(req);
  } catch {
    return undefined;
  }
}

/** Reject invalid tokens while preserving identity-provider and transport failures. */
export async function verifyMcpCallerPrincipalIdWithErrors(
  req: Request,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const payload = await verifyMcpCallerClaimsWithErrors(req, signal);
  return typeof payload?.oid === "string" ? payload.oid : undefined;
}

/** Returns only signature/issuer/audience-verified claims; action callers must authorize scope and subject. */
export async function verifyMcpCallerClaimsWithErrors(
  req: Request,
  signal?: AbortSignal,
  configuration: NodeJS.ProcessEnv = process.env,
): Promise<JWTPayload | undefined> {
  signal?.throwIfAborted();
  const authorization = req.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return undefined;
  }

  const tenantId = configuration.ASSISTANT_AUTH_TENANT_ID?.trim();
  const clientId = configuration.ASSISTANT_AUTH_CLIENT_ID?.trim();
  if (!tenantId || !clientId) {
    return undefined;
  }

  const token = authorization.slice(7);
  try {
    const { payload } = await jwtVerify(
      token,
      signal ? getCancellableJwks(tenantId, signal) : getJwks(tenantId),
      {
        issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
        audience: [clientId, `api://${clientId}`],
      },
    );
    signal?.throwIfAborted();
    return payload;
  } catch (error) {
    if (
      error instanceof errors.JWTClaimValidationFailed ||
      error instanceof errors.JWTExpired ||
      error instanceof errors.JWTInvalid ||
      error instanceof errors.JWSInvalid ||
      error instanceof errors.JWSSignatureVerificationFailed ||
      error instanceof errors.JWKSNoMatchingKey ||
      error instanceof errors.JOSEAlgNotAllowed ||
      error instanceof errors.JOSENotSupported
    ) {
      return undefined;
    }
    throw error;
  }
}
