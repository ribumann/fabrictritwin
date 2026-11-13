import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { readPinnedMiningReceipt } from "../src/mining/read/pinned-receipt.js";

const signal = new AbortController().signal;
const pinFor = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function fixture(bytes: Buffer) {
  return {
    readBytes: vi.fn(async () => ({ bytes, etag: '"one"', leased: false })),
  };
}

describe("pinned receipt envelope", () => {
  it("uses the exact single downloaded snapshot and leaves its value untrusted", async () => {
    const bytes = Buffer.from('{"a":1,"b":"ok"}');
    const store = fixture(bytes);
    await expect(readPinnedMiningReceipt(store, pinFor(bytes), signal)).resolves.toEqual({
      value: { a: 1, b: "ok" },
      etag: '"one"',
    });
    expect(store.readBytes).toHaveBeenCalledOnce();
    expect(store.readBytes).toHaveBeenCalledWith(
      "private/fabric/mining/d01-proof-receipt-v1.json",
      signal,
    );
  });

  it("rejects missing or incorrect pins before parsing untrusted bytes", async () => {
    const store = fixture(Buffer.from("not JSON"));
    await expect(readPinnedMiningReceipt(store, "", signal)).rejects.toThrow("pin is invalid");
    expect(store.readBytes).not.toHaveBeenCalled();
    await expect(readPinnedMiningReceipt(store, "0".repeat(64), signal)).rejects.toThrow(
      "pin does not match",
    );
  });

  it.each(['{"b":1,"a":2}', '{"a":1,"a":1}', '{"a":1}\n', '{"a":"\\ud800"}', '{"a":1e400}'])(
    "rejects noncanonical or invalid JSON: %s",
    async (text) => {
      const bytes = Buffer.from(text);
      await expect(
        readPinnedMiningReceipt(fixture(bytes), pinFor(bytes), signal),
      ).rejects.toThrow();
    },
  );

  it("rejects invalid UTF-8, oversized data, missing ETags and cancellation", async () => {
    const invalid = Buffer.from([0xff]);
    await expect(
      readPinnedMiningReceipt(fixture(invalid), pinFor(invalid), signal),
    ).rejects.toThrow("UTF-8 JSON");
    const bom = Buffer.from("\ufeff{}");
    await expect(readPinnedMiningReceipt(fixture(bom), pinFor(bom), signal)).rejects.toThrow(
      "not canonical",
    );
    const oversized = Buffer.alloc(16_385);
    await expect(
      readPinnedMiningReceipt(fixture(oversized), pinFor(oversized), signal),
    ).rejects.toThrow("missing or invalid");
    const bytes = Buffer.from("{}");
    const store = { readBytes: vi.fn(async () => ({ bytes, etag: "", leased: false })) };
    await expect(readPinnedMiningReceipt(store, pinFor(bytes), signal)).rejects.toThrow(
      "missing or invalid",
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      readPinnedMiningReceipt(store, pinFor(bytes), controller.signal),
    ).rejects.toThrow();
  });

  it("rejects a malformed snapshot without hashing or parsing it", async () => {
    const store = {
      readBytes: vi.fn().mockResolvedValue({ etag: '"one"', leased: false }),
    };
    await expect(readPinnedMiningReceipt(store, "0".repeat(64), signal)).rejects.toThrow(
      "missing or invalid",
    );
    store.readBytes.mockResolvedValue({ bytes: "{}", etag: '"one"', leased: false });
    await expect(readPinnedMiningReceipt(store, "0".repeat(64), signal)).rejects.toThrow(
      "missing or invalid",
    );
    store.readBytes.mockResolvedValue({ bytes: Buffer.from("{}"), etag: 42, leased: false });
    await expect(readPinnedMiningReceipt(store, "0".repeat(64), signal)).rejects.toThrow(
      "missing or invalid",
    );
  });
});
