import { describe, it, expect } from "vitest";
import { main } from "../src/index.js";

describe("simulator placeholder", () => {
  it("exports a main() entry point", () => {
    expect(typeof main).toBe("function");
  });
});
