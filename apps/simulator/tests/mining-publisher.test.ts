import { describe, expect, it, vi } from "vitest";
import { D01EventstreamPublisher, type D01TransportBody } from "../src/mining/index.js";
import type { EventDataBatch, EventHubProducerClient } from "@azure/event-hubs";

const connection =
  "Endpoint=sb://mining.example.invalid/;SharedAccessKeyName=demo;SharedAccessKey=fictional;EntityPath=mining";
const events: D01TransportBody[] = [
  {
    entityType: "PlantStateEvent",
    schema_version: 2,
    plant_id: "D01",
    run_id: "demo",
    event_id: "state-1",
    sequence: 1,
    timestamp: "2026-01-01T00:00:00Z",
    scope_id: "A",
    scheduled_running: true,
    state: "running",
  },
];

function setup(tryAdd = vi.fn(() => true)) {
  const batch: EventDataBatch = { count: 1, tryAdd, sizeInBytes: 100, maxSizeInBytes: 1_000 };
  const client: Pick<EventHubProducerClient, "createBatch" | "sendBatch" | "close"> = {
    createBatch: vi.fn(async () => batch),
    sendBatch: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  return { client, publisher: new D01EventstreamPublisher(connection, client), tryAdd };
}

describe("mining Eventstream transport", () => {
  it("uses the existing flat event body and passes cancellation to create and send", async () => {
    const { client, publisher, tryAdd } = setup();
    const signal = new AbortController().signal;
    await publisher.publish(events, signal);
    expect(tryAdd).toHaveBeenCalledWith({ body: events[0], contentType: "application/json" });
    expect(client.createBatch).toHaveBeenCalledWith({ abortSignal: signal });
    expect(client.sendBatch).toHaveBeenCalledWith(expect.anything(), { abortSignal: signal });
    await publisher.close();
    expect(client.close).toHaveBeenCalledOnce();
  });
  it("propagates uncertain sends without retry", async () => {
    const { client, publisher } = setup();
    vi.mocked(client.sendBatch).mockRejectedValue(new Error("uncertain"));
    await expect(publisher.publish(events, new AbortController().signal)).rejects.toThrow(
      "uncertain",
    );
    expect(client.sendBatch).toHaveBeenCalledOnce();
  });
  it("refuses already-aborted work and success returned after abort", async () => {
    const { client, publisher } = setup();
    const abort = new AbortController();
    abort.abort();
    await expect(publisher.publish(events, abort.signal)).rejects.toThrow();
    expect(client.createBatch).not.toHaveBeenCalled();
    const inFlight = new AbortController();
    vi.mocked(client.sendBatch).mockImplementation(async () => {
      inFlight.abort();
    });
    await expect(publisher.publish(events, inFlight.signal)).rejects.toThrow();
  });
  it("requires explicit credentials without falling back to triathlon", () => {
    expect(() => new D01EventstreamPublisher("")).toThrow();
    expect(
      () => new D01EventstreamPublisher("Endpoint=sb://mining.example.invalid/;EntityPath=mining"),
    ).toThrow(/credentials/);
  });
});
