import type { IncomingMessage, Server } from "node:http";
import type { Request } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { forbiddenBody, resolveAuthorizedAthleteId } from "../auth/authorization.js";
import { realtimeStreamBroker, type RealtimeStreamBroker } from "../services/realtime-stream.js";

interface AttachStreamServerOptions {
  broker?: RealtimeStreamBroker;
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

function writeUpgradeRejection(socket: UpgradeSocket, statusCode: 403 | 404, body?: object): void {
  const reasonPhrase = statusCode === 403 ? "Forbidden" : "Not Found";
  const payload = body ? JSON.stringify(body) : "";
  socket.write(
    `HTTP/1.1 ${statusCode} ${reasonPhrase}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n` +
      payload,
  );
  socket.destroy();
}

function resolveUpgradeAuthorizedAthleteId(request: IncomingMessage): string | undefined {
  return resolveAuthorizedAthleteId({ headers: request.headers } as Request);
}

export function attachStreamServer(
  server: Server,
  options: AttachStreamServerOptions = {},
): WebSocketServer {
  const broker = options.broker ?? realtimeStreamBroker;
  const webSocketServer = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const athleteId = getRequestedAthleteIdFromUrl(request.url);
    if (!athleteId) {
      writeUpgradeRejection(socket, 404, {
        error: {
          code: "not_found",
          message: "Unknown stream endpoint.",
        },
      });
      return;
    }

    if (resolveUpgradeAuthorizedAthleteId(request) !== athleteId) {
      writeUpgradeRejection(socket, 403, forbiddenBody());
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (ws) => {
      const unsubscribe = broker.subscribe((event) => {
        if (event.athleteId !== athleteId || ws.readyState !== WebSocket.OPEN) {
          return;
        }

        ws.send(JSON.stringify(event.frame));
      });

      ws.on("close", unsubscribe);
      ws.on("error", unsubscribe);
      webSocketServer.emit("connection", ws, request);
    });
  });

  return webSocketServer;
}
