import { describe, expect, it, vi } from "vitest";
import {
  D01_CATALOG_VERSION,
  D01_CONNECTION_MEASUREMENT_CATALOG_VERSION,
  D01_CONNECTION_PROFILE_VERSION,
  D01ConnectionRunPinPublisher,
} from "../src/mining/index.js";

const connectionString =
  "Endpoint=sb://d01-connection.servicebus.windows.net/;" +
  "SharedAccessKeyName=send;SharedAccessKey=not-a-real-secret;EntityPath=d01-connection-flow";
const pin = {
  plant_id: "D01" as const,
  run_id: "11111111-1111-4111-8111-111111111111",
  catalog_version: D01_CATALOG_VERSION,
  measurement_catalog_version: D01_CONNECTION_MEASUREMENT_CATALOG_VERSION,
  profile_version: D01_CONNECTION_PROFILE_VERSION,
  started_at: "2026-01-01T00:01:00.000Z",
};

function fixture() {
  const tryAdd = vi.fn(() => true);
  const batch = { count: 0, tryAdd };
  const createBatch = vi.fn(async () => batch);
  const sendBatch = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const publisher = new D01ConnectionRunPinPublisher(
    connectionString,
    { createBatch, sendBatch, close } as never,
    () => Date.parse("2026-01-01T00:00:00.000Z"),
  );
  return { publisher, tryAdd, createBatch, sendBatch, close, batch };
}

describe("connection run-pin transport", () => {
  it("sends a single discriminated pin request, not a receipt claim", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    await f.publisher.publish(pin, signal);
    expect(f.tryAdd).toHaveBeenCalledWith({
      body: {
        ...pin,
        entityType: "ConnectionRunProfile",
        schema_version: 1,
        requested_at: "2026-01-01T00:00:00.000Z",
      },
      contentType: "application/json",
    });
    expect(f.sendBatch).toHaveBeenCalledOnce();
    expect(f.sendBatch).toHaveBeenCalledWith(f.batch, { abortSignal: signal });
    await f.publisher.close();
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("rejects malformed or cancelled pins before sending", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    await expect(f.publisher.publish({ ...pin, run_id: "bad" }, signal)).rejects.toThrow();
    await expect(
      f.publisher.publish({ ...pin, started_at: "2026-01-01T00:01:00Z" }, signal),
    ).rejects.toThrow();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(f.publisher.publish(pin, cancelled.signal)).rejects.toThrow();
    expect(f.createBatch).not.toHaveBeenCalled();
    expect(f.sendBatch).not.toHaveBeenCalled();
  });

  it("does not retry an ambiguous send failure", async () => {
    const f = fixture();
    f.sendBatch.mockRejectedValueOnce(new Error("delivery unknown"));
    await expect(f.publisher.publish(pin, new AbortController().signal)).rejects.toThrow(
      "delivery unknown",
    );
    expect(f.sendBatch).toHaveBeenCalledOnce();
  });
});
