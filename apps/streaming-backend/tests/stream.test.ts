import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachStreamServer } from "../src/api/stream.js";
import {
  resetPrincipalAthleteMapCacheForTests,
} from "../src/auth/authorization.js";
import { RealtimeStreamBroker } from "../src/services/realtime-stream.js";

const ATHLETE_ID = "11111111-1111-1111-1111-111111111111";
const PRINCIPAL_ID = "22222222-2222-2222-2222-222222222222";

describe("WS /api/stream/:athleteId", () => {
  beforeEach(() => {
    process.env.ATHLETE_PRINCIPAL_MAP = JSON.stringify({ [PRINCIPAL_ID]: ATHLETE_ID });
    resetPrincipalAthleteMapCacheForTests();
  });

  afterEach(() => {
    delete process.env.ATHLETE_PRINCIPAL_MAP;
    resetPrincipalAthleteMapCacheForTests();
  });

  it("pushes realtime frames to authorized subscribers for the matching athlete", async () => {
    const app = express();
    const server = createServer(app);
    const broker = new RealtimeStreamBroker();
    attachStreamServer(server, { broker });
    await new Promise<void>((resolve) => server.listen(0, resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/stream/${ATHLETE_ID}`, {
        headers: {
          "x-ms-client-principal-id": PRINCIPAL_ID,
        },
      });

      await once(socket, "open");
      const messagePromise = once(socket, "message");

      broker.publishMetric(ATHLETE_ID, "session-1", {
        sessionId: "session-1",
        timestamp: "2026-09-03T06:30:00.000Z",
        heartRate: 148,
        power: 225,
        pace: 9.4,
        cadence: 88,
        latitude: 47.62,
        longitude: -122.35,
      });

      const [message] = await messagePromise;
      expect(JSON.parse(message.toString())).toEqual({
        type: "metric",
        sessionId: "session-1",
        metric: {
          sessionId: "session-1",
          timestamp: "2026-09-03T06:30:00.000Z",
          heartRate: 148,
          power: 225,
          pace: 9.4,
          cadence: 88,
          latitude: 47.62,
          longitude: -122.35,
        },
      });

      socket.close();
      await once(socket, "close");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("rejects unauthorized upgrade requests before the websocket is established", async () => {
    const app = express();
    const server = createServer(app);
    attachStreamServer(server, { broker: new RealtimeStreamBroker() });
    await new Promise<void>((resolve) => server.listen(0, resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/stream/${ATHLETE_ID}`, {
        headers: {
          "x-ms-client-principal-id": "not-authorized",
        },
      });

      const [, response] = await once(socket, "unexpected-response");
      expect(response.statusCode).toBe(403);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
