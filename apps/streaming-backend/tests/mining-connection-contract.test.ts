import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ mutate: false }));
vi.mock("@triathlon-twin/simulator/mining", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@triathlon-twin/simulator/mining")>();
  return {
    ...actual,
    toD01ConnectionMeasurementBindingRecords: () => {
      const bindings = actual.toD01ConnectionMeasurementBindingRecords();
      if (state.mutate) bindings[0] = { ...bindings[0]!, source_port_id: "changed" };
      return bindings;
    },
  };
});

import { createD01SharedFlowRunContract } from "../src/mining-incidents/catalog.js";

describe("shared-flow run contract", () => {
  it("rejects binding drift even when the version and binding counts remain unchanged", () => {
    state.mutate = false;
    expect(() => createD01SharedFlowRunContract()).not.toThrow();
    state.mutate = true;
    expect(() => createD01SharedFlowRunContract()).toThrow("no longer matches");
    state.mutate = false;
  });
});
