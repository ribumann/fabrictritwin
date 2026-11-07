/**
 * Small deterministic PRNG wrapper shared by all simulator generators.
 */
export interface SeededRandom {
  next(): number;
  int(minInclusive: number, maxInclusive: number): number;
  pick<T>(values: readonly T[]): T;
}

const DEFAULT_NON_ZERO_SEED = 0x6d2b79f5;
const UINT32_RANGE = 0x1_0000_0000;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

    return ((value ^ (value >>> 14)) >>> 0) / UINT32_RANGE;
  };
}

function normalizeSeed(seed: number): number {
  const normalized = Math.trunc(seed) >>> 0;

  return normalized === 0 ? DEFAULT_NON_ZERO_SEED : normalized;
}

/**
 * Derives a stable child seed so generators can stay deterministic without sharing mutable RNG
 * state across modules.
 */
export function deriveSeed(seed: number, salt: string): number {
  let hash = normalizeSeed(seed);

  for (const character of salt) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }

  return normalizeSeed(hash);
}

/**
 * Creates a deterministic random-number helper.
 */
export function createSeededRandom(seed: number): SeededRandom {
  const nextValue = mulberry32(normalizeSeed(seed));

  return {
    next(): number {
      return nextValue();
    },
    int(minInclusive: number, maxInclusive: number): number {
      if (maxInclusive < minInclusive) {
        throw new RangeError("maxInclusive must be greater than or equal to minInclusive.");
      }

      const span = maxInclusive - minInclusive + 1;
      return minInclusive + Math.floor(nextValue() * span);
    },
    pick<T>(values: readonly T[]): T {
      if (values.length === 0) {
        throw new RangeError("Cannot pick from an empty array.");
      }

      return values[Math.floor(nextValue() * values.length)];
    },
  };
}

/**
 * Produces a deterministic UUID-like identifier.
 */
export function nextUuid(random: SeededRandom): string {
  const bytes = Array.from({ length: 16 }, () => random.int(0, 255));

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0"));

  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}
