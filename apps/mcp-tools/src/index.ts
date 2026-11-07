import { pathToFileURL } from "node:url";
import type { Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AthleteAssistantDataService } from "./services/athlete-assistant-data.js";
import { registerQueryActiveAlertsTool } from "./tools/query-active-alerts.js";
import { registerQueryRaceSplitsTool } from "./tools/query-race-splits.js";
import { registerQueryRecoveryTrendTool } from "./tools/query-recovery-trend.js";
import { registerQueryTrainingLoadTool } from "./tools/query-training-load.js";

export interface CreateMcpToolsServerOptions {
  dataService?: AthleteAssistantDataService;
}

export function createMcpToolsServer(options: CreateMcpToolsServerOptions = {}): McpServer {
  const server = new McpServer(
    {
      name: "triathlon-training-twin-mcp-tools",
      version: "0.1.0",
    },
    { capabilities: { logging: {} } },
  );

  registerQueryRecoveryTrendTool(server, options.dataService);
  registerQueryTrainingLoadTool(server, options.dataService);
  registerQueryActiveAlertsTool(server, options.dataService);
  registerQueryRaceSplitsTool(server, options.dataService);

  return server;
}

/**
 * Root cause of a live 403 that blocked every MCP caller (including Foundry's fully valid,
 * correctly-authorized project-managed-identity callback): the SDK's `createMcpExpressApp()`
 * defaults to `host: '127.0.0.1'`, which enables DNS-rebinding Host-header validation that
 * only allows `localhost`/`127.0.0.1`/`::1`. This app is served over the network via its
 * Container Apps *internal* ingress FQDN (never localhost), so every request's real Host
 * header failed that check unconditionally -- independent of authentication, and explaining
 * why the failure was invisible to any auth-layer diagnostics upstream.
 *
 * Fix: `MCP_TOOLS_ALLOWED_HOST` (set by `mcp-tool-server.bicep` to this app's own internal
 * FQDN, which is deterministic from the Container Apps environment's default domain -- no
 * circular dependency) is passed as the SDK's `allowedHosts` list, replacing the
 * localhost-only default with the one hostname this internal-ingress-only app is actually
 * reachable at. Falls back to the SDK's default (localhost-only) validation when unset, e.g.
 * for local development against `http://localhost:3100`.
 */
export function createApp(options: CreateMcpToolsServerOptions = {}) {
  const allowedHost = process.env.MCP_TOOLS_ALLOWED_HOST?.trim();
  const app = createMcpExpressApp(
    allowedHost ? { host: "0.0.0.0", allowedHosts: [allowedHost] } : {},
  );

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok", service: "mcp-tools" });
  });

  // Shared by POST/DELETE: this server is fully stateless (`sessionIdGenerator: undefined`),
  // so every request gets its own ephemeral McpServer+transport pair, closed when the
  // response closes.
  //
  // DELETE used to be hardcoded to always return 405, on the assumption that a stateless
  // server has no session to terminate. Delegating it to the SDK transport instead applies
  // its spec-compliant stateless-mode behavior (a no-op 200), which is correct and safe here
  // since `handleDeleteRequest` resolves promptly on its own.
  async function handlePostOrDeleteRequest(req: Request, res: Response): Promise<void> {
    const server = createMcpToolsServer(options);

    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.method === "POST" ? req.body : undefined);

      res.on("close", () => {
        void transport.close();
        void server.close();
      });
    } catch (error) {
      console.error("[mcp-tools] failed to handle MCP request", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  }

  // GET used to be hardcoded to always return 405, on the assumption that a stateless server
  // has no session to stream notifications over. That broke real interop: Foundry's MCP
  // client sends a GET request (to open the optional standalone SSE notification channel) as
  // part of its tool-enumeration handshake, and hard-fails the whole handshake when that GET
  // returns 405 -- even though the preceding POST-based `initialize`/`tools/list` calls
  // succeed.
  //
  // Delegating GET to the SDK transport (like POST/DELETE) fixed the 405, but uncovered a
  // second, related problem: the SDK's `handleRequest()` promise for a GET does not resolve
  // until the SSE stream itself ends, and its default GET behavior opens that stream and
  // leaves it open indefinitely (correct for a server that pushes async notifications over
  // it) -- so `await`ing it, then trying to close it, can never run the close step at all.
  // Foundry's client waits for the GET request to *complete* as part of the same synchronous
  // handshake step, so a stream that never closes on its own makes the whole handshake hang
  // until Foundry's own timeout (~60s), surfacing as "Initialization timed out".
  //
  // Since this server never has any asynchronous notifications to push over a standalone
  // stream (every tool call is a synchronous request/response handled entirely within its own
  // ephemeral POST), bypass the SDK's persistent-stream machinery for GET entirely: validate
  // the Accept header the same way the SDK does, then respond with a valid but
  // immediately-ended SSE stream (no events, connection closes right away) -- "no further
  // streaming supported" without ever leaving the connection open.
  function handleGetRequest(req: Request, res: Response): void {
    const acceptHeader = req.get("accept") ?? "";
    if (!acceptHeader.includes("text/event-stream")) {
      res.status(406).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Not Acceptable: Client must accept text/event-stream" },
        id: null,
      });
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    res.end();
  }

  app.post("/mcp", handlePostOrDeleteRequest);
  app.get("/mcp", handleGetRequest);
  app.delete("/mcp", handlePostOrDeleteRequest);

  return app;
}

export function main(): void {
  const port = Number.parseInt(process.env.PORT ?? "3100", 10);
  const app = createApp();

  app.listen(port, () => {
    console.log(`[mcp-tools] listening on port ${port}`);
  });
}

// Compare via pathToFileURL (not a raw `file://` template string) so this also
// matches on Windows, where process.argv[1] is a drive-letter path with
// backslashes rather than a URL-encoded POSIX path.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
