
import type { Request, Response } from "express";
import { getHeaderValue } from "./forwarded-headers.js";

const PRINCIPAL_ID_HEADER = "x-ms-client-principal-id";
const PRINCIPAL_HEADER = "x-ms-client-principal";
const ACCESS_TOKEN_HEADER = "x-ms-token-aad-access-token";
const ID_TOKEN_HEADER = "x-ms-token-aad-id-token";

/** Decodes a JWT's middle segment (payload) without verifying the signature -- diagnostic only. */
function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return undefined;
  }
  try {
    const payload = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function createAuthDebugAction() {
  return (req: Request, res: Response): void => {
    const principalId = getHeaderValue(req, PRINCIPAL_ID_HEADER);
    const principal = getHeaderValue(req, PRINCIPAL_HEADER);
    const accessToken = getHeaderValue(req, ACCESS_TOKEN_HEADER);
    const idToken = getHeaderValue(req, ID_TOKEN_HEADER);
    const accessTokenClaims = accessToken ? decodeJwtPayload(accessToken) : undefined;

    res.status(200).json({
      hasPrincipalIdHeader: Boolean(principalId),
      hasPrincipalHeader: Boolean(principal),
      hasAccessTokenHeader: Boolean(accessToken),
      hasIdTokenHeader: Boolean(idToken),
      accessTokenLength: accessToken?.length ?? 0,
      // aud/scp tell us whether the token was actually issued for the Streaming Backend's
      // expected audience/scope -- the two things that determine whether the forwarded call
      // will pass or fail Easy Auth validation on the other side.
      accessTokenAudience: accessTokenClaims?.aud ?? null,
      accessTokenScopes: accessTokenClaims?.scp ?? null,
      accessTokenAppId: accessTokenClaims?.appid ?? accessTokenClaims?.azp ?? null,
      accessTokenExpiresAt:
        typeof accessTokenClaims?.exp === "number"
          ? new Date(accessTokenClaims.exp * 1000).toISOString()
          : null,
    });
  };
}
