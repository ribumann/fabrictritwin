import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";

export interface ServiceAuthOptions {
  scope?: string;
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

export function resetServiceTokenCacheForTests(): void {
  cachedToken = undefined;
  sharedCredential = undefined;
}

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

export async function buildServiceAuthHeaders(
  options: ServiceAuthOptions = {},
): Promise<Record<string, string>> {
  const token = await getServiceAccessToken(options);
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
}
