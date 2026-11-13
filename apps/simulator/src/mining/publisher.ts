import { EventHubProducerClient } from "@azure/event-hubs";
import { parseEventHubConnectionString } from "../services/eventstream-client.js";
import type { D01TransportBody } from "./events.js";

export interface D01Publisher {
  /** Resolves only after every SDK send settles; no automatic retry or detached work. */
  publish(events: readonly D01TransportBody[], signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

type Producer = Pick<EventHubProducerClient, "createBatch" | "sendBatch" | "close">;

/** Same Eventstream Event Hubs-compatible transport as triathlon, with isolated credentials. */
export class D01EventstreamPublisher implements D01Publisher {
  private readonly client: Producer;

  constructor(connectionString: string, client?: Producer) {
    parseEventHubConnectionString(connectionString);
    if (
      !/SharedAccessKeyName=[^;]+;/i.test(connectionString) ||
      !/SharedAccessKey=[^;]+/i.test(connectionString)
    ) {
      throw new Error("Mining Eventstream requires explicit source SAS credentials.");
    }
    this.client =
      client ??
      new EventHubProducerClient(connectionString, {
        retryOptions: { maxRetries: 0, timeoutInMs: 2_000 },
      });
  }

  async publish(events: readonly D01TransportBody[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!events.length) return;
    let batch = await this.client.createBatch({ abortSignal: signal });
    signal.throwIfAborted();
    for (const body of events) {
      const event = { body, contentType: "application/json" };
      if (!batch.tryAdd(event)) {
        if (batch.count === 0) throw new Error("Mining event exceeds the Event Hubs batch size.");
        await this.client.sendBatch(batch, { abortSignal: signal });
        signal.throwIfAborted();
        batch = await this.client.createBatch({ abortSignal: signal });
        signal.throwIfAborted();
        if (!batch.tryAdd(event))
          throw new Error("Mining event exceeds the Event Hubs batch size.");
      }
    }
    await this.client.sendBatch(batch, { abortSignal: signal });
    signal.throwIfAborted();
  }

  close(): Promise<void> {
    return this.client.close();
  }
}
