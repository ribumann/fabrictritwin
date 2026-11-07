/**
 * Shared helper for reading Easy-Auth-injected headers off an inbound Express request.
 * Used by `auth-debug.ts` (diagnostic endpoint) to report which headers Easy Auth actually set
 * on the current request.
 *
 * NOTE: this module previously also built the Console -> Streaming Backend outbound headers by
 * forwarding the caller's own `X-MS-TOKEN-AAD-ACCESS-TOKEN` (delegated user-token forwarding).
 * That approach was replaced by `service-auth.ts` (app-only managed-identity token), per explicit
 * product direction to avoid delegated-permission complexity for this demo -- see that module's
 * doc comment for the full rationale.
 */
import type { Request } from "express";

export function getHeaderValue(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
