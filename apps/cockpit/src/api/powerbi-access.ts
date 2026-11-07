import type { Request } from "express";
import type { PowerBiConfig } from "../services/powerbi.js";

interface Principal {
  auth_typ?: unknown;
  claims?: unknown;
}

/**
 * True only when the visitor presented no EasyAuth-injected identity headers at all. Cockpit's
 * ingress runs `AllowAnonymous`, so unauthenticated page loads reach this route with none of
 * these headers set. Anything else -- headers present but the principal turns out malformed,
 * wrong-tenant, or not on the allowlist -- is a failed/insufficient human sign-in attempt and
 * must surface an explicit 401/403, never be silently downgraded to the MI-mode fallback below
 * (mirrors the identical anonymous/human split used for the Athlete Assistant's own MI-mode
 * fallback in api/assistant.ts).
 */
export function isAnonymousVisitor(req: Request): boolean {
  return !req.get("x-ms-client-principal") && !req.get("x-ms-client-principal-id");
}

// Trust these headers only behind enforced Azure EasyAuth; there is no local bypass.
export function powerBiCaller(req: Request): { objectId: string; tenantId: string } | undefined {
  const header = req.get("x-ms-client-principal");
  if (!header || header.length > 32_768) return undefined;
  let principal: Principal;
  try {
    principal = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Principal;
  } catch {
    return undefined;
  }
  if (!principal || principal.auth_typ !== "aad" || !Array.isArray(principal.claims)) return undefined;
  const claims = principal.claims.filter((claim): claim is { typ: string; val: string } =>
    typeof claim === "object" && claim !== null &&
    typeof claim.typ === "string" && typeof claim.val === "string");
  function claimValue(types: string[]) {
    const values = new Set(claims.filter((claim) => types.includes(claim.typ)).map((claim) => claim.val.toLowerCase()));
    return values.size === 1 ? [...values][0] : undefined;
  }
  const objectId = claimValue(["oid", "http://schemas.microsoft.com/identity/claims/objectidentifier"]);
  const tenantId = claimValue(["tid", "http://schemas.microsoft.com/identity/claims/tenantid"]);
  const directId = req.get("x-ms-client-principal-id")?.toLowerCase();
  if (!objectId || !tenantId || (directId && directId !== objectId)) return undefined;
  return { objectId, tenantId };
}

export function canViewPowerBi(caller: { objectId: string; tenantId: string }, config: PowerBiConfig): boolean {
  return caller.tenantId === config.tenantId.toLowerCase() &&
    config.allowedPrincipalIds.includes(caller.objectId);
}
