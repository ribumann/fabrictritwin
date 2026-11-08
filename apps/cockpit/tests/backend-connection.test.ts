import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { WebSocket, WebSocketServer } from "ws";
import { resolveBackendConnection } from "../src/api/backend-connection.js";
import { attachCockpitStreamRelay } from "../src/api/stream-relay.js";
import { resetServiceTokenCacheForTests } from "../src/api/service-auth.js";

const auth = vi.hoisted(() => ({ constructed: vi.fn(), getToken: vi.fn() }));
vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: class {
    constructor() {
      auth.constructed();
    }
    getToken = auth.getToken;
  },
}));

const servers: Server[] = [];
const sockets: WebSocketServer[] = [];
afterEach(async () => {
  for (const server of sockets) {
    for (const client of server.clients) client.terminate();
    server.close();
  }
  sockets.length = 0;
  for (const server of servers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers.length = 0;
  resetServiceTokenCacheForTests();
  auth.constructed.mockClear();
  auth.getToken.mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("synthetic backend topology", () => {
  it.each(["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"])(
    "keeps %s credential-free even if a cloud scope exists",
    (url) => {
      expect(resolveBackendConnection("synthetic", url, "configured-scope").anonymous).toBe(true);
      expect(auth.constructed).not.toHaveBeenCalled();
    },
  );

  it("requires hosted HTTPS and scope without weakening live defaults", () => {
    expect(
      resolveBackendConnection("synthetic", "https://backend.example", "api://backend/.default"),
    ).toEqual({ anonymous: false });
    expect(() => resolveBackendConnection("synthetic", "https://backend.example", "")).toThrow(
      "STREAMING_BACKEND_SCOPE",
    );
    expect(() => resolveBackendConnection("synthetic", "http://backend.example", "scope")).toThrow(
      "HTTPS",
    );
    expect(() =>
      resolveBackendConnection("synthetic", "http://localhost.evil.example", "scope"),
    ).toThrow("HTTPS");
    expect(() =>
      resolveBackendConnection("synthetic", "http://user:secret@localhost:3000"),
    ).toThrow("credentials");
    expect(resolveBackendConnection("live", "http://localhost:3000", "")).toEqual({
      anonymous: false,
    });
  });

  it("uses the existing credential and bearer auth on hosted synthetic REST", async () => {
    vi.stubEnv("DEMO_PROFILE", "synthetic");
    vi.stubEnv("STREAMING_BACKEND_BASE_URL", "https://backend.example");
    vi.stubEnv("STREAMING_BACKEND_SCOPE", "api://backend/.default");
    auth.getToken.mockResolvedValue({
      token: "service-fixture",
      expiresOnTimestamp: Date.now() + 3_600_000,
    });
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer service-fixture");
      return new Response(JSON.stringify({ selectedAthleteId: "fixed-synthetic" }), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
    const { app } = await import("../src/index.js");
    expect(auth.constructed).not.toHaveBeenCalled();
    const response = await request(app)
      .get("/api/context")
      .set("authorization", "Bearer visitor-spoof");
    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]?.toString()).toBe("https://backend.example/api/demo/context");
    expect(auth.constructed).toHaveBeenCalledOnce();
    expect(auth.getToken).toHaveBeenCalledWith("api://backend/.default");
  }, 15_000);

  it.each(["local", "hosted"])(
    "uses the %s strategy on a real WebSocket relay upgrade",
    async (mode) => {
      const hosted = mode === "hosted";
      vi.stubEnv("STREAMING_BACKEND_SCOPE", "api://backend/.default");
      auth.getToken.mockResolvedValue({
        token: "service-fixture",
        expiresOnTimestamp: Date.now() + 3_600_000,
      });
      const topology = resolveBackendConnection(
        "synthetic",
        hosted ? "https://backend.example" : "http://localhost:3000",
        "api://backend/.default",
      );
      const upstream = createServer();
      const upstreamSockets = new WebSocketServer({ server: upstream });
      sockets.push(upstreamSockets);
      const upstreamUrl = await listen(upstream);
      const receivedAuth = vi.fn();
      upstreamSockets.on("connection", (socket, req) => {
        receivedAuth(req.headers.authorization);
        socket.send("synthetic-telemetry");
      });
      const relay = createServer();
      sockets.push(
        attachCockpitStreamRelay(relay, {
          streamingBackendBaseUrl: upstreamUrl,
          anonymous: topology.anonymous,
        }),
      );
      const relayUrl = await listen(relay);
      const client = new WebSocket(`${relayUrl.replace("http:", "ws:")}/api/stream/fixed`);
      await new Promise<void>((resolve, reject) => {
        client.once("error", reject);
        client.once("message", (message) => {
          expect(message.toString()).toBe("synthetic-telemetry");
          client.close();
          resolve();
        });
      });
      expect(receivedAuth).toHaveBeenCalledWith(hosted ? "Bearer service-fixture" : undefined);
      expect(auth.constructed).toHaveBeenCalledTimes(hosted ? 1 : 0);
      expect(auth.getToken).toHaveBeenCalledTimes(hosted ? 1 : 0);
    },
  );

  it("rejects a hosted WebSocket upgrade when service authentication fails, without an anonymous retry", async () => {
    vi.stubEnv("STREAMING_BACKEND_SCOPE", "api://backend/.default");
    auth.getToken.mockRejectedValue(new Error("Service identity unavailable"));
    const relay = createServer();
    sockets.push(
      attachCockpitStreamRelay(relay, {
        streamingBackendBaseUrl: "https://backend.example",
        anonymous: resolveBackendConnection("synthetic", "https://backend.example", "scope")
          .anonymous,
      }),
    );
    const relayUrl = await listen(relay);
    const client = new WebSocket(`${relayUrl.replace("http:", "ws:")}/api/stream/fixed`);
    const status = await new Promise<number>((resolve, reject) => {
      client.once("error", reject);
      client.once("unexpected-response", (_req, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
    });
    client.terminate();
    expect(status).toBe(502);
    expect(auth.getToken).toHaveBeenCalledOnce();
  });
});
