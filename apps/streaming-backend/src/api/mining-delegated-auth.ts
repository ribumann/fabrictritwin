import type { JWTPayload } from "jose";

interface DelegatedOperatorClaimsOptions {
  claims: JWTPayload;
  operators: readonly string[];
  tenantId: string;
  scope: string;
}

export function hasApprovedDelegatedOperatorClaims({
  claims,
  operators,
  tenantId,
  scope,
}: DelegatedOperatorClaimsOptions): boolean {
  if (typeof claims.oid !== "string" || !operators.includes(claims.oid)) return false;
  if (claims.tid !== tenantId) return false;
  if (!Number.isSafeInteger(claims.exp)) return false;
  if (claims.idtyp !== undefined && claims.idtyp !== "user") return false;
  if (typeof claims.scp !== "string") return false;
  return claims.scp.split(/\s+/).includes(scope);
}
