import express from "express";
import type { Request } from "express";
import { AssistantAuthError, isServiceOrAnonymousCaller, requireAssistantUser } from "../auth/assistant-auth.js";
import type { AssistantUserContext } from "../auth/assistant-auth.js";
import {
  forbiddenBody,
  requireAthleteAuthorization,
  resolveAuthorizedAthleteIdForPrincipal,
} from "../auth/authorization.js";
import { verifyMcpCallerPrincipalId } from "../auth/mcp-caller.js";
import {
  AssistantUnavailableError,
  getAthleteAssistantService,
  type AthleteAssistantService,
} from "../services/athlete-assistant-agent.js";

const AUTHORIZED_ATHLETE_HEADER = "x-triatwin-authorized-athlete-id";

interface CreateAssistantRouterOptions {
  assistantService?: AthleteAssistantService;
}

function getRequestedAthleteId(req: Request): string | undefined {
  return typeof req.body?.athleteId === "string" ? req.body.athleteId : undefined;
}

function getQuestion(req: Request): string | undefined {
  return typeof req.body?.question === "string" ? req.body.question.trim() : undefined;
}

/**
 * Resolves the signed-in human's Assistant auth context, or `undefined` when no human sign-in
 * was attempted (anonymous visitor, or the Cockpit's own managed identity calling on the
 * visitor's behalf) -- in which case the Assistant proceeds in MI-mode (MCP tools only; see
 * athlete-assistant-agent.ts). A bearer that WAS presented but is invalid/expired/etc. still
 * throws `AssistantAuthError` here, exactly as before -- callers who attempt sign-in and fail
 * must see an explicit auth error, never a silent downgrade to anonymous access.
 */
function resolveOptionalAssistantUser(req: Request): AssistantUserContext | undefined {
  return isServiceOrAnonymousCaller(req) ? undefined : requireAssistantUser(req);
}

function assistantUnavailableBody() {
  return {
    error: {
      code: "assistant_unavailable",
      message: "Athlete Assistant is temporarily unavailable.",
    },
  } as const;
}

function createJsonRpcUnavailableBody() {
  return {
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Athlete Assistant MCP bridge unavailable.",
    },
    id: null,
  } as const;
}

function getAssistantMcpInternalUrl(): string {
  const value = process.env.ATHLETE_ASSISTANT_MCP_INTERNAL_URL?.trim();
  if (!value) {
    throw new AssistantUnavailableError(
      "Athlete Assistant is temporarily unavailable. Missing required configuration: ATHLETE_ASSISTANT_MCP_INTERNAL_URL.",
    );
  }

  return value;
}

export function buildProxyHeaders(req: Request, authorizedAthleteId: string): Headers {
  const headers = new Headers();
  for (const [name, rawValue] of Object.entries(req.headers)) {
    if (!rawValue) {
      continue;
    }

    const lowerName = name.toLowerCase();
    if (
      lowerName === "host" ||
      lowerName === "content-length" ||
      // Foundry's real MCP callback sends `Transfer-Encoding: chunked` on its POST (its body
      // is streamed, not a fixed-length buffer). We re-serialize the parsed body as a plain
      // JSON string below (not a stream), so forwarding the caller's original
      // transfer-encoding value onto our own outbound `fetch()` is both wrong (this request
      // isn't chunked) and fatal: undici's fetch() refuses to send a manually-set
      // `transfer-encoding` header at all, throwing `TypeError: fetch failed` / `Invalid
      // Argument Error: invalid transfer-encoding header` synchronously before any bytes go
      // out. This silently broke every real Foundry call (which always sends this header)
      // while manually-crafted test requests -- which typically don't set it -- masked the
      // bug entirely.
      lowerName === "transfer-encoding" ||
      lowerName === "connection" ||
      lowerName === "authorization" ||
      lowerName === "accept" ||
      lowerName.startsWith("x-ms-")
    ) {
      continue;
    }

    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    headers.set(name, value);
  }

  // The MCP Streamable HTTP transport spec requires clients to accept BOTH
  // `application/json` and `text/event-stream` (the upstream `mcp-tools` server otherwise
  // rejects the request with 406 "Not Acceptable"). Foundry's real MCP tool-enumeration
  // callback does not always send an `Accept` header satisfying both, even though it
  // faithfully proxies every other header -- observed live as a 406 that only reproduced
  // with the actual Foundry caller, not with manually-crafted requests that set `Accept`
  // correctly. Since this bridge fully owns both legs of the proxy (the caller's own Accept
  // preference is irrelevant to what the upstream transport requires), normalize it here
  // instead of forwarding whatever the caller happened to send.
  headers.set("accept", "application/json, text/event-stream");
  headers.set(AUTHORIZED_ATHLETE_HEADER, authorizedAthleteId);
  return headers;
}

function copyResponseHeaders(source: Headers, target: express.Response): void {
  for (const [name, value] of source.entries()) {
    if (name.toLowerCase() === "content-length") {
      continue;
    }

    target.setHeader(name, value);
  }
}

async function proxyMcpRequest(req: Request, res: express.Response): Promise<void> {
  // FR-017: the authorized athleteId MUST be resolved from the caller's own verified
  // identity (ATHLETE_PRINCIPAL_MAP), never from anything the client supplies on the
  // request (query string, body, or otherwise). This bridge has no per-endpoint
  // `athleteId` to check for a mismatch (it's a generic JSON-RPC passthrough to the MCP
  // tool server, whose own tool calls carry their own `athleteId` argument), so the only
  // trustworthy context to forward is the caller's resolved authorization -- a client can
  // never widen its own access by passing a different id anywhere on the request, matching
  // every other endpoint's FR-017 enforcement.
  //
  // This route is excluded from Container Apps Easy Auth (see `mcp-caller.ts`'s docstring
  // for why: Easy Auth rejects Foundry's project-managed-identity MCP callback with a 403
  // despite a fully valid, correctly-audienced token -- a platform limitation, not an app
  // bug). So Easy-Auth-injected headers are never present here; `verifyMcpCallerPrincipalId`
  // performs the equivalent verification itself (signature via tenant JWKS, issuer,
  // audience) before resolving the same explicit allowlist.
  const verifiedPrincipalId = await verifyMcpCallerPrincipalId(req);
  const authorizedAthleteId = resolveAuthorizedAthleteIdForPrincipal(verifiedPrincipalId);

  if (!authorizedAthleteId) {
    res.status(403).json(forbiddenBody());
    return;
  }

  try {
    const upstream = await fetch(getAssistantMcpInternalUrl(), {
      method: req.method,
      headers: buildProxyHeaders(req, authorizedAthleteId),
      body: req.method === "POST" ? JSON.stringify(req.body ?? {}) : undefined,
    });

    const responseBuffer = Buffer.from(await upstream.arrayBuffer());
    copyResponseHeaders(upstream.headers, res);
    res.status(upstream.status).send(responseBuffer);
  } catch {
    res.status(503).json(createJsonRpcUnavailableBody());
  }
}

export function createAssistantRouter(options: CreateAssistantRouterOptions = {}): express.Router {
  const router = express.Router();
  const assistantService = options.assistantService ?? getAthleteAssistantService();

  router.post(
    "/ask",
    requireAthleteAuthorization(getRequestedAthleteId),
    async (req, res) => {
      const athleteId = getRequestedAthleteId(req);
      const question = getQuestion(req);
      if (!athleteId || !question) {
        res.status(400).json({
          error: {
            code: "invalid_request",
            message: "Request body must include athleteId and question.",
          },
        });
        return;
      }

      try {
        const user = resolveOptionalAssistantUser(req);
        const answer = await assistantService.askQuestion(athleteId, question, user);
        res.setHeader("cache-control", "no-store");
        res.status(200).json(answer);
      } catch (error) {
        if (error instanceof AssistantAuthError) {
          res.setHeader("cache-control", "no-store");
          if (error.authenticateHeader) {
            res.setHeader("www-authenticate", error.authenticateHeader);
          }
          res.status(error.status).json(error.toBody());
          return;
        }
        if (error instanceof AssistantUnavailableError) {
          // Server-side only -- never leaked to the client, which always gets the generic
          // assistantUnavailableBody(). Logging the cause is necessary to diagnose Foundry/
          // MCP/credential failures in this route, which otherwise surface as an opaque 503.
          console.error("Athlete Assistant unavailable:", error.message, error.cause ?? "");
          res.status(503).json(assistantUnavailableBody());
          return;
        }

        console.error("Athlete Assistant /ask failed unexpectedly:", error);
        res.status(503).json(assistantUnavailableBody());
      }
    },
  );

  router.post("/mcp", async (req, res) => {
    await proxyMcpRequest(req, res);
  });

  router.get("/mcp", async (req, res) => {
    await proxyMcpRequest(req, res);
  });

  router.delete("/mcp", async (req, res) => {
    await proxyMcpRequest(req, res);
  });

  return router;
}
