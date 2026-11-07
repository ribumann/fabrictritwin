import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";

const requiredEnv = {
  LAKEHOUSE_ONELAKE_ACCOUNT_URL: "https://example.dfs.fabric.microsoft.com",
  LAKEHOUSE_ONELAKE_FILESYSTEM: "workspace-guid",
  LAKEHOUSE_ONELAKE_PATH: "lakehouse-guid",
};

describe("streaming-backend /healthz", () => {
  beforeEach(() => {
    Object.assign(process.env, requiredEnv);
  });

  afterEach(() => {
    delete process.env.LAKEHOUSE_ONELAKE_ACCOUNT_URL;
    delete process.env.LAKEHOUSE_ONELAKE_FILESYSTEM;
    delete process.env.LAKEHOUSE_ONELAKE_PATH;
  });

  it(
    "returns 200 ok",
    async () => {
    const { app } = await import("../src/index.js");
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    },
    20_000,
  );
});
