import { Router } from "express";
import type { Request, Response } from "express";
import { AssistantSignInError, buildAssistantUserHeaders } from "./assistant-auth.js";
import { buildServiceAuthHeaders } from "./service-auth.js";
import {
  buildMcpToolCallRequest,
  isSupportedMcpToolName,
  type SupportedMcpToolName,
} from "../agent/assistant-client.js";
import { proxyStreamingBackendPost, type StreamingBackendProxyOptions } from "./proxy.js";

function getTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getAssistantRequestBody(
  req: Request,
): { athleteId: string; question: string } | undefined {
  const athleteId = getTrimmedString(req.body?.athleteId);
  const question = getTrimmedString(req.body?.question);
  return athleteId && question ? { athleteId, question } : undefined;
}

function getMcpQueryRequestBody(
  req: Request,
): { tool: SupportedMcpToolName; arguments: Record<string, unknown> } | undefined {
  const tool = getSupportedTool(req.body?.tool);
  const args = req.body?.arguments;
  if (!tool || typeof args !== "object" || args === null || Array.isArray(args)) {
    return undefined;
  }

  return {
    tool,
    arguments: args as Record<string, unknown>,
  };
}

function getSupportedTool(tool: unknown) {
  return isSupportedMcpToolName(tool) ? tool : undefined;
}

/**
 * True only when the visitor presented no EasyAuth-injected sign-in headers at all (Cockpit's
 * ingress runs `AllowAnonymous`, so unauthenticated page loads reach this route with neither
 * header set). Anything else -- headers present but the token turns out malformed/expired/
 * wrong-tenant -- is a failed human sign-in attempt and must surface an explicit error from
 * `buildAssistantUserHeaders`, never be silently downgraded to the managed-identity fallback.
 */
function isAnonymousVisitor(req: Request): boolean {
  return !req.get("x-ms-token-aad-access-token") && !req.get("x-ms-client-principal-id");
}

function invalidRequestBody(message: string) {
  return {
    error: {
      code: "invalid_request",
      message,
    },
  };
}

interface AssistantProxyOptions extends StreamingBackendProxyOptions {
  buildUserAuthHeaders?: typeof buildAssistantUserHeaders;
  buildServiceAuthHeaders?: typeof buildServiceAuthHeaders;
}

export function createAssistantRouter(options: AssistantProxyOptions): Router {
  const router = Router();

  router.post("/ask", async (req: Request, res: Response): Promise<void> => {
    const body = getAssistantRequestBody(req);
    if (!body) {
      res.status(400).json(invalidRequestBody("Request body must include athleteId and question."));
      return;
    }

    res.setHeader("cache-control", "no-store");
    try {
      const url = new URL("/api/assistant/ask", options.streamingBackendBaseUrl);
      if (url.protocol !== "https:" || url.username || url.password) {
        throw new AssistantSignInError("assistant_auth_configuration_error", 503);
      }
      // No sign-in headers at all -- proceed anonymously via Cockpit's own managed identity
      // (MI-mode: MCP tools only, no Fabric Data Agent grounding; see athlete-assistant-agent.ts
      // on the backend). A visitor who DID attempt sign-in but has an invalid/expired token
      // still falls through to buildAssistantUserHeaders below and gets a real auth error.
      const headers = new Headers(
        isAnonymousVisitor(req)
          ? await (options.buildServiceAuthHeaders ?? buildServiceAuthHeaders)()
          : (options.buildUserAuthHeaders ?? buildAssistantUserHeaders)(req),
      );
      const upstream = await (options.fetchImpl ?? fetch)(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        redirect: "manual",
      });
      const contentType = upstream.headers.get("content-type") ?? "";
      if (
        (upstream.status >= 300 && upstream.status < 400) ||
        (upstream.status === 401 && !contentType.includes("application/json"))
      ) {
        res.status(401).json({
          error: {
            code: "assistant_authentication_required",
            message: "Sign in again to use Athlete Assistant.",
            canRefresh: false,
          },
        });
        return;
      }
      if (!contentType.includes("application/json")) {
        res.status(502).json({
          error: {
            code: "assistant_ask_proxy_failed",
            message: "Assistant returned an unexpected response.",
          },
        });
        return;
      }
      const challenge = upstream.headers.get("www-authenticate");
      if (
        upstream.status === 401 &&
        challenge?.startsWith('Bearer error="insufficient_claims"') &&
        challenge.length <= 12_000
      ) {
        res.setHeader("www-authenticate", challenge);
      }
      res.status(upstream.status).json(await upstream.json());
    } catch (error) {
      if (error instanceof AssistantSignInError) {
        res.status(error.status).json({
          error: {
            code: error.code,
            message: error.message,
            canRefresh: error.code === "assistant_token_expired",
          },
        });
        return;
      }
      res.status(502).json({
        error: {
          code: "assistant_ask_proxy_failed",
          message: "Could not reach Athlete Assistant. Try again.",
        },
      });
    }
  });

  router.post("/mcp-query", async (req: Request, res: Response): Promise<void> => {
    const body = getMcpQueryRequestBody(req);
    if (!body) {
      res
        .status(400)
        .json(
          invalidRequestBody(
            "Request body must include a supported tool name and arguments object.",
          ),
        );
      return;
    }

    await proxyStreamingBackendPost(
      req,
      res,
      options,
      () => new URL("/api/assistant/mcp", options.streamingBackendBaseUrl),
      buildMcpToolCallRequest(body.tool, body.arguments),
      "assistant_mcp_query_proxy_failed",
    );
  });

  return router;
}
