import { EventHubProducerClient } from "@azure/event-hubs";
import type { RaceSplit, SessionMetric } from "../models/index.js";

export interface EventstreamConfig {
  connectionString: string;
  fullyQualifiedNamespace: string;
  eventHubName: string;
}

export type EventstreamEntityType = "SessionMetric" | "RaceSplit";

export interface EventstreamTargetDescription {
  fullyQualifiedNamespace: string;
  eventHubName: string;
  route: "eventstream-custom-endpoint";
}

export interface EventstreamPublisher {
  publishSessionMetrics(metrics: readonly SessionMetric[]): Promise<number>;
  publishRaceSplits(splits: readonly RaceSplit[]): Promise<number>;
  close(): Promise<void>;
  describeTarget(): EventstreamTargetDescription;
}

type EventstreamRecordMap = {
  SessionMetric: SessionMetric;
  RaceSplit: RaceSplit;
};

interface EventstreamEnvelope<T extends EventstreamEntityType> {
  body: {
    entityType: T;
  } & EventstreamRecordMap[T];
  contentType: "application/json";
}

interface EventstreamBatch {
  readonly count: number;
  tryAdd(event: EventstreamEnvelope<EventstreamEntityType>): boolean;
}

type EventstreamProducerClient = Pick<EventHubProducerClient, "createBatch" | "sendBatch" | "close">;

export const EVENTSTREAM_ROUTE = "eventstream-custom-endpoint" as const;
export const SESSIONMETRIC_MAPPING_NAME = "sessionmetric_json_map" as const;
export const RACESPLIT_MAPPING_NAME = "racesplit_json_map" as const;

function requireNonEmptyEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }

  return value;
}

/**
 * Parses the Event Hubs-compatible namespace and entity (hub) name out of the SAS connection
 * string returned by Eventstream's "Get Eventstream Source Connection" API.
 */
export function parseEventHubConnectionString(connectionString: string): {
  fullyQualifiedNamespace: string;
  eventHubName: string;
} {
  const endpointMatch = /Endpoint=sb:\/\/([^;/]+)/i.exec(connectionString);
  const entityPathMatch = /EntityPath=([^;]+)/i.exec(connectionString);

  if (!endpointMatch) {
    throw new Error(
      "EVENTSTREAM_EVENTHUB_CONNECTION_STRING is missing an 'Endpoint=sb://<namespace>/' segment.",
    );
  }

  if (!entityPathMatch) {
    throw new Error(
      "EVENTSTREAM_EVENTHUB_CONNECTION_STRING is missing an 'EntityPath=<hub-name>' segment " +
        "(required -- the Eventstream-minted connection string always embeds the target hub name).",
    );
  }

  return { fullyQualifiedNamespace: endpointMatch[1]!, eventHubName: entityPathMatch[1]! };
}

export function getEventstreamConfigFromEnv(): EventstreamConfig {
  const connectionString = requireNonEmptyEnv("EVENTSTREAM_EVENTHUB_CONNECTION_STRING");
  const { fullyQualifiedNamespace, eventHubName } = parseEventHubConnectionString(connectionString);

  return { connectionString, fullyQualifiedNamespace, eventHubName };
}

function buildEnvelope<T extends EventstreamEntityType>(
  entityType: T,
  record: EventstreamRecordMap[T],
): EventstreamEnvelope<T> {
  return {
    body: {
      entityType,
      ...record,
    },
    contentType: "application/json",
  };
}

function getEntityId(record: SessionMetric | RaceSplit): string {
  return "sessionId" in record ? record.sessionId : record.raceId;
}

export class EventstreamTelemetryPublisher implements EventstreamPublisher {
  private readonly client: EventstreamProducerClient;

  constructor(private readonly config: EventstreamConfig, client?: EventstreamProducerClient) {
    this.client = client ?? new EventHubProducerClient(config.connectionString);
  }

  async publishSessionMetrics(metrics: readonly SessionMetric[]): Promise<number> {
    return this.publish("SessionMetric", metrics);
  }

  async publishRaceSplits(splits: readonly RaceSplit[]): Promise<number> {
    return this.publish("RaceSplit", splits);
  }

  describeTarget(): EventstreamTargetDescription {
    return {
      fullyQualifiedNamespace: this.config.fullyQualifiedNamespace,
      eventHubName: this.config.eventHubName,
      route: EVENTSTREAM_ROUTE,
    };
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private async publish<T extends EventstreamEntityType>(
    entityType: T,
    records: readonly EventstreamRecordMap[T][],
  ): Promise<number> {
    if (records.length === 0) {
      return 0;
    }

    let batch = (await this.client.createBatch()) as EventstreamBatch;
    let publishedCount = 0;

    for (const record of records) {
      const event = buildEnvelope(entityType, record);

      if (!batch.tryAdd(event)) {
        await this.client.sendBatch(batch as never);
        batch = (await this.client.createBatch()) as EventstreamBatch;

        if (!batch.tryAdd(event)) {
          throw new Error(`${entityType} event for ${getEntityId(record)} exceeded the Event Hubs batch size.`);
        }
      }

      publishedCount += 1;
    }

    if (batch.count > 0) {
      await this.client.sendBatch(batch as never);
    }

    return publishedCount;
  }
}

export function createDefaultEventstreamPublisher(): EventstreamPublisher {
  return new EventstreamTelemetryPublisher(getEventstreamConfigFromEnv());
}
