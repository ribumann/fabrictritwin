import { afterEach, describe, expect, it, vi } from "vitest";
import { traceTwinSend, type Timeline } from "../src/services/twin-latency.js";

const timeline: Timeline = {
  scenario: "mining",
  runId: "run-id",
  eventId: "event-id",
  sampleTime: "2026-11-20T12:00:00.000Z",
  emittedAt: "2026-11-20T12:00:01.000Z",
  eventCount: 45,
};

describe("twin publisher latency", () => {
  afterEach(() => vi.restoreAllMocks());

  it("preserves the send result and logs correlated clock boundaries", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    await expect(traceTwinSend(timeline, async () => 45)).resolves.toBe(45);
    const row = JSON.parse(log.mock.calls[0]![0] as string);
    expect(row).toMatchObject({ ...timeline, stage: "send", outcome: "acknowledged" });
    expect(Date.parse(row.completedAt)).toBeGreaterThanOrEqual(Date.parse(row.sendStartedAt));
    expect(row.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("does not turn a failed send into an acknowledgement or log its exception text", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = new Error("transport details");
    await expect(
      traceTwinSend(timeline, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(JSON.parse(log.mock.calls[0]![0] as string).outcome).toBe("unconfirmed");
    expect(log.mock.calls[0]![0]).not.toContain(error.message);
  });
});
