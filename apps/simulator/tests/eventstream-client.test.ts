import { afterEach, describe, expect, it } from "vitest";
import {
  EventstreamTelemetryPublisher,
  getEventstreamConfigFromEnv,
  parseEventHubConnectionString,
} from "../src/services/eventstream-client.js";
import { generateLiveSessionMetrics } from "../src/generators/live-session.js";
import { generateRaceDaySplits } from "../src/generators/race-day.js";
import { TEST_ATHLETE, TEST_RACE, TEST_SEED } from "./fixtures.js";

class FakeBatch {
  public readonly events: Array<{ body: Record<string, unknown> }> = [];

  constructor(private readonly capacity: number) {}

  get count(): number {
    return this.events.length;
  }

  tryAdd(event: { body: Record<string, unknown> }): boolean {
    if (this.events.length >= this.capacity) {
      return false;
    }

    this.events.push(event);
    return true;
  }
}

class FakeProducerClient {
  public readonly batches: FakeBatch[] = [];
  public readonly sentBatches: FakeBatch[] = [];
  public closeCalls = 0;

  async createBatch(): Promise<FakeBatch> {
    const batch = new FakeBatch(2);
    this.batches.push(batch);
    return batch;
  }

  async sendBatch(batch: FakeBatch): Promise<void> {
    this.sentBatches.push(batch);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

describe("eventstream client", () => {
  afterEach(() => {
    delete process.env.EVENTSTREAM_EVENTHUB_CONNECTION_STRING;
  });

  it("parses the Eventstream SAS connection string from the environment", () => {
    process.env.EVENTSTREAM_EVENTHUB_CONNECTION_STRING =
      "Endpoint=sb://triathlon-demo.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=abc;EntityPath=triathlon-live";

    expect(parseEventHubConnectionString(process.env.EVENTSTREAM_EVENTHUB_CONNECTION_STRING)).toEqual({
      fullyQualifiedNamespace: "triathlon-demo.servicebus.windows.net",
      eventHubName: "triathlon-live",
    });
    expect(getEventstreamConfigFromEnv()).toEqual({
      connectionString: process.env.EVENTSTREAM_EVENTHUB_CONNECTION_STRING,
      fullyQualifiedNamespace: "triathlon-demo.servicebus.windows.net",
      eventHubName: "triathlon-live",
    });
  });

  it("batches SessionMetric and RaceSplit envelopes with the expected entityType discriminator", async () => {
    const producer = new FakeProducerClient();
    const publisher = new EventstreamTelemetryPublisher(
      {
        connectionString: "Endpoint=sb://triathlon-demo.servicebus.windows.net/;EntityPath=triathlon-live",
        fullyQualifiedNamespace: "triathlon-demo.servicebus.windows.net",
        eventHubName: "triathlon-live",
      },
      producer,
    );
    const liveMetrics = generateLiveSessionMetrics({
      athleteId: TEST_ATHLETE.athleteId,
      discipline: "run",
      plannedDate: "2026-09-03T06:10:00.000Z",
      seed: TEST_SEED,
      sampleCount: 3,
    }).map((tick) => tick.metric);
    const raceSplits = generateRaceDaySplits({
      raceId: TEST_RACE.raceId,
      date: TEST_RACE.date,
      distance: TEST_RACE.distance,
      seed: TEST_SEED,
      splitCount: 5,
    }).map((tick) => tick.split);

    expect(await publisher.publishSessionMetrics(liveMetrics)).toBe(3);
    expect(await publisher.publishRaceSplits(raceSplits)).toBe(5);
    await publisher.close();

    expect(producer.sentBatches).toHaveLength(5);
    expect(producer.sentBatches[0]!.events[0]!.body.entityType).toBe("SessionMetric");
    expect(producer.sentBatches.at(-1)!.events.at(-1)!.body.entityType).toBe("RaceSplit");
    expect(producer.closeCalls).toBe(1);
  });

  it("publishes SessionMetric envelopes with exactly the canonical field set, including a null power sample", async () => {
    const producer = new FakeProducerClient();
    const publisher = new EventstreamTelemetryPublisher(
      {
        connectionString: "Endpoint=sb://triathlon-demo.servicebus.windows.net/;EntityPath=triathlon-live",
        fullyQualifiedNamespace: "triathlon-demo.servicebus.windows.net",
        eventHubName: "triathlon-live",
      },
      producer,
    );
    const liveMetrics = generateLiveSessionMetrics({
      athleteId: TEST_ATHLETE.athleteId,
      discipline: "run",
      plannedDate: "2026-09-03T06:10:00.000Z",
      seed: TEST_SEED,
      sampleCount: 5,
    }).map((tick) => tick.metric);

    await publisher.publishSessionMetrics(liveMetrics);

    const bodies = producer.batches.flatMap((batch) => batch.events.map((event) => event.body));
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(Object.keys(body).sort()).toEqual(
        [
          "entityType",
          "sessionId",
          "timestamp",
          "heartRate",
          "power",
          "pace",
          "cadence",
          "latitude",
          "longitude",
        ].sort(),
      );
      expect(body.entityType).toBe("SessionMetric");
    }
    expect(bodies.some((body) => body.power === null)).toBe(true);
  });

  it("publishes RaceSplit envelopes with exactly the canonical field set", async () => {
    const producer = new FakeProducerClient();
    const publisher = new EventstreamTelemetryPublisher(
      {
        connectionString: "Endpoint=sb://triathlon-demo.servicebus.windows.net/;EntityPath=triathlon-live",
        fullyQualifiedNamespace: "triathlon-demo.servicebus.windows.net",
        eventHubName: "triathlon-live",
      },
      producer,
    );
    const raceSplits = generateRaceDaySplits({
      raceId: TEST_RACE.raceId,
      date: TEST_RACE.date,
      distance: TEST_RACE.distance,
      seed: TEST_SEED,
      splitCount: 6,
    }).map((tick) => tick.split);

    await publisher.publishRaceSplits(raceSplits);

    const bodies = producer.batches.flatMap((batch) => batch.events.map((event) => event.body));
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(Object.keys(body).sort()).toEqual(
        [
          "entityType",
          "raceId",
          "timestamp",
          "distanceCoveredMeters",
          "currentPaceSecPerKm",
          "plannedPaceSecPerKm",
          "currentHeartRate",
          "leg",
          "isFinish",
        ].sort(),
      );
      expect(body.entityType).toBe("RaceSplit");
    }
  });
});
