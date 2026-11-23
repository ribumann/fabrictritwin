import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pin: vi.fn(),
  configurePin: vi.fn(),
  configureRuntime: vi.fn(),
}));
vi.mock("../src/mining/connection-run-pin.js", () => ({
  configuredConnectionRunPinHandler: mocks.configurePin,
}));
vi.mock("../src/mining/publisher-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/mining/publisher-runtime.js")>()),
  configuredMiningPublisherRuntime: mocks.configureRuntime,
}));

import { createMiningDemoHost } from "../src/api/mining-demo.js";
import { MiningPublisherHost } from "../src/mining/publisher-host.js";

describe("connection pin host wiring", () => {
  it("passes the explicitly configured pin handler to both protected publisher hosts", async () => {
    mocks.configurePin.mockReturnValue(mocks.pin);
    const status = {
      runId: "11111111-1111-4111-8111-111111111111",
      admission: "accepted" as const,
      phase: "running" as const,
      stopRequested: false,
    };
    mocks.configureRuntime.mockReturnValue({
      run: async (
        _input: unknown,
        _signal: unknown,
        _incidents: unknown,
        notify: (result: unknown) => void,
      ) => {
        notify({ kind: "started", status });
        return status;
      },
    });
    const hosts = [new MiningPublisherHost(), createMiningDemoHost({})];
    for (const host of hosts) {
      const execution = host.start({ plantId: "D01", requestId: status.runId });
      await execution.admission;
      await execution.completion;
      await host.close();
    }
    expect(mocks.configureRuntime).toHaveBeenCalledTimes(2);
    for (const call of mocks.configureRuntime.mock.calls) {
      expect(call[1].connectionRunProfilePin).toBe(mocks.pin);
    }
  });
});
