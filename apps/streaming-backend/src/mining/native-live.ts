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

export function createMiningNativeLive(env: NodeJS.ProcessEnv, request = fetch) {
  if (env.MINING_NATIVE_LIVE_ENABLED !== "true") return undefined;
  const uri = env.MINING_EVENTHOUSE_QUERY_URI?.replace(/\/$/, "");
  const db = env.MINING_EVENTHOUSE_DATABASE_NAME;
  return async (
    runId: string,
    sampleTime: string,
    events: readonly D01TransportBody[],
    authority: AbortSignal,
  ): Promise<MiningNativeReceipt> => {
    assertMiningQueryConfiguration({
      ...env,
      EVENTHOUSE_QUERY_URI: env.MINING_EVENTHOUSE_QUERY_URI,
      EVENTHOUSE_DATABASE_NAME: db,
    });
    if (
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(runId) ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(sampleTime) ||
      events.length < 1 ||
      events.length > 200 ||
      events.some((event) => event.run_id !== runId)
    ) {
      throw new Error("Invalid native Mining batch.");
    }
    const signal = AbortSignal.any([authority, AbortSignal.timeout(3_000)]);
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
    const batch = events
      .map((event) =>
        JSON.stringify({
          event,
          timestamp_raw: event.timestamp,
          batch_time: sampleTime,
          run_id: runId,
        }),
      )
      .join("\n");
    const ingest = await request(
      `${uri}/v1/rest/ingest/${encodeURIComponent(db!)}/mining_NativeLiveRaw?streamFormat=Json&mappingName=mining_native_live_map`,
      { method: "POST", headers, body: batch, redirect: "error", signal },
    );
    await ingest.body?.cancel();
    if (!ingest.ok) throw new Error(`Native Mining ingest failed: HTTP ${ingest.status}.`);
    const response = await request(`${uri}/v1/rest/query`, {
      method: "POST",
      headers: { ...headers, "x-ms-readonly": "true" },
      body: JSON.stringify({
        db,
        csl: `mining_NativeLiveReceipt("${runId}", datetime(${sampleTime}))`,
      }),
      redirect: "error",
      signal,
    });
    const result = (await readJson(response, 65_536)) as { Tables?: { Rows?: unknown[][] }[] };
    const rows = result.Tables?.[0]?.Rows;
    const row = rows?.[0];
    if (!row || rows?.length !== 1) throw new Error("Native Mining receipt is unavailable.");
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
