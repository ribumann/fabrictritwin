import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configuredMiningContinuousWorker,
  miningContinuousConfiguration,
  MiningContinuousWorker,
} from "../src/mining/continuous-worker.js";
import type { MiningRunStatus } from "../src/mining/run-coordinator.js";

afterEach(() => vi.restoreAllMocks());

describe("managed continuous Mining worker", () => {
  it("is default-off, validates explicit activation, and starts no work in its constructor", () => {
    expect(configuredMiningContinuousWorker({})).toBeUndefined();
    expect(
      configuredMiningContinuousWorker({ MINING_CONTINUOUS_ENABLED: "false" }),
    ).toBeUndefined();
    expect(() => miningContinuousConfiguration({ MINING_CONTINUOUS_ENABLED: "yes" })).toThrow();
    expect(() => miningContinuousConfiguration({ MINING_CONTINUOUS_ENABLED: "true" })).toThrow(
      "GENERATION",
    );
    expect(() =>
      miningContinuousConfiguration({
        MINING_CONTINUOUS_ENABLED: "true",
        MINING_CONTINUOUS_GENERATION: "release-1",
      }),
    ).toThrow("publisher");
    const startContinuous = vi.fn();
    new MiningContinuousWorker(
      "release-1",
      { startContinuous, close: vi.fn() },
      {
        currentStatus: vi.fn(),
        continuousGenerationHeld: vi.fn(),
      },
    );
    expect(startContinuous).not.toHaveBeenCalled();
  });

  it("observes other replicas and holds without admitting, including a held generation with no current run", async () => {
    const startContinuous = vi.fn();
    const held = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const currentStatus = vi.fn(async () => ({ phase: "running" }) as MiningRunStatus);
    let waits = 0;
    const worker = new MiningContinuousWorker(
      "release-1",
      { startContinuous, close: vi.fn() },
      {
        currentStatus,
        continuousGenerationHeld: held,
      },
      async () => {
        if (++waits === 2) void worker.close();
      },
    );
    worker.start();
    await vi.waitFor(() => expect(waits).toBe(2));
    await worker.close();
    expect(startContinuous).not.toHaveBeenCalled();
    expect(currentStatus).toHaveBeenCalledTimes(1);
  });

  it("backs off repeated failures and uses fresh UUIDs only after previous execution settles", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ids: string[] = [];
    const delays: number[] = [];
    const startContinuous = vi.fn((input: { requestId: string }) => {
      ids.push(input.requestId);
      const completion = Promise.reject(new Error("Publisher unavailable"));
      return { admission: completion, completion };
    });
    const worker = new MiningContinuousWorker(
      "release-1",
      { startContinuous, close: vi.fn() },
      {
        currentStatus: vi.fn(async () => undefined),
        continuousGenerationHeld: vi.fn(async () => false),
      },
      async (delay) => {
        delays.push(delay);
        if (delays.length === 6) void worker.close();
      },
    );
    worker.start();
    await vi.waitFor(() => expect(delays).toHaveLength(6));
    await worker.close();
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
    expect(new Set(ids).size).toBe(6);
  });
});
