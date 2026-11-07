import { describe, expect, it, vi } from "vitest";
import { generateSeedHistoryDataset } from "../src/services/seed-history.js";

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: class {
    constructor() {
      throw new Error("Azure credentials are forbidden in dataset generation.");
    }
  },
}));
vi.mock("@azure/storage-file-datalake", () => ({
  DataLakeServiceClient: class {
    constructor() {
      throw new Error("OneLake is forbidden in dataset generation.");
    }
  },
}));

const options = { athleteId: "synthetic-athlete", referenceDate: "2026-09-07", seed: 42 };

describe("in-memory seed dataset", () => {
  it("reuses the complete bounded history models deterministically without Azure clients", () => {
    const first = generateSeedHistoryDataset(options);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2030-01-01"));
      expect(generateSeedHistoryDataset(options)).toEqual(first);
    } finally {
      vi.useRealTimers();
    }
    expect(first.sessions.length).toBeGreaterThan(100);
    expect(first.sessions.length).toBeLessThan(130);
    expect(first.recoveryMetrics).toHaveLength(112);
    expect(first.sleepSessions).toHaveLength(112);
    expect(first.phases.map((phase) => phase.phase)).toEqual(["Base", "Build", "Peak", "Taper"]);
    expect(first.races).toHaveLength(3);
    expect(first.sessionMetrics.length).toBeGreaterThan(0);
    expect(first.anomalies.length).toBeGreaterThan(0);
    expect(generateSeedHistoryDataset({ ...options, seed: 43 })).not.toEqual(first);
    first.sessions.length = 0;
    expect(generateSeedHistoryDataset(options).sessions.length).toBeGreaterThan(100);
  });

  it.each(["", "2026-02-30", "invalid", "2026-09-07T00:00:00Z", "2026-13-07"])(
    "rejects invalid reference date %s",
    (referenceDate) => {
      expect(() => generateSeedHistoryDataset({ ...options, referenceDate })).toThrow(
        "referenceDate",
      );
    },
  );
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0x1_0000_0000])(
    "rejects invalid seed %s",
    (seed) => {
      expect(() => generateSeedHistoryDataset({ ...options, seed })).toThrow("seed");
    },
  );
  it("rejects an empty athlete", () => {
    expect(() => generateSeedHistoryDataset({ ...options, athleteId: " " })).toThrow("athleteId");
  });
});
