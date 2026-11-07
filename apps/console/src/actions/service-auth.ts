/**
 * Console -> Streaming Backend service-to-service auth (replaces the earlier delegated
 * user-token-forwarding approach that lived in `forwarded-headers.ts`).
 *
 * Root cause of the earlier persistent 401s: forwarding the signed-in caller's own
 * `X-MS-TOKEN-AAD-ACCESS-TOKEN` required the Console's Easy Auth sign-in to actually acquire an
 * access token scoped to `api://<authClientId>/user_impersonation` (via `login.loginParameters`,
 * console.bicep) -- a scope that needs the token's audience/consent to line up exactly, is
 * unverifiable on Azure Container Apps (no `/.auth/me` support, see `auth-debug.ts`), and kept
 * failing even after a confirmed clean logout/login. Per explicit product direction ("use service
 * principals... no complex permission setup and user credentials needed here... simplicity for
 * demo"), this module replaces that entirely: the Console's own user-assigned managed identity
 * (already wired -- `AZURE_CLIENT_ID` env var, console.bicep) acquires its own app-only AAD token
 * for the shared app registration's audience and forwards THAT as the `Authorization: Bearer`
 * header. Because the target app registration has `appRoleAssignmentRequired: false` (confirmed
 * live via Graph, the tenant's default for a freshly-created single-tenant registration), this
 * app-only token is minted with zero additional Entra app-role/permission configuration -- the
 * Streaming Backend's Easy Auth sidecar (streaming-backend.bicep) validates it purely on
 * audience/issuer like any other token, and re-injects `X-MS-CLIENT-PRINCIPAL-ID` as the
 * managed identity's own service-principal object id. That id must be present in
 * `ATHLETE_PRINCIPAL_MAP` (apps/streaming-backend/src/auth/authorization.ts) mapped to the
 * seeded athlete for FR-017 authorization to still pass -- see
 * scripts/provision/provision-azure-resources.ps1's `athletePrincipalMap` construction.
 *
 * This intentionally drops per-user impersonation: with a single seeded athlete and the Console
 * itself as the only trusted operator surface for this demo, there is no meaningful benefit to
 * distinguishing which human triggered the action, so a simple app-only identity is sufficient
 * and removes an entire fragile auth path.
 */
import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";

export interface ServiceAuthOptions {
  /** The OAuth scope to request, e.g. `api://<authClientId>/.default`. Defaults to `STREAMING_BACKEND_SCOPE`. */
  scope?: string;
  /** Injectable for tests; defaults to `DefaultAzureCredential` (picks up the Console's user-assigned managed identity via `AZURE_CLIENT_ID` in Azure, or a developer's local `az login`/VS Code session otherwise). */
  credential?: TokenCredential;
}

interface CachedToken {
  token: string;
  expiresOnTimestamp: number;
}

let cachedToken: CachedToken | undefined;
let sharedCredential: TokenCredential | undefined;

function defaultScope(): string {
  const scope = process.env.STREAMING_BACKEND_SCOPE;
  if (!scope) {
    throw new Error(
      "STREAMING_BACKEND_SCOPE is not configured -- cannot acquire a service token for the Streaming Backend.",
    );
  }
  return scope;
}

/** Test-only hook: clears the cached token so tests can exercise acquisition per-case. */
export function resetServiceTokenCacheForTests(): void {
  cachedToken = undefined;
  sharedCredential = undefined;
}

/**
 * Acquires (and caches, refreshing 60s before expiry) an app-only AAD access token for `scope`
 * using the Console's managed identity. Reused across requests within the process to avoid a
 * token round-trip on every Console button click.
 */
export async function getServiceAccessToken(options: ServiceAuthOptions = {}): Promise<string> {
  const scope = options.scope ?? defaultScope();
  const now = Date.now();
  if (cachedToken && cachedToken.expiresOnTimestamp - 60_000 > now) {
    return cachedToken.token;
  }

  const credential = options.credential ?? (sharedCredential ??= new DefaultAzureCredential());
  const result = await credential.getToken(scope);
  if (!result) {
    throw new Error(`Failed to acquire a service access token for scope "${scope}".`);
  }

  cachedToken = { token: result.token, expiresOnTimestamp: result.expiresOnTimestamp };
  return result.token;
}

/**
 * Builds the headers for a Console -> Streaming Backend service-to-service call: JSON
 * content-type plus an `Authorization: Bearer` header carrying the Console managed identity's
 * own app-only access token.
 */
export async function buildServiceAuthHeaders(
  options: ServiceAuthOptions = {},
): Promise<Record<string, string>> {
  const token = await getServiceAccessToken(options);
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
}
