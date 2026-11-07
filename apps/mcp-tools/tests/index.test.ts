import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, createMcpToolsServer, main } from "../src/index.js";

describe("mcp-tools entrypoint", () => {
  it("exports a main() entry point", () => {
    expect(typeof main).toBe("function");
  });

  it("builds an MCP server instance", async () => {
    const server = createMcpToolsServer();
    expect(server).toBeDefined();
  });

  it("creates an express app with a health probe", async () => {
    const app = createApp();

    expect(typeof app).toBe("function");
  });
});

// Regression coverage for the live root cause: `createMcpExpressApp()` defaults to
// localhost-only DNS-rebinding Host-header validation, which rejects EVERY request to this
// app's real Container Apps internal-ingress FQDN with a 403 "Invalid Host" -- independent
// of authentication, and indistinguishable (from the caller's side) from an auth failure.
// `MCP_TOOLS_ALLOWED_HOST` must widen the allowlist to this app's actual hostname.
describe("mcp-tools Host header validation", () => {
  let server: http.Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
    delete process.env.MCP_TOOLS_ALLOWED_HOST;
  });

  function listen(app: ReturnType<typeof createApp>): Promise<number> {
    return new Promise((resolve) => {
      server = app.listen(0, () => {
        resolve((server!.address() as AddressInfo).port);
      });
    });
  }

  function postWithHost(port: number, hostHeader: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/mcp",
          method: "POST",
          headers: { host: hostHeader, "content-type": "application/json" },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }));
    });
  }

  it("without MCP_TOOLS_ALLOWED_HOST, rejects a real internal-ingress-style Host header (the live bug)", async () => {
    delete process.env.MCP_TOOLS_ALLOWED_HOST;
    const port = await listen(createApp());

    const { status, body } = await postWithHost(
      port,
      "triatwin-dev-mcp-tools.fictional.westeurope.azurecontainerapps.io",
    );

    expect(status).toBe(403);
    expect(body).toContain("Invalid Host");
  });

  it("with MCP_TOOLS_ALLOWED_HOST set, accepts that exact hostname", async () => {
    process.env.MCP_TOOLS_ALLOWED_HOST =
      "triatwin-dev-mcp-tools.fictional.westeurope.azurecontainerapps.io";
    const port = await listen(createApp());

    const { status, body } = await postWithHost(
      port,
      "triatwin-dev-mcp-tools.fictional.westeurope.azurecontainerapps.io",
    );

    expect(status).not.toBe(403);
    expect(body).not.toContain("Invalid Host");
  });

  it("with MCP_TOOLS_ALLOWED_HOST set, still rejects an unrelated Host header", async () => {
    process.env.MCP_TOOLS_ALLOWED_HOST =
      "triatwin-dev-mcp-tools.fictional.westeurope.azurecontainerapps.io";
    const port = await listen(createApp());

    const { status, body } = await postWithHost(port, "evil.example.com");

    expect(status).toBe(403);
    expect(body).toContain("Invalid Host");
  });
});

// Regression coverage for the live "406 -> fixed -> 405" chain's final layer: Foundry's real
// MCP client opens a GET request (the optional standalone SSE notification channel) as part
// of its tool-enumeration handshake, and hard-fails the entire handshake if that GET is
// rejected -- even though the preceding POST-based initialize/tools-list calls already
// succeeded. GET/DELETE previously short-circuited to a hardcoded 405 "Method not allowed"
// before ever reaching the SDK transport; they must now delegate to it like POST does, so the
// SDK's own spec-compliant stateless-mode behavior applies (GET opens an SSE stream, DELETE
// is a no-op 200).
describe("mcp-tools GET/DELETE delegate to the SDK transport", () => {
  let server: http.Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  function listen(app: ReturnType<typeof createApp>): Promise<number> {
    return new Promise((resolve) => {
      server = app.listen(0, () => {
        resolve((server!.address() as AddressInfo).port);
      });
    });
  }

  it("GET with a valid Accept header opens then promptly closes an SSE stream (not the old hardcoded 405, and not left open forever)", async () => {
    // Regression for a second, related bug uncovered by fixing the first: naively delegating
    // GET to the SDK transport opens a standalone SSE stream that stays open indefinitely
    // (correct for a server with async notifications to push), but this server never has
    // any -- and Foundry's real client waits for the GET request to *complete* as part of
    // its synchronous tool-enumeration handshake, hanging until its own timeout if the
    // stream is left open. The request must resolve (`res.on("end")` fires) on its own,
    // without the test having to force-destroy the socket.
    const port = await listen(createApp());

    const { status, ended } = await new Promise<{ status: number; ended: boolean }>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/mcp",
          method: "GET",
          headers: { accept: "text/event-stream" },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          res.on("data", () => undefined);
          res.on("end", () => resolve({ status, ended: true }));
        },
      );
      req.on("error", reject);
      req.setTimeout(5000, () => {
        req.destroy(new Error("GET /mcp did not complete within 5s -- the SSE stream was left open"));
      });
      req.end();
    });

    expect(status).not.toBe(405);
    expect(status).toBe(200);
    expect(ended).toBe(true);
  });

  it("DELETE returns 200 (stateless no-op) instead of the old hardcoded 405", async () => {
    const port = await listen(createApp());

    const { status } = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/mcp", method: "DELETE" },
        (res) => {
          res.on("data", () => undefined);
          res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(status).not.toBe(405);
    expect(status).toBe(200);
  });
});
