/**
 * Hash Utilities
 *
 * Helper functions for hashing.
 */

import { assertSerializable, stableStringify } from "./object";

/**
 * cyrb53 (53-bit hash)
 * Fast, dependency-free, high-quality pure JavaScript hash.
 * Excellent avalanche effect, very low collision probability, suitable for local Snapshot cache replay.
 *
 * @param str - String to hash
 * @param seed - Optional hash seed
 * @returns Hexadecimal hash string (up to 14 characters)
 */
export function simpleHash(str: string, seed: number = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;

  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  // Combine into 53-bit safe integer (h2 << 21 + h1)
  const hashVal = 4294967296 * (2097151 & h2) + (h1 >>> 0);

  return hashVal.toString(16);
}

/**
 * Hash any value (converts to stable string first)
 *
 * @param value - Value to hash
 * @returns Hash string
 */
export function hashValue(value: unknown): string {
  assertSerializable(value, "hashValue");
  const str = stableStringify(value);
  return simpleHash(str);
}
