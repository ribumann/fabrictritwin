import { describe, expect, it, vi } from "vitest";
import {
  D01ConnectionEventstreamPublisher,
  assertD01ConnectionEventstreamConfiguration,
  createD01ConnectionSimulation,
  getD01EventstreamTarget,
} from "../src/mining/index.js";

const connectionString =
  "Endpoint=sb://d01-connection.servicebus.windows.net/;" +
  "SharedAccessKeyName=send;SharedAccessKey=not-a-real-secret;EntityPath=d01-connection-flow";

function firstSample() {
  const simulator = createD01ConnectionSimulation(
    {
      runId: "connection-publisher-test",
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      durationSeconds: 5,
      scenario: "normal",
    },
    () => Date.now(),
  );
  return simulator.step(new Date("2026-01-01T00:00:05.000Z")).batch.events;
}

describe("D01 shared-flow Eventstream publisher", () => {
  it("prepares the sender without publishing a measurement", async () => {
    const createBatch = vi.fn(async () => ({ count: 0, tryAdd: () => true }));
    const sendBatch = vi.fn(async () => {});
    const publisher = new D01ConnectionEventstreamPublisher(connectionString, {
      createBatch,
      sendBatch,
      close: vi.fn(async () => {}),
    } as never);
    const signal = new AbortController().signal;
    await publisher.prepare(signal);
    expect(createBatch).toHaveBeenCalledWith({ abortSignal: signal });
    expect(sendBatch).not.toHaveBeenCalled();
  });
  it("parses a non-secret destination identity", () => {
    expect(getD01EventstreamTarget(connectionString)).toEqual({
      fullyQualifiedNamespace: "d01-connection.servicebus.windows.net",
      eventHubName: "d01-connection-flow",
    });
  });

  it("fails closed without explicit source SAS credentials", () => {
    expect(() =>
      assertD01ConnectionEventstreamConfiguration(
        "Endpoint=sb://d01-connection.servicebus.windows.net/;" + "EntityPath=d01-connection-flow",
      ),
    ).toThrow("explicit source SAS credentials");
  });

  it("splits one raw sample into bounded Event Hubs batches without changing event bodies", async () => {
    const sent: unknown[] = [];
    const createBatch = vi.fn(async () => {
      const events: unknown[] = [];
      return {
        get count() {
          return events.length;
        },
        tryAdd(event: unknown) {
          if (events.length === 10) return false;
          events.push(event);
          return true;
        },
        events,
      };
    });
    const sendBatch = vi.fn(async (batch: { events: unknown[] }) => {
      sent.push(...batch.events);
    });
    const close = vi.fn(async () => {});
    const publisher = new D01ConnectionEventstreamPublisher(connectionString, {
      createBatch,
      sendBatch,
      close,
    } as never);
    const sample = firstSample();

    await publisher.publish(sample, new AbortController().signal);

    expect(sample).toHaveLength(57);
    expect(createBatch).toHaveBeenCalledTimes(6);
    expect(sendBatch).toHaveBeenCalledTimes(6);
    expect(sent.map((item) => (item as { body: unknown }).body)).toEqual(sample);
    expect(close).not.toHaveBeenCalled();
    await publisher.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("publishes unpinned observations without run or sequence identifiers", async () => {
    const sent: { body: Record<string, unknown> }[] = [];
    const createBatch = vi.fn(async () => ({
      get count() {
        return sent.length;
      },
      tryAdd(event: { body: Record<string, unknown> }) {
        sent.push(event);
        return true;
      },
    }));
    const publisher = new D01ConnectionEventstreamPublisher(
      connectionString,
      { createBatch, sendBatch: vi.fn(async () => {}), close: vi.fn(async () => {}) } as never,
      true,
    );
    await publisher.publish(firstSample(), new AbortController().signal);
    expect(sent).toHaveLength(57);
    for (const { body } of sent) {
      expect(body.schema_version).toBe(2);
      expect(body).not.toHaveProperty("run_id");
      expect(body).not.toHaveProperty("event_id");
      expect(body).not.toHaveProperty("sequence");
      expect(body).toHaveProperty("measurement_tag_id");
      expect(body).toHaveProperty("sample_time");
    }
  });

  it("rejects oversized or cross-sample batches before sending", async () => {
    const sendBatch = vi.fn(async () => {});
    const publisher = new D01ConnectionEventstreamPublisher(connectionString, {
      createBatch: vi.fn(async () => ({
        count: 0,
        tryAdd: () => true,
      })),
      sendBatch,
      close: vi.fn(async () => {}),
    } as never);
    const [event] = firstSample();

    await expect(
      publisher.publish(
        Array.from({ length: 201 }, () => event!),
        new AbortController().signal,
      ),
    ).rejects.toThrow("200-event transport bound");
    await expect(
      publisher.publish(
        [event!, { ...event!, sample_time: "2026-01-01T00:00:10.000Z" }],
        new AbortController().signal,
      ),
    ).rejects.toThrow("one sample");
    expect(sendBatch).not.toHaveBeenCalled();
  });
});
