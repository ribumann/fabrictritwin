import type { Request } from "express";

export class AssistantSignInError extends Error {
  constructor(
    public readonly code: "assistant_authentication_required" | "assistant_token_expired" | "assistant_auth_configuration_error",
    public readonly status: 401 | 503,
  ) {
    super(code === "assistant_auth_configuration_error"
      ? "Assistant authentication is not configured correctly. Contact the demo operator."
      : "Sign in to use Athlete Assistant with your Fabric permissions.");
    this.name = "AssistantSignInError";
  }
}

export function buildAssistantUserHeaders(req: Request): Record<string, string> {
  const token = req.get("x-ms-token-aad-access-token");
  const principalId = req.get("x-ms-client-principal-id");
  if (!token || !principalId) {
    throw new AssistantSignInError("assistant_authentication_required", 401);
  }
  const clientId = process.env.ASSISTANT_AUTH_BACKEND_CLIENT_ID?.trim();
  const tenantId = process.env.ASSISTANT_AUTH_TENANT_ID?.trim();
  if (!clientId || !tenantId) {
    throw new AssistantSignInError("assistant_auth_configuration_error", 503);
  }

  // This token belongs to our backend API, not a Microsoft-owned resource. Inspect only
  // to prevent accidental relay to the wrong audience; backend EasyAuth/OBO validates it.
  let claims: Record<string, unknown>;
  try {
    const parts = token.split(".");
    const parsed: unknown = parts.length === 3 && token.length <= 16_384
      ? JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
      : undefined;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid access token");
    }
    claims = parsed as Record<string, unknown>;
  } catch {
    throw new AssistantSignInError("assistant_authentication_required", 401);
  }
  if (
    claims.tid !== tenantId ||
    claims.oid !== principalId ||
    (claims.aud !== clientId && claims.aud !== `api://${clientId}`) ||
    typeof claims.exp !== "number" ||
    !Number.isFinite(claims.exp)
  ) {
    throw new AssistantSignInError("assistant_authentication_required", 401);
  }
  if (claims.exp * 1000 <= Date.now() + 60_000) {
    throw new AssistantSignInError("assistant_token_expired", 401);
  }
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}
