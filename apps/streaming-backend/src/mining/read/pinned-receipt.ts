import { createHash, timingSafeEqual } from "node:crypto";
import type { MiningByteStore } from "../store.js";

const receiptPath = "private/fabric/mining/d01-proof-receipt-v1.json";
const maxBytes = 16_384;

export class MiningReceiptError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MiningReceiptError";
  }
}

export function canonicalJson(value: unknown): string {
  if (typeof value === "string") {
    if (Buffer.from(value, "utf8").toString("utf8") !== value) {
      throw new MiningReceiptError("Receipt contains invalid Unicode.");
    }
    return JSON.stringify(value);
  }
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new MiningReceiptError("Receipt contains an invalid number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${canonicalJson(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new MiningReceiptError("Receipt contains an invalid value.");
}

/**
 * Reads a pinned envelope only; this does not verify its schema, deployment, or readiness.
 * The caller must authorize the viewer and approved run before invoking it.
 */
export async function readPinnedMiningReceipt(
  store: MiningByteStore,
  pin: string,
  signal: AbortSignal,
): Promise<{ value: unknown; etag: string }> {
  signal.throwIfAborted();
  if (!/^[0-9a-f]{64}$/.test(pin)) throw new MiningReceiptError("Receipt pin is invalid.");
  const document = await store.readBytes(receiptPath, signal);
  signal.throwIfAborted();
  if (
    !document ||
    !Buffer.isBuffer(document.bytes) ||
    typeof document.etag !== "string" ||
    !document.etag ||
    document.bytes.length > maxBytes
  ) {
    throw new MiningReceiptError("Pinned receipt is missing or invalid.");
  }
  const digest = createHash("sha256").update(document.bytes).digest();
  if (!timingSafeEqual(digest, Buffer.from(pin, "hex"))) {
    throw new MiningReceiptError("Receipt pin does not match.");
  }
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(document.bytes);
    value = JSON.parse(text);
  } catch (error) {
    throw new MiningReceiptError("Receipt is not valid UTF-8 JSON.", { cause: error });
  }
  if (!document.bytes.equals(Buffer.from(canonicalJson(value), "utf8"))) {
    throw new MiningReceiptError("Receipt is not canonical JSON.");
  }
  signal.throwIfAborted();
  return { value, etag: document.etag };
}
