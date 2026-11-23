import { setTimeout as delay } from "node:timers/promises";
import {
  D01ConnectionRunPinPublisher,
  assertD01ConnectionEventstreamConfiguration,
  getD01EventstreamTarget,
  type D01ConnectionRunPin,
} from "@triathlon-twin/simulator/mining";
import type { MiningConnectionRunProfilePinHandler } from "./publisher-runtime.js";
import { MiningQueryError, createBoundedMiningQuery } from "./read/bounded-query.js";

type Query = ReturnType<typeof createBoundedMiningQuery>;
interface PinPublisher {
  publish(pin: D01ConnectionRunPin, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

function instant(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(value)) {
    throw new MiningQueryError("malformed", "Connection pin has an invalid timestamp.");
  }
  const parsed = Date.parse(value);
  const ms = value.replace(
    /(?:\.(\d{1,7}))?Z$/,
    (_, fraction: string | undefined) => `.${(fraction ?? "").padEnd(3, "0").slice(0, 3)}Z`,
  );
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== ms) {
    throw new MiningQueryError("malformed", "Connection pin has an invalid timestamp.");
  }
  return value.replace(
    /(?:\.(\d{1,7}))?Z$/,
    (_, fraction: string | undefined) => `.${(fraction ?? "").padEnd(7, "0")}Z`,
  );
}

/** Send once; empty readback may be polled, but ambiguous sends are never retried. */
export function createConnectionRunPinHandler(
  query: Query,
  openPublisher: () => PinPublisher,
  wait: (signal: AbortSignal) => Promise<void> = (signal) => delay(1000, undefined, { signal }),
): MiningConnectionRunProfilePinHandler {
  return async (pin, signal) => {
    signal.throwIfAborted();
    const existing = await query(
      { kind: "connection-run-pin", runId: pin.run_id, maxRows: 2 },
      signal,
    );
    signal.throwIfAborted();
    if (existing.length !== 0) {
      throw new MiningQueryError("upstream", "Connection run pin already exists; reconcile it.");
    }

    const publisher = openPublisher();
    let sendFailure: unknown;
    let sendFailed = false;
    try {
      await publisher.publish(pin, signal);
    } catch (error) {
      sendFailed = true;
      sendFailure = error;
    }
    try {
      await publisher.close();
    } catch (error) {
      if (sendFailed) {
        throw new AggregateError([sendFailure, error], "Connection pin send and cleanup failed.", {
          cause: error,
        });
      }
      throw error;
    }
    if (sendFailed) throw sendFailure;
    signal.throwIfAborted();
    for (;;) {
      const rows = await query(
        { kind: "connection-run-pin", runId: pin.run_id, maxRows: 2 },
        signal,
      );
      signal.throwIfAborted();
      if (rows.length === 0) {
        await wait(signal);
        signal.throwIfAborted();
        continue;
      }
      if (rows.length !== 1) {
        throw new MiningQueryError("upstream", "Connection run pin is ambiguous.");
      }
      const row = rows[0];
      if (
        row.plant_id !== pin.plant_id ||
        row.run_id !== pin.run_id ||
        row.catalog_version !== pin.catalog_version ||
        row.measurement_catalog_version !== pin.measurement_catalog_version ||
        row.profile_version !== pin.profile_version ||
        (row.start_policy || undefined) !== pin.start_policy ||
        instant(row.started_at) !== instant(pin.started_at)
      ) {
        throw new MiningQueryError(
          "upstream",
          "Connection run pin does not match the admitted run.",
        );
      }
      instant(row.pinned_at);
      return instant(row.received_at);
    }
  };
}

/** Explicit opt-in; the legacy Eventstream must never receive profile pins. */
export function configuredConnectionRunPinHandler(
  env: NodeJS.ProcessEnv,
): MiningConnectionRunProfilePinHandler | undefined {
  if (env.MINING_UNPINNED_STREAM_ENABLED === "true") return undefined;
  if (
    env.MINING_CONNECTION_PIN_EVENTSTREAM_ENABLED !== undefined &&
    !["true", "false"].includes(env.MINING_CONNECTION_PIN_EVENTSTREAM_ENABLED)
  ) {
    throw new MiningQueryError("configuration", "Invalid connection pin transport setting.");
  }
  if (env.MINING_CONNECTION_PIN_EVENTSTREAM_ENABLED !== "true") return undefined;
  const connection = env.MINING_CONNECTION_EVENTSTREAM_EVENTHUB_CONNECTION_STRING;
  const legacy = env.MINING_EVENTSTREAM_EVENTHUB_CONNECTION_STRING;
  if (env.MINING_CONNECTION_FLOW_ENABLED !== "true" || !connection || !legacy) {
    throw new MiningQueryError("configuration", "Connection pin transport is not configured.");
  }
  const target = assertD01ConnectionEventstreamConfiguration(connection);
  const oldTarget = getD01EventstreamTarget(legacy);
  if (
    target.fullyQualifiedNamespace.toLowerCase() ===
      oldTarget.fullyQualifiedNamespace.toLowerCase() &&
    target.eventHubName.toLowerCase() === oldTarget.eventHubName.toLowerCase()
  ) {
    throw new MiningQueryError(
      "configuration",
      "Connection pin transport must use a separate Eventstream.",
    );
  }
  const query = createBoundedMiningQuery({
    ...env,
    EVENTHOUSE_QUERY_URI: env.MINING_EVENTHOUSE_QUERY_URI,
    EVENTHOUSE_DATABASE_NAME: env.MINING_EVENTHOUSE_DATABASE_NAME,
  });
  return createConnectionRunPinHandler(query, () => new D01ConnectionRunPinPublisher(connection));
}
