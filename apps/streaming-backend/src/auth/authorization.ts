/**
 * FR-017 authorization middleware (contracts/streaming-backend-api.md's "Authorization"
 * section). Every Streaming Backend endpoint takes an `athleteId` (path or body) that MUST
 * NOT be trusted on its own -- this module resolves the Easy-Auth-authenticated caller's
 * authorized athleteId(s) and rejects any request whose `athleteId` doesn't match, with
 * `403 Forbidden` and no partial reads/side effects.
 *
 * Identity source: Azure Container Apps built-in auth ("Easy Auth", ADR-004) injects
 * `X-MS-CLIENT-PRINCIPAL-ID` (the caller's Entra object id) on every proxied request once
 * Easy Auth is configured on the Container App, plus a base64-JSON `X-MS-CLIENT-PRINCIPAL`
 * header carrying the full claims set. This module reads the object id from either header
 * (falling back to decoding the JSON principal if the dedicated id header is absent, e.g.
 * during local `tsx watch` development against a simulated principal).
 *
 * Principal -> athlete mapping: data-model.md's single seeded Athlete (FR-001) has no
 * `principalId` column yet (multi-athlete support, SC-007, is schema-scale-ready but not
 * implemented). Per the contract's "a claim or a principal->athlete mapping maintained
 * alongside the Athlete entity", this module resolves the mapping from the
 * `ATHLETE_PRINCIPAL_MAP` environment variable -- a JSON object of
 * `{ "<entraPrincipalObjectId>": "<athleteId>" }` pairs, populated at deploy time (Container
 * App env var, sourced from Key Vault) once the single seeded athlete's owning principal is
 * known. When multiple athletes are introduced, replace this env-var mapping with a real
 * Athlete.principalId lookup against the Lakehouse/DTB without changing this module's public
 * contract (`resolveAuthorizedAthleteId` / `requireAthleteAuthorization`).
 */
import type { NextFunction, Request, Response } from "express";

const PRINCIPAL_ID_HEADER = "x-ms-client-principal-id";
const PRINCIPAL_HEADER = "x-ms-client-principal";

export interface ForbiddenErrorBody {
  error: {
    code: "forbidden";
    message: "Not authorized for this athlete.";
  };
}

export function forbiddenBody(): ForbiddenErrorBody {
  return {
    error: {
      code: "forbidden",
      message: "Not authorized for this athlete.",
    },
  };
}

/**
 * Decodes the Easy-Auth `X-MS-CLIENT-PRINCIPAL` header (base64-encoded JSON with a `claims`
 * array) and extracts the caller's object id (`http://schemas.microsoft.com/identity/claims/objectidentifier`
 * or the shorter `oid` claim type, depending on token version). Returns `undefined` if the
 * header is absent or malformed -- never throws, so a missing/bad header degrades to "no
 * authorized athlete" (403) rather than a 500.
 */
function decodePrincipalObjectId(headerValue: string | undefined): string | undefined {
  if (!headerValue) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(headerValue, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded) as {
      claims?: Array<{ typ?: string; val?: string }>;
    };
    const claim = parsed.claims?.find(
      (c) =>
        c.typ === "http://schemas.microsoft.com/identity/claims/objectidentifier" ||
        c.typ === "oid",
    );
    return claim?.val;
  } catch {
    return undefined;
  }
}

function getHeaderValue(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Resolves the Entra object id of the authenticated caller from Easy-Auth-injected headers.
 * Prefers the dedicated `X-MS-CLIENT-PRINCIPAL-ID` header (present whenever Easy Auth is
 * configured); falls back to decoding `X-MS-CLIENT-PRINCIPAL` for environments where only
 * the full principal header is set.
 */
export function resolveCallerPrincipalId(req: Request): string | undefined {
  const directId = getHeaderValue(req, PRINCIPAL_ID_HEADER);
  if (directId) {
    return directId;
  }
  return decodePrincipalObjectId(getHeaderValue(req, PRINCIPAL_HEADER));
}

let cachedPrincipalAthleteMap: Record<string, string> | undefined;

/**
 * Parses `ATHLETE_PRINCIPAL_MAP` once and caches the result for the process lifetime (the
 * env var is only set at container startup, never mutated at runtime). Returns an empty
 * object (never throws) if the variable is absent or malformed, so a misconfiguration fails
 * closed (every request is unauthorized) rather than crashing the process.
 */
function getPrincipalAthleteMap(): Record<string, string> {
  if (cachedPrincipalAthleteMap) {
    return cachedPrincipalAthleteMap;
  }
  const raw = process.env.ATHLETE_PRINCIPAL_MAP;
  if (!raw) {
    cachedPrincipalAthleteMap = {};
    return cachedPrincipalAthleteMap;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    cachedPrincipalAthleteMap =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, string>)
        : {};
  } catch {
    cachedPrincipalAthleteMap = {};
  }
  return cachedPrincipalAthleteMap;
}

/** Test-only hook: clears the cached map so tests can set `ATHLETE_PRINCIPAL_MAP` per-case. */
export function resetPrincipalAthleteMapCacheForTests(): void {
  cachedPrincipalAthleteMap = undefined;
}

/**
 * Resolves the athleteId the caller of `req` is authorized for, or `undefined` if the caller
 * has no principal (unauthenticated) or no mapped athlete.
 */
export function resolveAuthorizedAthleteId(req: Request): string | undefined {
  const principalId = resolveCallerPrincipalId(req);
  if (!principalId) {
    return undefined;
  }
  return getPrincipalAthleteMap()[principalId];
}

/**
 * Resolves the athleteId authorized for an already-verified Entra object id, using the
 * exact same `ATHLETE_PRINCIPAL_MAP` as `resolveAuthorizedAthleteId`. For callers on routes
 * that establish trust some other way than Easy-Auth-injected headers (e.g. `/api/assistant
 * /mcp`'s self-verified JWT check in `mcp-caller.ts`, needed because that route is excluded
 * from Easy Auth -- see that module's docstring) but still must resolve authorization
 * through the same explicit allowlist, never a different or broader one.
 */
export function resolveAuthorizedAthleteIdForPrincipal(
  principalId: string | undefined,
): string | undefined {
  if (!principalId) {
    return undefined;
  }
  return getPrincipalAthleteMap()[principalId];
}

/**
 * Express middleware factory enforcing FR-017 for a single endpoint. `getRequestedAthleteId`
 * extracts the caller-supplied `athleteId` from the request (path param or body field, which
 * differs per endpoint per the contract). On mismatch (including "no authorized athlete at
 * all"), responds `403 Forbidden` with the exact contract error body and does not call
 * `next()` -- no downstream handler code runs, satisfying "no partial reads, no side effects".
 */
export function requireAthleteAuthorization(
  getRequestedAthleteId: (req: Request) => string | undefined,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestedAthleteId = getRequestedAthleteId(req);
    const authorizedAthleteId = resolveAuthorizedAthleteId(req);

    if (!requestedAthleteId || requestedAthleteId !== authorizedAthleteId) {
      res.status(403).json(forbiddenBody());
      return;
    }

    next();
  };
}
