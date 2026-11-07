import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractionRequiredAuthError, ServerError } from "@azure/msal-node";
import type { TokenCredential } from "@azure/identity";
import { AssistantAuthError } from "../src/auth/assistant-auth.js";
import { createAthleteAssistantService, resetAthleteAssistantServiceForTests } from "../src/services/athlete-assistant-agent.js";

const mocks = vi.hoisted(() => ({
  exchange: vi.fn(),
  post: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  users: [] as unknown[],
  management: [] as unknown[],
  responses: [] as { assertion: string; path: string; body: unknown }[],
}));

vi.mock("@azure/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@azure/identity")>();
  return {
    ...actual,
    // Real code: MI-mode (no signed-in user) constructs `new DefaultAzureCredential()` directly
    // and calls `getToken` on it, so this mock must behave like a working credential now (it
    // previously had no `getToken` at all, back when only the management client ever used it).
    DefaultAzureCredential: class DefaultAzureCredential {
      async getToken() {
        return { token: "mi-access-token", expiresOnTimestamp: Date.now() + 3600_000 };
      }
    },
  };
});

vi.mock("@azure/msal-node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@azure/msal-node")>();
  return {
    ...actual,
    ConfidentialClientApplication: class {
      acquireTokenOnBehalfOf(options: { oboAssertion: string; scopes: string[] }) {
        return mocks.exchange(options.oboAssertion, options.scopes[0]);
      }
    },
  };
});

vi.mock("@azure/ai-projects", () => ({
  AIProjectClient: class {
    agents = { update: mocks.update, create: mocks.create };
    constructor(_endpoint: string, private credential: TokenCredential) {
      // Classify by concrete credential shape for test assertions only -- both the memoized
      // management client (ensureAgent) and an ad-hoc MI-mode invocation client are real
      // `DefaultAzureCredential` instances, so both land in `management`; a per-request OBO
      // credential (plain object literal) lands in `users`.
      if (this.credential?.constructor?.name === "DefaultAzureCredential") {
        mocks.management.push(credential);
      } else {
        mocks.users.push(credential);
      }
    }
    getOpenAIClient() {
      const isManagedIdentity = this.credential?.constructor?.name === "DefaultAzureCredential";
      return {
        post: async (path: string, options: { body: unknown }) => {
          const token = await this.credential.getToken("https://ai.azure.com/.default");
          const assertion = isManagedIdentity ? (token?.token ?? "") : (token?.token.replace("foundry-", "") ?? "");
          mocks.responses.push({ assertion, path, body: options.body });
          return mocks.post(assertion);
        },
      };
    }
  },
}));

function user(principalId: string) {
  return { principalId, tenantId: "tenant", userAssertionToken: `assertion-${principalId}` };
}

describe("Foundry delegated invocation", () => {
  beforeEach(() => {
    resetAthleteAssistantServiceForTests();
    mocks.users.length = 0;
    mocks.management.length = 0;
    mocks.responses.length = 0;
    vi.clearAllMocks();
    for (const [key, value] of Object.entries({
      ASSISTANT_AUTH_TENANT_ID: "tenant",
      ASSISTANT_AUTH_CLIENT_ID: "backend-app",
      ASSISTANT_AUTH_CLIENT_SECRET: "server-credential-never-output",
      FOUNDRY_PROJECT_ENDPOINT: "https://example.services.ai.azure.com/api/projects/demo",
      ATHLETE_ASSISTANT_MODEL_DEPLOYMENT_NAME: "model",
      ATHLETE_ASSISTANT_FABRIC_PROJECT_CONNECTION_ID: "/connections/fabric",
      ATHLETE_ASSISTANT_MCP_PROJECT_CONNECTION_ID: "/connections/mcp",
      ATHLETE_ASSISTANT_MCP_PROXY_URL: "https://backend.example.test/api/assistant/mcp",
    })) {
      vi.stubEnv(key, value);
    }
    mocks.exchange.mockImplementation(async (assertion: string) => ({
      accessToken: `foundry-${assertion}`, expiresOn: new Date(Date.now() + 3600_000),
    }));
    mocks.update.mockResolvedValue({});
    mocks.create.mockResolvedValue({});
    mocks.post.mockImplementation(async (assertion: string) => ({
      status: "completed", output_text: `Answer for ${assertion}`,
      output: [{ type: "mcp_call", name: "query_recovery_trend" }],
    }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetAthleteAssistantServiceForTests();
  });

  it("exchanges user tokens for the Foundry audience and isolates concurrent users", async () => {
    const service = createAthleteAssistantService();
    const answers = await Promise.all([
      service.askQuestion("athlete", "First question", user("first")),
      service.askQuestion("athlete", "Second question", user("second")),
    ]);
    expect(mocks.users).toHaveLength(2);
    expect(mocks.users[0]).not.toBe(mocks.users[1]);
    expect(mocks.management).toHaveLength(1);
    expect(mocks.exchange).toHaveBeenCalledWith("assertion-first", "https://ai.azure.com/.default");
    expect(mocks.exchange).toHaveBeenCalledWith("assertion-second", "https://ai.azure.com/.default");
    expect(answers.map((answer) => answer.answer)).toEqual([
      "Answer for assertion-first", "Answer for assertion-second",
    ]);
    expect(mocks.responses[0]).toMatchObject({
      assertion: "assertion-first", path: "/responses",
      body: {
        model: "model",
        tools: [{ type: "fabric_dataagent_preview" }, { type: "mcp" }],
      },
    });
    expect(JSON.stringify(mocks.responses)).not.toContain("server-credential-never-output");
  });

  it("validates OBO before any agent-definition management", async () => {
    mocks.exchange.mockRejectedValue(new ServerError("invalid_grant", "correlation", "secret assertion details"));
    await expect(createAthleteAssistantService().askQuestion("athlete", "Question", user("first")))
      .rejects.toMatchObject({ code: "assistant_token_expired", status: 401 });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.responses).toHaveLength(0);
    expect(mocks.management).toHaveLength(0);
  });

  it.each([
    ["consent_required", "assistant_interaction_required", 401],
    ["interaction_required", "assistant_interaction_required", 401],
    ["invalid_client", "assistant_auth_configuration_error", 503],
    ["access_denied", "assistant_access_denied", 403],
  ])("returns a safe %s error without credential details", async (kind, code, status) => {
    mocks.exchange.mockRejectedValue(new ServerError(kind, "correlation", "secret-user-token"));
    try {
      await createAthleteAssistantService().askQuestion("athlete", "Question", user("first"));
      expect.fail("expected an authentication error");
    } catch (error) {
      expect(error).toBeInstanceOf(AssistantAuthError);
      expect(error).toMatchObject({ code, status });
      expect(String(error)).not.toContain("secret-user-token");
    }
  });

  it("retains a bounded claims challenge without exposing the raw MSAL message", async () => {
    const claims = '{"access_token":{"acrs":{"essential":true,"value":"c1"}}}';
    mocks.exchange.mockRejectedValue(new InteractionRequiredAuthError(
      "interaction_required", "correlation", "secret-user-token", "", "", "", claims,
    ));
    try {
      await createAthleteAssistantService().askQuestion("athlete", "Question", user("first"));
      expect.fail("expected a claims challenge");
    } catch (error) {
      expect(error).toBeInstanceOf(AssistantAuthError);
      if (!(error instanceof AssistantAuthError)) {
        throw error;
      }
      expect(error.authenticateHeader).toContain(Buffer.from(claims).toString("base64"));
      expect(JSON.stringify(error.toBody())).not.toContain("secret-user-token");
      expect(error.code).toBe("assistant_interaction_required");
    }
  });

  it("does not treat an incomplete or failed native response as grounded success", async () => {
    mocks.post.mockResolvedValue({ status: "failed", error: { message: "upstream details" }, output_text: "partial" });
    await expect(createAthleteAssistantService().askQuestion("athlete", "Question", user("first")))
      .rejects.toMatchObject({ name: "AssistantUnavailableError" });
  });

  it("keeps Foundry user access denial separate from service outages", async () => {
    mocks.post.mockRejectedValue({ status: 403, message: "raw upstream details" });
    await expect(createAthleteAssistantService().askQuestion("athlete", "Question", user("first")))
      .rejects.toMatchObject({ code: "assistant_access_denied", status: 403 });
  });

  it("tells the model the exact authorized athleteId to use in MCP tool call arguments", async () => {
    // Regression: MCP tools require the model's `athleteId` tool-call argument to exactly
    // match the server-resolved authorized athlete (`authorizeToolCall` in mcp-tools rejects
    // any mismatch), but the model is never shown this value anywhere else -- the user's
    // question never contains it. Without this, every real tool call fails with "Invalid
    // arguments for tool ...: Invalid UUID at athleteId" because the model has nothing to
    // supply.
    await createAthleteAssistantService().askQuestion("5be6ba88-bb2a-5843-b063-70557a5e786f", "Question", user("first"));
    expect(mocks.responses[0].body).toMatchObject({
      instructions: expect.stringContaining("5be6ba88-bb2a-5843-b063-70557a5e786f"),
    });
  });

  it("creates a missing agent using management identity only", async () => {
    mocks.update.mockRejectedValue({ statusCode: 404 });
    await createAthleteAssistantService().askQuestion("athlete", "Question", user("first"));
    expect(mocks.create).toHaveBeenCalledWith("athlete-assistant", expect.objectContaining({
      kind: "prompt", model: "model",
    }));
    expect(mocks.responses[0].assertion).toBe("assertion-first");
  });
});

describe("MI-mode invocation (no signed-in human)", () => {
  beforeEach(() => {
    resetAthleteAssistantServiceForTests();
    mocks.users.length = 0;
    mocks.management.length = 0;
    mocks.responses.length = 0;
    vi.clearAllMocks();
    for (const [key, value] of Object.entries({
      ASSISTANT_AUTH_TENANT_ID: "tenant",
      ASSISTANT_AUTH_CLIENT_ID: "backend-app",
      ASSISTANT_AUTH_CLIENT_SECRET: "server-credential-never-output",
      FOUNDRY_PROJECT_ENDPOINT: "https://example.services.ai.azure.com/api/projects/demo",
      ATHLETE_ASSISTANT_MODEL_DEPLOYMENT_NAME: "model",
      ATHLETE_ASSISTANT_FABRIC_PROJECT_CONNECTION_ID: "/connections/fabric",
      ATHLETE_ASSISTANT_MCP_PROJECT_CONNECTION_ID: "/connections/mcp",
      ATHLETE_ASSISTANT_MCP_PROXY_URL: "https://backend.example.test/api/assistant/mcp",
    })) {
      vi.stubEnv(key, value);
    }
    mocks.update.mockResolvedValue({});
    mocks.create.mockResolvedValue({});
    mocks.post.mockImplementation(async (assertion: string) => ({
      status: "completed", output_text: `Answer for ${assertion}`,
      output: [{ type: "mcp_call", name: "query_recovery_trend" }],
    }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetAthleteAssistantServiceForTests();
  });

  it("answers using only the MCP tools (no Fabric Data Agent tool) via the backend's managed identity", async () => {
    const answer = await createAthleteAssistantService().askQuestion("athlete", "Question", undefined);
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(answer.answer).toBe("Answer for mi-access-token");
    expect(mocks.responses).toHaveLength(1);
    expect(mocks.responses[0].body).toMatchObject({
      model: "model",
      tools: [{ type: "mcp" }],
    });
    const toolTypes = (mocks.responses[0].body as { tools: { type: string }[] }).tools.map((tool) => tool.type);
    expect(toolTypes).not.toContain("fabric_dataagent_preview");
  });

  it("still registers the full agent definition (both tools) even though this invocation skips Fabric", async () => {
    await createAthleteAssistantService().askQuestion("athlete", "Question", undefined);
    expect(mocks.update).toHaveBeenCalledWith("athlete-assistant", expect.objectContaining({
      tools: expect.arrayContaining([
        expect.objectContaining({ type: "fabric_dataagent_preview" }),
        expect.objectContaining({ type: "mcp" }),
      ]),
    }));
  });
});
