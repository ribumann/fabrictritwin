import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { getServiceAccessToken } from "./service-auth.js";

export interface AttachCockpitStreamRelayOptions {
  streamingBackendBaseUrl: string;
  getAccessToken?: () => Promise<string>;
}

interface UpgradeSocket {
  write(chunk: string): boolean;
  destroy(): void;
}

function getRequestedAthleteIdFromUrl(requestUrl: string | undefined): string | undefined {
  if (!requestUrl) {
    return undefined;
  }

  const { pathname } = new URL(requestUrl, "http://localhost");
  const match = /^\/api\/stream\/([^/]+)$/.exec(pathname);
  return match?.[1];
}

function writeUpgradeRejection(
  socket: UpgradeSocket,
  statusCode: 404 | 502,
  code: string,
  message: string,
): void {
  const reasonPhrase = statusCode === 404 ? "Not Found" : "Bad Gateway";
  const payload = JSON.stringify({ error: { code, message } });
  socket.write(
    `HTTP/1.1 ${statusCode} ${reasonPhrase}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n` +
      payload,
  );
  socket.destroy();
}

function toUpstreamWebSocketUrl(baseUrl: string, athleteId: string): string {
  const upstream = new URL(`/api/stream/${encodeURIComponent(athleteId)}`, baseUrl);
  upstream.protocol = upstream.protocol === "https:" ? "wss:" : "ws:";
  return upstream.toString();
}

async function readUnexpectedResponseBody(response: IncomingMessage): Promise<string> {
  return await new Promise((resolve) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => {
      body += chunk;
    });
    response.on("end", () => resolve(body));
    response.on("error", () => resolve(body));
  });
}

export function attachCockpitStreamRelay(
  server: Server,
  options: AttachCockpitStreamRelayOptions,
): WebSocketServer {
  const webSocketServer = new WebSocketServer({ noServer: true });
  const getAccessToken = options.getAccessToken ?? getServiceAccessToken;

  // REST calls are proxied server-side to keep the Streaming Backend scope out of browser JS, and
  // the WebSocket follows the same pattern. A direct browser -> Streaming Backend socket would need
  // its own Easy Auth session on a different origin; the relay keeps the same managed-identity
  // auth path as the REST panels and remains isolated from any future chat/MCP panel failures.
  server.on("upgrade", (request, socket, head) => {
    const athleteId = getRequestedAthleteIdFromUrl(request.url);
    if (!athleteId) {
      writeUpgradeRejection(socket, 404, "not_found", "Unknown stream endpoint.");
      return;
    }

    void (async () => {
      try {
        const accessToken = await getAccessToken();
        webSocketServer.handleUpgrade(request, socket, head, (clientSocket) => {
          const upstream = new WebSocket(
            toUpstreamWebSocketUrl(options.streamingBackendBaseUrl, athleteId),
            {
              headers: {
                authorization: `Bearer ${accessToken}`,
              },
            },
          );

          clientSocket.on("close", () => {
            if (
              upstream.readyState === WebSocket.OPEN ||
              upstream.readyState === WebSocket.CONNECTING
            ) {
              upstream.close();
            }
          });
          clientSocket.on("error", () => {
            if (
              upstream.readyState === WebSocket.OPEN ||
              upstream.readyState === WebSocket.CONNECTING
            ) {
              upstream.close();
            }
          });

          upstream.on("message", (data, isBinary) => {
            if (clientSocket.readyState === WebSocket.OPEN) {
              clientSocket.send(data, { binary: isBinary });
            }
          });
          upstream.on("close", () => {
            if (
              clientSocket.readyState === WebSocket.OPEN ||
              clientSocket.readyState === WebSocket.CONNECTING
            ) {
              clientSocket.close();
            }
          });
          upstream.on("error", (error) => {
            if (clientSocket.readyState === WebSocket.OPEN) {
              clientSocket.send(
                JSON.stringify({
                  type: "proxyError",
                  message:
                    error instanceof Error ? error.message : "Streaming Backend socket failed.",
                }),
              );
              clientSocket.close(1011, "Upstream socket failed");
            }
          });
          upstream.on("unexpected-response", (_request, response: IncomingMessage) => {
            void readUnexpectedResponseBody(response).then((body) => {
              if (clientSocket.readyState === WebSocket.OPEN) {
                clientSocket.send(
                  JSON.stringify({
                    type: "proxyError",
                    status: response.statusCode ?? 502,
                    body,
                  }),
                );
                clientSocket.close(1011, "Upstream rejected upgrade");
              }
            });
          });

          webSocketServer.emit("connection", clientSocket, request);
        });
      } catch (error) {
        writeUpgradeRejection(
          socket,
          502,
          "stream_proxy_failed",
          error instanceof Error ? error.message : "Failed to initialize the stream relay.",
        );
      }
    })();
  });

  return webSocketServer;
}
