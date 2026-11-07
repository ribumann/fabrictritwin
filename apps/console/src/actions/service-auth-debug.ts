/**
 * Diagnostic-only action for troubleshooting the Console -> Streaming Backend service-to-service
 * call (see `service-auth.ts`). Acquires the Console managed identity's own app-only access token
 * *without* forwarding it anywhere, and reports its decoded claims -- audience, app id, issuer --
 * so a live 403/401 from the Streaming Backend can be diagnosed (wrong audience? wrong calling
 * app id? token acquisition itself failing?) without needing a working service-to-service call
 * first. Never exposes the raw token, only decoded claim values, matching `auth-debug.ts`'s
 * "safe to leave mounted" posture.
 */
import type { Request, Response } from "express";
import { getServiceAccessToken } from "./service-auth.js";

/** Decodes a JWT's middle segment (payload) without verifying the signature -- diagnostic only. */
function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return undefined;
  }
  try {
    const payload = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export interface ServiceAuthDebugOptions {
  /** Injectable token getter for tests; defaults to `getServiceAccessToken`. */
  getToken?: () => Promise<string>;
}

export function createServiceAuthDebugAction(options: ServiceAuthDebugOptions = {}) {
  const getToken = options.getToken ?? getServiceAccessToken;
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      const token = await getToken();
      const claims = decodeJwtPayload(token);
      res.status(200).json({
        acquired: true,
        audience: claims?.aud ?? null,
        appId: claims?.appid ?? claims?.azp ?? null,
        objectId: claims?.oid ?? null,
        issuer: claims?.iss ?? null,
        tokenVersion: claims?.ver ?? null,
        idtyp: claims?.idtyp ?? null,
        roles: claims?.roles ?? null,
        scopes: claims?.scp ?? null,
        expiresAt:
          typeof claims?.exp === "number"
            ? new Date((claims.exp as number) * 1000).toISOString()
            : null,
      });
    } catch (error) {
      res.status(500).json({
        acquired: false,
        error: error instanceof Error ? error.message : "Failed to acquire service access token.",
      });
    }
  };
}
