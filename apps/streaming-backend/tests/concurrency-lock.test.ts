import { describe, expect, it } from "vitest";
import { GlobalConcurrencyLock } from "../src/services/concurrency-lock.js";

describe("GlobalConcurrencyLock", () => {
  it("allows only one live simulation at a time until the owning run releases it", () => {
    const lock = new GlobalConcurrencyLock();

    expect(
      lock.tryAcquire({
        runId: "run-1",
        athleteId: "athlete-1",
        kind: "session",
      }),
    ).toEqual({
      acquired: true,
      lock: {
        runId: "run-1",
        athleteId: "athlete-1",
        kind: "session",
      },
    });

    expect(
      lock.tryAcquire({
        runId: "run-2",
        athleteId: "athlete-2",
        kind: "race",
      }),
    ).toEqual({
      acquired: false,
      currentLock: {
        runId: "run-1",
        athleteId: "athlete-1",
        kind: "session",
      },
    });

    expect(lock.release("other-run")).toBe(false);
    expect(lock.getCurrentLock()).toEqual({
      runId: "run-1",
      athleteId: "athlete-1",
      kind: "session",
    });
    expect(lock.release("run-1")).toBe(true);
    expect(lock.getCurrentLock()).toBeUndefined();
  });
});
