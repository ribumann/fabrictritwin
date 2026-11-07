/**
 * Azure AI Foundry currently provisions the account/project/model declaratively, but not the
 * final Athlete Assistant agent definition itself as a first-class ARM/Bicep resource in this
 * repo's target flow. T098 therefore keeps Bicep responsible for the durable infra surface
 * (Foundry project endpoint/model name, managed identities, and connection-id/env wiring) while
 * this helper idempotently creates or updates the actual agent definition at runtime via
 * `@azure/ai-projects`.
 *
 * Two invocation modes (see ADR-008 amendment "Anonymous-by-default with optional sign-in"):
 * - Signed-in human (`user` present): native Fabric grounding via the human's request-scoped
 *   OBO credential, plus the MCP tools. Required because Foundry's Fabric Data Agent tool only
 *   supports user identity authentication -- service principals are explicitly unsupported.
 * - No sign-in (`user` undefined, e.g. the Cockpit's own managed identity calling on behalf of
 *   an anonymous demo visitor): the backend's managed identity, MCP tools only. FR-017
 *   authorization (`requireAthleteAuthorization`) is enforced identically for both modes before
 *   this service is ever called.
 * Definition management (`ensureAgent`) always uses the backend's managed identity in both
 * modes. The MCP bridge separately authorizes its project-identity caller; the per-request
 * athlete URL parameter is diagnostic, not an authorization mechanism (see the FR-017 note
 * below).
 */
import { AIProjectClient, type MCPTool, type MicrosoftFabricPreviewTool, type ToolUnion } from "@azure/ai-projects";
import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";
import { ClientConfigurationError, ConfidentialClientApplication, InteractionRequiredAuthError, ServerError } from "@azure/msal-node";
import type { Response as OpenAIResponse } from "openai/resources/responses/responses";
import { AssistantAuthError, assistantAuthSetting, type AssistantUserContext } from "../auth/assistant-auth.js";

const DEFAULT_AGENT_NAME = "athlete-assistant";
const DEFAULT_MCP_SERVER_LABEL = "triathlon-twin-tools";
const ASSISTANT_UNAVAILABLE_MESSAGE = "Athlete Assistant is temporarily unavailable.";

export interface AssistantAskResponse {
  answer: string;
  groundedOn: string[];
  respondedInMs: number;
}

export interface AthleteAssistantService {
  // `user` is `undefined` when no human is signed in (anonymous/MI-mode caller); see the
  // module doc comment above for the two invocation modes.
  askQuestion(
    authorizedAthleteId: string,
    question: string,
    user: AssistantUserContext | undefined,
  ): Promise<AssistantAskResponse>;
}

interface AssistantConfig {
  projectEndpoint: string;
  agentName: string;
  modelDeploymentName: string;
  fabricProjectConnectionId: string;
  mcpProjectConnectionId: string;
  mcpProxyUrl: string;
}

const ASSISTANT_INSTRUCTIONS =
  "You are the Triathlon Training Twin Athlete Assistant. Answer only with read-only information grounded in the athlete's Fabric data and the four custom MCP tools. Never start, stop, or modify simulations, sessions, or races.";

/**
 * The four MCP tools (`query_training_load`, etc.) each require an `athleteId` argument that
 * must exactly match the caller's server-resolved authorized athlete (`authorizeToolCall` in
 * `apps/mcp-tools/src/tool-context.ts` rejects any mismatch). The model is never told this
 * value anywhere else -- the user's question never contains a UUID, and the static
 * `ASSISTANT_INSTRUCTIONS` above has no per-request data -- so without this, every real tool
 * call fails MCP input validation (the model has no UUID to supply and either omits the
 * argument or fabricates one). Appending it here is safe: it is the same
 * server-verified/authorized id already used to build the MCP proxy URL and the
 * `x-triatwin-authorized-athlete-id` header, never anything client-supplied.
 */
function buildInvocationInstructions(authorizedAthleteId: string): string {
  return `${ASSISTANT_INSTRUCTIONS} The authenticated athlete's id is ${authorizedAthleteId} -- always pass this exact value as the athleteId argument on every MCP tool call.`;
}

let sharedAssistantService: AthleteAssistantService | undefined;
let managementProjectClient: AIProjectClient | undefined;

export class AssistantUnavailableError extends Error {
  constructor(message = ASSISTANT_UNAVAILABLE_MESSAGE, options?: { cause?: unknown }) {
    super(message);
    this.name = "AssistantUnavailableError";
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }

  declare cause: unknown;
}

function requireConfiguredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new AssistantUnavailableError(
      `${ASSISTANT_UNAVAILABLE_MESSAGE} Missing required configuration: ${name}.`,
    );
  }

  return value;
}

function getAssistantConfig(): AssistantConfig {
  return {
    projectEndpoint: requireConfiguredEnv("FOUNDRY_PROJECT_ENDPOINT"),
    agentName: process.env.ATHLETE_ASSISTANT_AGENT_NAME?.trim() || DEFAULT_AGENT_NAME,
    modelDeploymentName: requireConfiguredEnv("ATHLETE_ASSISTANT_MODEL_DEPLOYMENT_NAME"),
    fabricProjectConnectionId: requireConfiguredEnv("ATHLETE_ASSISTANT_FABRIC_PROJECT_CONNECTION_ID"),
    mcpProjectConnectionId: requireConfiguredEnv("ATHLETE_ASSISTANT_MCP_PROJECT_CONNECTION_ID"),
    mcpProxyUrl: requireConfiguredEnv("ATHLETE_ASSISTANT_MCP_PROXY_URL"),
  };
}

function getManagementProjectClient(): AIProjectClient {
  if (!managementProjectClient) {
    managementProjectClient = new AIProjectClient(getAssistantConfig().projectEndpoint, new DefaultAzureCredential());
  }

  return managementProjectClient;
}

function buildRegisteredTools(config: AssistantConfig): ToolUnion[] {
  return [
    {
      type: "fabric_dataagent_preview",
      fabric_dataagent_preview: {
        project_connections: [
          {
            project_connection_id: config.fabricProjectConnectionId,
          },
        ],
      },
    } satisfies MicrosoftFabricPreviewTool,
    {
      type: "mcp",
      server_label: DEFAULT_MCP_SERVER_LABEL,
      server_url: config.mcpProxyUrl,
      require_approval: "never",
      project_connection_id: config.mcpProjectConnectionId,
    } satisfies MCPTool,
  ];
}

// NOTE (FR-017 trust boundary): `authorizedAthleteId` here is NOT the security check -- it
// is only a hint attached to Foundry's own outbound MCP tool call for logging/debugging. The
// receiving `/api/assistant/mcp` bridge (assistant.ts) does not read or trust this query
// parameter at all; it independently resolves the caller's authorized athlete from its own
// Easy-Auth-injected principal headers via `resolveAuthorizedAthleteId`, using
// ATHLETE_PRINCIPAL_MAP's entry for this Foundry agent's own managed identity (provisioned by
// provision-azure-resources.ps1's `foundry-agent` workload mapping). Keeping the parameter
// here is harmless (gives the URL a stable per-invocation shape) but must never be treated
// as -- or reintroduced as -- the actual authorization decision.
function buildInvocationTools(config: AssistantConfig, authorizedAthleteId: string): ToolUnion[] {
  const proxyUrl = new URL(config.mcpProxyUrl);
  proxyUrl.searchParams.set("authorizedAthleteId", authorizedAthleteId);

  return [
    {
      type: "fabric_dataagent_preview",
      fabric_dataagent_preview: {
        project_connections: [
          {
            project_connection_id: config.fabricProjectConnectionId,
          },
        ],
      },
    } satisfies MicrosoftFabricPreviewTool,
    {
      type: "mcp",
      server_label: DEFAULT_MCP_SERVER_LABEL,
      server_url: proxyUrl.toString(),
      require_approval: "never",
      project_connection_id: config.mcpProjectConnectionId,
    } satisfies MCPTool,
  ];
}

// MI-mode (no signed-in human): Foundry's Fabric Data Agent tool only supports user identity
// authentication, so it is deliberately omitted here -- invoking it with a managed identity
// credential would fail platform-side. Only the MCP tools (which authorize via FR-017's
// caller-agnostic ATHLETE_PRINCIPAL_MAP, not the visitor's own identity) are offered.
function buildMcpOnlyInvocationTools(config: AssistantConfig, authorizedAthleteId: string): ToolUnion[] {
  const proxyUrl = new URL(config.mcpProxyUrl);
  proxyUrl.searchParams.set("authorizedAthleteId", authorizedAthleteId);

  return [
    {
      type: "mcp",
      server_label: DEFAULT_MCP_SERVER_LABEL,
      server_url: proxyUrl.toString(),
      require_approval: "never",
      project_connection_id: config.mcpProjectConnectionId,
    } satisfies MCPTool,
  ];
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 404;
}

function extractGroundedOn(response: OpenAIResponse): string[] {
  const groundedOn = new Set<string>();

  if (Array.isArray(response.output)) {
    for (const item of response.output) {
      if ("name" in item && typeof item.name === "string" && item.name.length > 0) {
        groundedOn.add(item.name);
      }

      if (item.type === "message" && Array.isArray(item.content)) {
        for (const content of item.content) {
          const annotations = "annotations" in content ? content.annotations : [];
          if (annotations.length === 0) {
            continue;
          }

          for (const annotation of annotations) {
            if ("title" in annotation && typeof annotation.title === "string" && annotation.title.length > 0) {
              groundedOn.add(annotation.title);
            } else if ("url" in annotation && typeof annotation.url === "string" && annotation.url.length > 0) {
              groundedOn.add(annotation.url);
            }
          }
        }
      }
    }
  }

  return [...groundedOn];
}

function extractAnswer(response: OpenAIResponse): string {
  if (typeof response.output_text === "string" && response.output_text.trim().length > 0) {
    return response.output_text.trim();
  }

  const textChunks: string[] = [];
  if (Array.isArray(response.output)) {
    for (const item of response.output) {
      if (item.type !== "message" || !Array.isArray(item.content)) {
        continue;
      }

      for (const content of item.content) {
        if ("text" in content && typeof content.text === "string" && content.text.trim().length > 0) {
          textChunks.push(content.text.trim());
        }
      }
    }
  }

  return textChunks.join("\n").trim();
}

class FoundryAthleteAssistantService implements AthleteAssistantService {
  async askQuestion(
    authorizedAthleteId: string,
    question: string,
    user: AssistantUserContext | undefined,
  ): Promise<AssistantAskResponse> {
    const startedAt = Date.now();
    const config = getAssistantConfig();
    let credential: TokenCredential;
    let tools: ToolUnion[];

    if (user) {
      const tenantId = assistantAuthSetting("ASSISTANT_AUTH_TENANT_ID");
      if (user.tenantId !== tenantId) {
        throw new AssistantAuthError("assistant_authentication_required", 401);
      }
      const msal = new ConfidentialClientApplication({
        auth: {
          authority: `https://login.microsoftonline.com/${tenantId}`,
          clientId: assistantAuthSetting("ASSISTANT_AUTH_CLIENT_ID"),
          clientSecret: assistantAuthSetting("ASSISTANT_AUTH_CLIENT_SECRET"),
        },
      });
      credential = {
        async getToken(scopes, options) {
          const requestedScopes = typeof scopes === "string" ? [scopes] : scopes;
          if (requestedScopes.length !== 1 || requestedScopes[0] !== "https://ai.azure.com/.default") {
            throw new AssistantAuthError("assistant_auth_configuration_error", 503);
          }
          const result = await msal.acquireTokenOnBehalfOf({
            oboAssertion: user.userAssertionToken,
            scopes: requestedScopes,
            claims: options?.claims,
          });
          if (!result?.accessToken || !result.expiresOn) {
            throw new AssistantAuthError("assistant_authentication_required", 401);
          }
          return { token: result.accessToken, expiresOnTimestamp: result.expiresOn.getTime() };
        },
      };
      tools = buildInvocationTools(config, authorizedAthleteId);
    } else {
      // MI-mode: no signed-in human, so the platform-restricted Fabric Data Agent tool is
      // unavailable for this call. Use the backend's own managed identity and MCP tools only.
      credential = new DefaultAzureCredential();
      tools = buildMcpOnlyInvocationTools(config, authorizedAthleteId);
    }

    try {
      // Validate/exchange the user's assertion before even touching the agent definition.
      // This credential and its in-memory cache live only for this invocation.
      const token = await credential.getToken("https://ai.azure.com/.default");
      if (!token) {
        throw new AssistantAuthError("assistant_authentication_required", 401);
      }
      // Keeps a portal-visible "athlete-assistant" agent definition in sync for demo purposes,
      // but invocation below intentionally does NOT reference it: the Foundry Responses API
      // rejects `tools` whenever an `agent_reference` is also present, and this call's tool set
      // must vary per-request (MI-mode omits the Fabric Data Agent tool; the human path's MCP
      // tool URL is athlete-scoped). Sending `model`/`instructions`/`tools` inline instead (the
      // SDK's documented ad-hoc/ephemeral-agent pattern) avoids that conflict entirely.
      await this.ensureAgent(getManagementProjectClient(), config);
      const project = new AIProjectClient(config.projectEndpoint, credential);
      const openAIClient = project.getOpenAIClient();
      const requestBody = {
        model: config.modelDeploymentName,
        instructions: buildInvocationInstructions(authorizedAthleteId),
        input: question,
        stream: false,
        tools,
      };
      // Native Fabric is a Foundry REST extension not present in OpenAI's Tool union.
      // The SDK's typed HTTP operation sends it without unsafe OpenAI type assertions.
      const response = await openAIClient.post<OpenAIResponse>("/responses", { body: requestBody });
      if (response.error || response.status !== "completed" || !extractAnswer(response)) {
        throw new AssistantUnavailableError();
      }

      return {
        answer: extractAnswer(response),
        groundedOn: extractGroundedOn(response),
        respondedInMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (error instanceof AssistantAuthError) {
        throw error;
      }
      if (error instanceof InteractionRequiredAuthError) {
        throw new AssistantAuthError("assistant_interaction_required", 401, error.claims);
      }
      if (error instanceof ClientConfigurationError) {
        throw new AssistantAuthError("assistant_auth_configuration_error", 503);
      }
      if (error instanceof ServerError) {
        const kind = error.errorCode;
        if (kind === "interaction_required" || kind === "consent_required" ||
          ["65001", "50076", "50079", "50158"].includes(error.errorNo ?? "")) {
          throw new AssistantAuthError("assistant_interaction_required", 401);
        }
        if (kind === "invalid_grant") {
          throw new AssistantAuthError("assistant_token_expired", 401);
        }
        if (kind === "access_denied" || kind === "unauthorized_client") {
          throw new AssistantAuthError("assistant_access_denied", 403);
        }
        if (kind === "invalid_client" || kind === "invalid_scope") {
          throw new AssistantAuthError("assistant_auth_configuration_error", 503);
        }
      }
      if (typeof error === "object" && error !== null && "status" in error) {
        if (error.status === 403) {
          throw new AssistantAuthError("assistant_access_denied", 403);
        }
        if (error.status === 401) {
          throw new AssistantAuthError("assistant_interaction_required", 401);
        }
      }
      throw new AssistantUnavailableError(undefined, { cause: error });
    }
  }

  private async ensureAgent(project: AIProjectClient, config: AssistantConfig): Promise<void> {
    const definition = {
      kind: "prompt",
      model: config.modelDeploymentName,
      instructions: ASSISTANT_INSTRUCTIONS,
      tools: buildRegisteredTools(config),
    } as const;

    try {
      await project.agents.update(config.agentName, definition);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw new AssistantUnavailableError(undefined, { cause: error });
      }

      try {
        await project.agents.create(config.agentName, definition);
      } catch (createError) {
        throw new AssistantUnavailableError(undefined, { cause: createError });
      }
    }
  }
}

export function createAthleteAssistantService(): AthleteAssistantService {
  return new FoundryAthleteAssistantService();
}

export function getAthleteAssistantService(): AthleteAssistantService {
  if (!sharedAssistantService) {
    sharedAssistantService = createAthleteAssistantService();
  }

  return sharedAssistantService;
}

export function resetAthleteAssistantServiceForTests(): void {
  sharedAssistantService = undefined;
  managementProjectClient = undefined;
}
