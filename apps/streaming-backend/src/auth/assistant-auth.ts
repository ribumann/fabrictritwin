import type { Request } from "express";
import { resolveCallerPrincipalId } from "./authorization.js";

export interface AssistantUserContext {
  principalId: string;
  tenantId: string;
  userAssertionToken: string;
}

type AssistantAuthCode =
  | "assistant_authentication_required"
  | "assistant_token_expired"
  | "assistant_interaction_required"
  | "assistant_access_denied"
  | "assistant_auth_configuration_error";

const messages: Record<AssistantAuthCode, string> = {
  assistant_authentication_required: "Sign in to use Athlete Assistant with your Fabric permissions.",
  assistant_token_expired: "Your sign-in needs to be refreshed.",
  assistant_interaction_required: "Sign in again to complete the authentication or consent required by Fabric.",
  assistant_access_denied: "Your account does not have the required Assistant or Fabric access.",
  assistant_auth_configuration_error: "Assistant authentication is not configured correctly. Contact the demo operator.",
};

export class AssistantAuthError extends Error {
  constructor(
    public readonly code: AssistantAuthCode,
    public readonly status: 401 | 403 | 503,
    public readonly claimsChallenge?: string,
  ) {
    super(messages[code]);
    this.name = "AssistantAuthError";
  }

  get authenticateHeader(): string | undefined {
    if (!this.claimsChallenge || this.claimsChallenge.length > 8192) {
      return undefined;
    }
    return `Bearer error="insufficient_claims", claims="${Buffer.from(this.claimsChallenge).toString("base64")}"`;
  }

  toBody() {
    return {
      error: {
        code: this.code,
        message: this.message,
        canRefresh: this.code === "assistant_token_expired",
      },
    };
  }
}

export function assistantAuthSetting(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new AssistantAuthError("assistant_auth_configuration_error", 503);
  }
  return value;
}

function readAssertion(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (token.length > 16_384 || parts.length !== 3 || parts.some((part) => !part)) {
    throw new AssistantAuthError("assistant_authentication_required", 401);
  }
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (typeof claims === "object" && claims !== null && !Array.isArray(claims)) {
      return claims as Record<string, unknown>;
    }
  } catch {
    throw new AssistantAuthError("assistant_authentication_required", 401);
  }
  throw new AssistantAuthError("assistant_authentication_required", 401);
}

/**
 * Non-throwing best-effort decode used only to distinguish "no human sign-in was attempted"
 * from "a human sign-in attempt was made and failed". Returns `undefined` for anything that
 * doesn't parse -- callers must not treat that as a trust decision on its own.
 */
function tryDecodeClaims(authorization: string | undefined): Record<string, unknown> | undefined {
  if (!authorization?.startsWith("Bearer ")) {
    return undefined;
  }
  const parts = authorization.slice(7).split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    return undefined;
  }
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof claims === "object" && claims !== null && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when the caller presented no bearer assertion at all, or one already shaped like an
 * app-only/service token -- i.e. NOT an attempted human sign-in. Two independent signals are
 * checked because Microsoft Entra ID does not reliably emit the `idtyp` claim for app-only
 * (client credentials) tokens issued against arbitrary custom API audiences -- it is
 * documented as present only "if emitted", and was observed absent on live managed-identity
 * tokens acquired for this API's own App ID URI during testing. The v2.0 OAuth2 contract is
 * more reliable: every delegated/user (OBO) token this API accepts MUST carry a `scp` claim
 * containing `user_impersonation` (enforced below in `requireAssistantUser`), while app-only
 * tokens never carry `scp` at all. So a successfully-decoded token with `idtyp: "app"` OR no
 * `scp` claim is treated as a service/managed-identity caller (e.g. the Cockpit's own MI
 * calling on behalf of an anonymous demo visitor).
 *
 * Used by the `/ask` route (assistant.ts) to decide whether to require and validate a human
 * OBO assertion (mandatory for the native Fabric Data Agent tool -- Microsoft's platform
 * restricts that tool to user identity and does not support service principals) or to proceed
 * in MI-only mode (MCP tools only), relying on the FR-017 authorization already enforced by
 * `requireAthleteAuthorization` for both human and service callers alike. A bearer that IS
 * present but fails to parse cleanly is deliberately NOT treated as anonymous here -- it falls
 * through to `requireAssistantUser`, which raises an explicit auth error rather than silently
 * downgrading a bad human attempt to anonymous access.
 */
export function isServiceOrAnonymousCaller(req: Request): boolean {
  const authorization = req.get("authorization");
  if (!authorization) {
    return true;
  }
  const claims = tryDecodeClaims(authorization);
  if (!claims) {
    // Present but unparseable -- a failed human attempt, not anonymous. Let
    // requireAssistantUser surface the explicit error.
    return false;
  }
  return claims.idtyp === "app" || typeof claims.scp !== "string";
}

// EasyAuth validates the signature before injecting the principal. OBO also validates the
// assertion before any Foundry call. These checks bind that assertion to the same human
// and to our own API; they are not a replacement for the platform authentication boundary.
export function requireAssistantUser(req: Request): AssistantUserContext {
  const authorization = req.get("authorization");
  const principalId = resolveCallerPrincipalId(req);
  if (!authorization?.startsWith("Bearer ") || !principalId) {
    throw new AssistantAuthError("assistant_authentication_required", 401);
  }
  const userAssertionToken = authorization.slice(7);
  const claims = readAssertion(userAssertionToken);
  const tenantId = assistantAuthSetting("ASSISTANT_AUTH_TENANT_ID");
  const clientId = assistantAuthSetting("ASSISTANT_AUTH_CLIENT_ID");
  const allowedClientId = assistantAuthSetting("ASSISTANT_AUTH_ALLOWED_CLIENT_ID");
  if (
    claims.tid !== tenantId ||
    claims.iss !== `https://login.microsoftonline.com/${tenantId}/v2.0` ||
    (claims.aud !== clientId && claims.aud !== `api://${clientId}`) ||
    claims.azp !== allowedClientId ||
    claims.oid !== principalId ||
    claims.idtyp === "app" ||
    typeof claims.scp !== "string" ||
    !claims.scp.split(" ").includes("user_impersonation") ||
    typeof claims.exp !== "number" ||
    !Number.isFinite(claims.exp)
  ) {
    throw new AssistantAuthError("assistant_authentication_required", 401);
  }
  if (claims.exp * 1000 <= Date.now() + 30_000) {
    throw new AssistantAuthError("assistant_token_expired", 401);
  }
  if (typeof claims.nbf === "number" && claims.nbf * 1000 > Date.now() + 30_000) {
    throw new AssistantAuthError("assistant_authentication_required", 401);
  }
  return { principalId, tenantId, userAssertionToken };
}
