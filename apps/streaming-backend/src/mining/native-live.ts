import { createHash } from "node:crypto";
import type { D01TransportBody } from "@triathlon-twin/simulator/mining";
import {
  accessToken,
  assertPublicCloudMetadata,
  assertMiningQueryConfiguration,
  identityEndpoint,
  readJson,
} from "./read/bounded-query.js";

export interface MiningNativeReceipt {
  runId: string;
  sampleTime: string;
  receivedAt: string;
  stateCount: number;
  telemetryCount: number;
  reading?: { tagId: string; value: number; unit: string };
}

function nativeTransport(env: NodeJS.ProcessEnv, request: typeof fetch) {
  const uri = env.MINING_EVENTHOUSE_QUERY_URI?.replace(/\/$/, "");
  const db = env.MINING_EVENTHOUSE_DATABASE_NAME;
  return async (
    table: "mining_NativeLiveRaw" | "mining_DemoSignal",
    mapping: string,
    body: string,
    csl: string,
    authority: AbortSignal,
  ) => {
    assertMiningQueryConfiguration({
      ...env,
      EVENTHOUSE_QUERY_URI: env.MINING_EVENTHOUSE_QUERY_URI,
      EVENTHOUSE_DATABASE_NAME: db,
    });
    const signal = AbortSignal.any([authority, AbortSignal.timeout(3_000)]);
    signal.throwIfAborted();
    assertPublicCloudMetadata(
      await readJson(
        await request(`${uri}/v1/rest/auth/metadata`, {
          redirect: "error",
          signal,
        }),
        32_768,
      ),
    );
    const token = accessToken(
      await readJson(
        await request(identityEndpoint(env), {
          headers: { "X-IDENTITY-HEADER": env.IDENTITY_HEADER! },
          redirect: "error",
          signal,
        }),
        32_768,
      ),
      env.MINING_MANAGED_IDENTITY_CLIENT_ID!,
      Date.now(),
    );
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    signal.throwIfAborted();
    const ingest = await request(
      `${uri}/v1/rest/ingest/${encodeURIComponent(db!)}/${table}?streamFormat=Json&mappingName=${mapping}`,
      { method: "POST", headers, body, redirect: "error", signal },
    );
    await ingest.body?.cancel();
    if (!ingest.ok) throw new Error(`Native Mining ingest failed: HTTP ${ingest.status}.`);
    const response = await request(`${uri}/v1/rest/query`, {
      method: "POST",
      headers: { ...headers, "x-ms-readonly": "true" },
      body: JSON.stringify({ db, csl }),
      redirect: "error",
      signal,
    });
    const result = (await readJson(response, 65_536)) as { Tables?: { Rows?: unknown[][] }[] };
    const rows = result.Tables?.[0]?.Rows;
    const row = rows?.[0];
    if (!row || rows?.length !== 1) throw new Error("Native Mining receipt is unavailable.");
    return row;
  };
}

const validKey = (runId: string, sampleTime: string) =>
  /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(runId) &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(sampleTime);

export function createMiningNativeLive(env: NodeJS.ProcessEnv, request = fetch) {
  if (env.MINING_NATIVE_LIVE_ENABLED !== "true") return undefined;
  const stream = nativeTransport(env, request);
  return async (
    runId: string,
    sampleTime: string,
    events: readonly D01TransportBody[],
    authority: AbortSignal,
  ): Promise<MiningNativeReceipt> => {
    if (
      !validKey(runId, sampleTime) ||
      events.length < 1 ||
      events.length > 200 ||
      events.some((event) => event.run_id !== runId)
    )
      throw new Error("Invalid native Mining batch.");
    const body = events
      .map((event) =>
        JSON.stringify({
          event,
          timestamp_raw: event.timestamp,
          batch_time: sampleTime,
          run_id: runId,
        }),
      )
      .join("\n");
    const row = await stream(
      "mining_NativeLiveRaw",
      "mining_native_live_map",
      body,
      `mining_NativeLiveReceipt("${runId}", datetime(${sampleTime}))`,
      authority,
    );
    const [stateCount, telemetryCount, copies, receivedAt, tagId, value, unit, fingerprint] = row;
    const expectedState = events.filter((event) => event.entityType === "PlantStateEvent").length;
    const expectedFingerprint = createHash("sha256")
      .update(
        events
          .map((event) => event.event_id)
          .sort()
          .join("\n"),
      )
      .digest("hex");
    if (
      stateCount !== expectedState ||
      telemetryCount !== events.length - expectedState ||
      copies !== events.length ||
      fingerprint !== expectedFingerprint ||
      typeof receivedAt !== "string" ||
      !Number.isFinite(Date.parse(receivedAt))
    )
      throw new Error("Native Mining receipt did not validate the full batch.");
    return {
      runId,
      sampleTime,
      receivedAt,
      stateCount,
      telemetryCount,
      ...(typeof tagId === "string" &&
      tagId &&
      typeof value === "number" &&
      Number.isFinite(value) &&
      typeof unit === "string"
        ? { reading: { tagId, value, unit } }
        : {}),
    };
  };
}

export function createMiningDemoSignal(env: NodeJS.ProcessEnv, request = fetch) {
  if (env.MINING_DEMO_SIGNAL_ENABLED !== "true") return undefined;
  const stream = nativeTransport(env, request);
  return async (
    point: { runId: string; sampleTime: string; hopperTonnes: number },
    elapsedSeconds: number,
    authority: AbortSignal,
  ) => {
    const { runId, sampleTime, hopperTonnes } = point;
    if (
      !validKey(runId, sampleTime) ||
      !Number.isFinite(hopperTonnes) ||
      hopperTonnes < 0 ||
      hopperTonnes > 1200 ||
      !Number.isSafeInteger(elapsedSeconds) ||
      elapsedSeconds <= 0 ||
      elapsedSeconds % 5 !== 0
    )
      throw new Error("Invalid Mining demo signal.");
    const [copies, value, receivedAt, avg30, avg60] = await stream(
      "mining_DemoSignal",
      "mining_demo_signal_map",
      JSON.stringify({ runId, sampleTime, hopperTonnes, elapsedSeconds }),
      `mining_DemoSignalReceipt("${runId}", datetime(${sampleTime}), ${elapsedSeconds})`,
      authority,
    );
    if (
      copies !== 1 ||
      value !== hopperTonnes ||
      typeof receivedAt !== "string" ||
      !Number.isFinite(Date.parse(receivedAt)) ||
      Date.parse(receivedAt) < Date.parse(sampleTime)
    ) {
      throw new Error("Mining demo signal receipt did not match.");
    }
    return {
      ...point,
      receivedAt,
      ...(elapsedSeconds % 30 === 0 && typeof avg30 === "number" && Number.isFinite(avg30)
        ? { avg30 }
        : {}),
      ...(elapsedSeconds % 60 === 0 && typeof avg60 === "number" && Number.isFinite(avg60)
        ? { avg60 }
        : {}),
    };
  };
}
