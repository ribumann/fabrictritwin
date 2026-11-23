import { EventHubProducerClient } from "@azure/event-hubs";
import { parseEventHubConnectionString } from "../services/eventstream-client.js";
import { assertD01ConnectionMeasurementEvent } from "./connection-events.js";
import type { D01ConnectionMeasurementEvent } from "./connection-events.js";

export const D01_CONNECTION_PUBLISHER_MAX_EVENTS = 200;

export interface D01ConnectionPublisher {
  /** Opens the sender without sending an event. */
  prepare?(signal: AbortSignal): Promise<void>;
  /** Sends one sample's bounded raw events without merging them into legacy telemetry. */
  publish(events: readonly D01ConnectionMeasurementEvent[], signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

type Producer = Pick<EventHubProducerClient, "createBatch" | "sendBatch" | "close">;

/** Returns the non-secret target identity so legacy and connection routes can be kept separate. */
export function getD01EventstreamTarget(connectionString: string): {
  fullyQualifiedNamespace: string;
  eventHubName: string;
} {
  return parseEventHubConnectionString(connectionString);
}

/** Validates the explicit SAS-send configuration without opening a client or sending data. */
export function assertD01ConnectionEventstreamConfiguration(connectionString: string): {
  fullyQualifiedNamespace: string;
  eventHubName: string;
} {
  const target = getD01EventstreamTarget(connectionString);
  if (
    !/SharedAccessKeyName=[^;]+;/i.test(connectionString) ||
    !/SharedAccessKey=[^;]+/i.test(connectionString)
  ) {
    throw new Error("Mining connection Eventstream requires explicit source SAS credentials.");
  }
  return target;
}

/**
 * A separate Event Hubs producer for ConnectionMeasurement. Its connection string must target
 * the dedicated connection-flow source, never the existing legacy Eventstream route.
 */
export class D01ConnectionEventstreamPublisher implements D01ConnectionPublisher {
  private readonly client: Producer;

  constructor(
    connectionString: string,
    client?: Producer,
    private readonly unpinnedStream = false,
  ) {
    assertD01ConnectionEventstreamConfiguration(connectionString);
    this.client =
      client ??
      new EventHubProducerClient(connectionString, {
        retryOptions: { maxRetries: 0, timeoutInMs: 10_000 },
      });
  }

  async prepare(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.client.createBatch({ abortSignal: signal });
    signal.throwIfAborted();
  }

  async publish(
    events: readonly D01ConnectionMeasurementEvent[],
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    if (events.length === 0) return;
    if (events.length > D01_CONNECTION_PUBLISHER_MAX_EVENTS) {
      throw new RangeError("D01 connection sample exceeds the 200-event transport bound.");
    }

    const first = events[0]!;
    const eventIds = new Set<string>();
    let previousSequence = 0;
    for (const event of events) {
      assertD01ConnectionMeasurementEvent(event);
      if (
        event.run_id !== first.run_id ||
        event.sample_time !== first.sample_time ||
        eventIds.has(event.event_id) ||
        event.sequence <= previousSequence
      ) {
        throw new TypeError(
          "D01 connection batch must contain unique, ordered events for one sample.",
        );
      }
      eventIds.add(event.event_id);
      previousSequence = event.sequence;
    }

    let batch = await this.client.createBatch({ abortSignal: signal });
    signal.throwIfAborted();
    for (const measurement of events) {
      const body = this.unpinnedStream
        ? {
            ...Object.fromEntries(
              Object.entries(measurement).filter(
                ([key]) => !["run_id", "event_id", "sequence"].includes(key),
              ),
            ),
            schema_version: 2,
          }
        : measurement;
      const event = { body, contentType: "application/json" };
      if (!batch.tryAdd(event)) {
        if (batch.count === 0) {
          throw new Error("D01 connection measurement exceeds the Event Hubs batch size.");
        }
        await this.client.sendBatch(batch, { abortSignal: signal });
        signal.throwIfAborted();
        batch = await this.client.createBatch({ abortSignal: signal });
        signal.throwIfAborted();
        if (!batch.tryAdd(event)) {
          throw new Error("D01 connection measurement exceeds the Event Hubs batch size.");
        }
      }
    }
    if (batch.count > 0) {
      await this.client.sendBatch(batch, { abortSignal: signal });
      signal.throwIfAborted();
    }
  }

  close(): Promise<void> {
    return this.client.close();
  }
}
