import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  requireAthleteAuthorization,
  resetPrincipalAthleteMapCacheForTests,
  resolveAuthorizedAthleteId,
  resolveCallerPrincipalId,
} from "../src/auth/authorization.js";

const ATHLETE_ID = "11111111-1111-1111-1111-111111111111";
const PRINCIPAL_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_ATHLETE_ID = "33333333-3333-3333-3333-333333333333";

function buildTestApp(getRequestedAthleteId: (req: express.Request) => string | undefined) {
  const app = express();
  app.use(express.json());
  app.get(
    "/api/athletes/:athleteId",
    requireAthleteAuthorization(getRequestedAthleteId),
    (req, res) => {
      res.status(200).json({ ok: true });
    },
  );
  return app;
}

describe("resolveCallerPrincipalId", () => {
  it("reads the dedicated X-MS-CLIENT-PRINCIPAL-ID header when present", () => {
    const req = { headers: { "x-ms-client-principal-id": PRINCIPAL_ID } } as unknown as express.Request;
    expect(resolveCallerPrincipalId(req)).toBe(PRINCIPAL_ID);
  });

  it("falls back to decoding the base64 X-MS-CLIENT-PRINCIPAL header", () => {
    const claimsPayload = Buffer.from(
      JSON.stringify({ claims: [{ typ: "oid", val: PRINCIPAL_ID }] }),
    ).toString("base64");
    const req = { headers: { "x-ms-client-principal": claimsPayload } } as unknown as express.Request;
    expect(resolveCallerPrincipalId(req)).toBe(PRINCIPAL_ID);
  });

  it("returns undefined when no identity headers are present", () => {
    const req = { headers: {} } as unknown as express.Request;
    expect(resolveCallerPrincipalId(req)).toBeUndefined();
  });

  it("returns undefined (never throws) for a malformed X-MS-CLIENT-PRINCIPAL header", () => {
    const req = { headers: { "x-ms-client-principal": "not-valid-base64-json" } } as unknown as express.Request;
    expect(resolveCallerPrincipalId(req)).toBeUndefined();
  });
});

describe("resolveAuthorizedAthleteId", () => {
  beforeEach(() => {
    process.env.ATHLETE_PRINCIPAL_MAP = JSON.stringify({ [PRINCIPAL_ID]: ATHLETE_ID });
    resetPrincipalAthleteMapCacheForTests();
  });

  afterEach(() => {
    delete process.env.ATHLETE_PRINCIPAL_MAP;
    resetPrincipalAthleteMapCacheForTests();
  });

  it("resolves the mapped athleteId for a known principal", () => {
    const req = { headers: { "x-ms-client-principal-id": PRINCIPAL_ID } } as unknown as express.Request;
    expect(resolveAuthorizedAthleteId(req)).toBe(ATHLETE_ID);
  });

  it("returns undefined for an unmapped principal", () => {
    const req = { headers: { "x-ms-client-principal-id": "unknown-principal" } } as unknown as express.Request;
    expect(resolveAuthorizedAthleteId(req)).toBeUndefined();
  });

  it("fails closed (returns undefined) when ATHLETE_PRINCIPAL_MAP is malformed JSON", () => {
    process.env.ATHLETE_PRINCIPAL_MAP = "{not-json";
    resetPrincipalAthleteMapCacheForTests();
    const req = { headers: { "x-ms-client-principal-id": PRINCIPAL_ID } } as unknown as express.Request;
    expect(resolveAuthorizedAthleteId(req)).toBeUndefined();
  });
});

describe("requireAthleteAuthorization middleware (FR-017)", () => {
  beforeEach(() => {
    process.env.ATHLETE_PRINCIPAL_MAP = JSON.stringify({ [PRINCIPAL_ID]: ATHLETE_ID });
    resetPrincipalAthleteMapCacheForTests();
  });

  afterEach(() => {
    delete process.env.ATHLETE_PRINCIPAL_MAP;
    resetPrincipalAthleteMapCacheForTests();
  });

  it("proceeds (200) when the requested athleteId matches the authorized athlete", async () => {
    const app = buildTestApp((req) => req.params.athleteId);
    const res = await request(app)
      .get(`/api/athletes/${ATHLETE_ID}`)
      .set("x-ms-client-principal-id", PRINCIPAL_ID);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("rejects with 403 and the contract error body on athleteId mismatch (negative test, FR-017)", async () => {
    const app = buildTestApp((req) => req.params.athleteId);
    const res = await request(app)
      .get(`/api/athletes/${OTHER_ATHLETE_ID}`)
      .set("x-ms-client-principal-id", PRINCIPAL_ID);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: { code: "forbidden", message: "Not authorized for this athlete." },
    });
  });

  it("rejects with 403 when no identity headers are present at all", async () => {
    const app = buildTestApp((req) => req.params.athleteId);
    const res = await request(app).get(`/api/athletes/${ATHLETE_ID}`);
    expect(res.status).toBe(403);
  });

  it("rejects with 403 when the requested athleteId is empty/undefined", async () => {
    const app = buildTestApp(() => undefined);
    const res = await request(app)
      .get(`/api/athletes/${ATHLETE_ID}`)
      .set("x-ms-client-principal-id", PRINCIPAL_ID);
    expect(res.status).toBe(403);
  });
});
