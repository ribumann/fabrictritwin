import { EventHubProducerClient } from "@azure/event-hubs";
import { D01_CATALOG_VERSION } from "./catalog.js";
import {
  D01_CONNECTION_MEASUREMENT_CATALOG_VERSION,
  D01_CONNECTION_PROFILE_VERSION,
} from "./connection-catalog.js";
import { assertD01ConnectionEventstreamConfiguration } from "./connection-publisher.js";

export interface D01ConnectionRunPin {
  plant_id: "D01";
  run_id: string;
  catalog_version: typeof D01_CATALOG_VERSION;
  measurement_catalog_version: typeof D01_CONNECTION_MEASUREMENT_CATALOG_VERSION;
  profile_version: typeof D01_CONNECTION_PROFILE_VERSION;
  started_at: string;
}

type Producer = Pick<EventHubProducerClient, "createBatch" | "sendBatch" | "close">;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Sends one pin request; the caller must independently confirm its Fabric receipt. */
export class D01ConnectionRunPinPublisher {
  private readonly client: Producer;

  constructor(
    connectionString: string,
    client?: Producer,
    private readonly now: () => number = Date.now,
  ) {
    assertD01ConnectionEventstreamConfiguration(connectionString);
    this.client =
      client ??
      new EventHubProducerClient(connectionString, {
        retryOptions: { maxRetries: 0, timeoutInMs: 10_000 },
      });
  }

  async publish(pin: D01ConnectionRunPin, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const started = Date.parse(pin.started_at);
    if (
      pin.plant_id !== "D01" ||
      !uuid.test(pin.run_id) ||
      pin.catalog_version !== D01_CATALOG_VERSION ||
      pin.measurement_catalog_version !== D01_CONNECTION_MEASUREMENT_CATALOG_VERSION ||
      pin.profile_version !== D01_CONNECTION_PROFILE_VERSION ||
      !Number.isFinite(started) ||
      new Date(started).toISOString() !== pin.started_at
    ) {
      throw new TypeError("Invalid D01 connection run pin.");
    }
    const requestedAt = this.now();
    if (!Number.isFinite(requestedAt)) throw new TypeError("Invalid connection pin request time.");
    const body = {
      entityType: "ConnectionRunProfile",
      schema_version: 1,
      plant_id: pin.plant_id,
      run_id: pin.run_id,
      catalog_version: pin.catalog_version,
      measurement_catalog_version: pin.measurement_catalog_version,
      profile_version: pin.profile_version,
      started_at: pin.started_at,
      requested_at: new Date(requestedAt).toISOString(),
    };
    const batch = await this.client.createBatch({ abortSignal: signal });
    signal.throwIfAborted();
    if (!batch.tryAdd({ body, contentType: "application/json" })) {
      throw new Error("D01 connection run pin exceeds the Event Hubs batch size.");
    }
    await this.client.sendBatch(batch, { abortSignal: signal });
    signal.throwIfAborted();
  }

  close(): Promise<void> {
    return this.client.close();
  }
}
