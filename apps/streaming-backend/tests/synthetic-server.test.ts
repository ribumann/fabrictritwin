import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import request from "supertest";
import https from "node:https";

const cloud = vi.hoisted(() => ({
  credential: vi.fn(() => {
    throw new Error("Unexpected Azure credential");
  }),
  lake: vi.fn(() => {
    throw new Error("Unexpected Data Lake client");
  }),
  eventHub: vi.fn(() => {
    throw new Error("Unexpected Event Hubs client");
  }),
  kusto: vi.fn(() => {
    throw new Error("Unexpected Kusto client");
  }),
}));

vi.mock("@azure/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@azure/identity")>()),
  DefaultAzureCredential: class {
    constructor() {
      cloud.credential();
    }
  },
}));
vi.mock("@azure/storage-file-datalake", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@azure/storage-file-datalake")>()),
  DataLakeServiceClient: class {
    constructor() {
      cloud.lake();
    }
  },
}));
vi.mock("@azure/event-hubs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@azure/event-hubs")>()),
  EventHubProducerClient: class {
    constructor() {
      cloud.eventHub();
    }
  },
}));
vi.mock("azure-kusto-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("azure-kusto-data")>()),
  Client: class {
    constructor() {
      cloud.kusto();
    }
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

it("starts the real synthetic server without cloud configuration and cancels work on close", async () => {
  vi.stubEnv("DEMO_PROFILE", "synthetic");
  vi.stubEnv("ATHLETE_PRINCIPAL_MAP", "");
  vi.stubEnv("EVENTHOUSE_QUERY_URI", "");
  vi.stubEnv("EVENTHOUSE_DATABASE_NAME", "");
  vi.stubEnv("AZURE_CLIENT_ID", "");
  vi.stubEnv("AZURE_TENANT_ID", "");
  const outboundFetch = vi.fn(() => {
    throw new Error("Unexpected outbound fetch");
  });
  vi.stubGlobal("fetch", outboundFetch);
  const outboundHttps = vi.spyOn(https, "request").mockImplementation(() => {
    throw new Error("Unexpected outbound HTTPS request");
  });
  const { server, runtime } = await import("../src/index.js");
  expect(runtime).toBeDefined();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const base = `http://127.0.0.1:${address.port}`;
  const context = await request(base).get("/api/demo/context");
  expect(context.status).toBe(200);
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/stream/${context.body.athleteId}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const metric = new Promise<string>((resolve) =>
    ws.once("message", (data) => resolve(data.toString())),
  );
  const started = await request(base).post("/api/simulate/trigger-session").send({
    athleteId: context.body.athleteId,
    discipline: "run",
  });
  expect(started.status).toBe(202);
  expect(JSON.parse(await metric).type).toBe("metric");
  const session = await request(base).get("/api/demo/session");
  expect(session.body.session.source).toBe("synthetic");
  expect((await request(base).get(`/api/analyses/${context.body.athleteId}`)).status).toBe(200);
  expect((await request(base).get(`/api/alerts/${context.body.athleteId}`)).status).toBe(200);
  expect(
    (
      await request(base)
        .post("/api/assistant")
        .send({ athleteId: context.body.athleteId, question: "Summary?" })
    ).status,
  ).toBe(200);
  expect(
    (await request(base).post("/api/simulate/cancel").send({ runId: started.body.runId })).status,
  ).toBe(200);
  const raceSplit = new Promise<void>((resolve) => {
    const onMessage = (data: import("ws").RawData) => {
      if (JSON.parse(data.toString()).type === "raceSplit") {
        ws.off("message", onMessage);
        resolve();
      }
    };
    ws.on("message", onMessage);
  });
  const race = await request(base).post("/api/simulate/trigger-race").send({
    athleteId: context.body.athleteId,
    raceId: context.body.raceId,
  });
  expect(race.status).toBe(202);
  await raceSplit;
  const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await closed;
  expect(runtime!.status().recentRuns[0]?.status).toBe("cancelled");
  expect(ws.readyState).not.toBe(WebSocket.OPEN);
  expect(outboundFetch).not.toHaveBeenCalled();
  expect(outboundHttps).not.toHaveBeenCalled();
  for (const constructor of Object.values(cloud)) expect(constructor).not.toHaveBeenCalled();
}, 20_000);
