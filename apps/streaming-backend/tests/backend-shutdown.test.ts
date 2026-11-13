import { describe, expect, it, vi } from "vitest";
import { createBackendShutdown } from "../src/services/backend-shutdown.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("backend shutdown", () => {
  it("blocks new publisher work first, closes services once, and joins both owners", async () => {
    const order: string[] = [];
    const publisher = deferred();
    const closePublisher = vi.fn(() => {
      order.push("publisher");
      return publisher.promise;
    });
    const closeHttp = vi.fn(async () => {
      order.push("http");
    });
    const shutdown = createBackendShutdown({
      closePublisher,
      closeHttp,
      stopBackgroundServices: () => order.push("background"),
      terminateStreams: () => order.push("streams"),
    });

    const first = shutdown();
    expect(shutdown()).toBe(first);
    expect(order).toEqual(["publisher", "background", "streams", "http"]);
    expect(closePublisher).toHaveBeenCalledOnce();
    expect(closeHttp).toHaveBeenCalledOnce();

    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await closeHttp.mock.results[0]!.value;
    await Promise.resolve();
    expect(settled).toBe(false);
    publisher.resolve();
    await first;
    expect(settled).toBe(true);
  });

  it("reports shutdown errors only after all started cleanup operations settle", async () => {
    const publisher = deferred();
    const http = deferred();
    const shutdown = createBackendShutdown({
      closePublisher: () => publisher.promise,
      closeHttp: () => http.promise,
      stopBackgroundServices: () => {
        throw new Error("listener stop failed");
      },
      terminateStreams: () => {},
    });

    const result = expect(shutdown()).rejects.toThrow("Backend shutdown failed.");
    publisher.reject(new Error("publisher close failed"));
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    http.resolve();
    await result;
  });
});
