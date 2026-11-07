import { ClientSecretCredential, type TokenCredential } from "@azure/identity";

const API = "https://api.powerbi.com/v1.0/myorg";
const SCOPE = "https://analysis.windows.net/powerbi/api/.default";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RENEW_BEFORE_MS = 180_000;

export class PowerBiError extends Error {
  constructor(
    public readonly code:
      | "not-configured"
      | "identity-unavailable"
      | "upstream-failed"
      | "report-mismatch"
      | "unsupported-model",
  ) {
    super(code);
  }
}

export interface PowerBiConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  workspaceId: string;
  reportId: string;
  datasetId: string;
  allowedPrincipalIds: string[];
}

export interface PowerBiEmbedConfig {
  status: "ready";
  workspaceId: string;
  reportId: string;
  datasetId: string;
  embedUrl: string;
  accessToken: string;
  tokenType: "Embed";
  expiration: string;
}

export function readPowerBiConfig(env: NodeJS.ProcessEnv = process.env): PowerBiConfig {
  const config = {
    tenantId: env.POWERBI_TENANT_ID?.trim().toLowerCase() ?? "",
    clientId: env.POWERBI_CLIENT_ID?.trim().toLowerCase() ?? "",
    clientSecret: env.POWERBI_CLIENT_SECRET ?? "",
    workspaceId: env.POWERBI_WORKSPACE_ID?.trim().toLowerCase() ?? "",
    reportId: env.POWERBI_REPORT_ID?.trim().toLowerCase() ?? "",
    datasetId: env.POWERBI_SEMANTIC_MODEL_ID?.trim().toLowerCase() ?? "",
    allowedPrincipalIds: (env.POWERBI_ALLOWED_PRINCIPAL_IDS ?? "")
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean),
  };
  if (
    !config.clientSecret ||
    !config.allowedPrincipalIds.length ||
    [
      config.tenantId,
      config.clientId,
      config.workspaceId,
      config.reportId,
      config.datasetId,
      ...config.allowedPrincipalIds,
    ].some((id) => !GUID.test(id))
  ) {
    throw new PowerBiError("not-configured");
  }
  return config;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PowerBiError("upstream-failed");
  }
  return value as Record<string, unknown>;
}

export function createPowerBiService(
  config: PowerBiConfig,
  options: {
    credential?: TokenCredential;
    fetchImpl?: typeof fetch;
    now?: () => number;
  } = {},
) {
  const credential =
    options.credential ??
    new ClientSecretCredential(config.tenantId, config.clientId, config.clientSecret);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  let cached: PowerBiEmbedConfig | undefined;
  let pending: Promise<PowerBiEmbedConfig> | undefined;

  async function issue(): Promise<PowerBiEmbedConfig> {
    let token;
    try {
      token = await credential.getToken(SCOPE);
    } catch {
      throw new PowerBiError("identity-unavailable");
    }
    if (!token || token.expiresOnTimestamp <= now() + RENEW_BEFORE_MS) {
      throw new PowerBiError("identity-unavailable");
    }
    const accessToken = token.token;
    async function api(path: string, body?: unknown) {
      let response;
      try {
        response = await fetchImpl(`${API}/${path}`, {
          method: body ? "POST" : "GET",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(15_000),
          redirect: "error",
        });
      } catch {
        throw new PowerBiError("upstream-failed");
      }
      if (!response.ok) throw new PowerBiError("upstream-failed");
      try {
        return record(await response.json());
      } catch {
        throw new PowerBiError("upstream-failed");
      }
    }

    const report = await api(`groups/${config.workspaceId}/reports/${config.reportId}`);
    if (
      report.id !== config.reportId ||
      report.datasetId !== config.datasetId ||
      report.reportType !== "PowerBIReport"
    ) {
      throw new PowerBiError("report-mismatch");
    }
    // Pin both resources: a portal rebind must be explicitly re-approved by provisioning.
    const dataset = await api(`groups/${config.workspaceId}/datasets/${config.datasetId}`);
    if (
      dataset.id !== config.datasetId ||
      dataset.isEffectiveIdentityRequired !== false ||
      dataset.isEffectiveIdentityRolesRequired !== false
    ) {
      throw new PowerBiError("unsupported-model");
    }
    const embedUrl = new URL("https://app.powerbi.com/reportEmbed");
    embedUrl.searchParams.set("reportId", config.reportId);
    embedUrl.searchParams.set("groupId", config.workspaceId);
    const generated = await api("GenerateToken", {
      datasets: [{ id: config.datasetId }],
      reports: [{ id: config.reportId, allowEdit: false }],
      lifetimeInMinutes: 10,
    });
    const expiration =
      typeof generated.expiration === "string" ? Date.parse(generated.expiration) : NaN;
    if (
      typeof generated.token !== "string" ||
      !generated.token ||
      !Number.isFinite(expiration) ||
      expiration <= now() + RENEW_BEFORE_MS ||
      expiration > token.expiresOnTimestamp + 30_000
    ) {
      throw new PowerBiError("upstream-failed");
    }
    return {
      status: "ready",
      workspaceId: config.workspaceId,
      reportId: config.reportId,
      datasetId: config.datasetId,
      embedUrl: embedUrl.toString(),
      accessToken: generated.token,
      tokenType: "Embed",
      expiration: new Date(expiration).toISOString(),
    };
  }

  return {
    getEmbedConfig(): Promise<PowerBiEmbedConfig> {
      if (cached && Date.parse(cached.expiration) > now() + RENEW_BEFORE_MS) {
        return Promise.resolve(cached);
      }
      // One report and one explicitly approved audience, never a caller-selected cache key.
      pending ??= issue()
        .then((result) => {
          cached = result;
          return result;
        })
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
  };
}
