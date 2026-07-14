/**
 * Cross-environment random bytes as hex (observability IDs, non-cryptographic-grade fallbacks).
 *
 * Order of resolution (matches typical Edge vs Node tradeoffs):
 * 1. `globalThis.crypto` (W3C Web Crypto) — preferred on Edge / browsers; no Node compat indirection.
 * 2. `webcrypto` from `node:crypto` — Node 18 and similar where global Web Crypto is not exposed.
 *
 * Falls back to timestamp + counter + Math.random only when neither source is usable (e.g. some legacy embeds).
 */

import { webcrypto as nodeWebCrypto } from "node:crypto";

/** Minimal surface we need (works without DOM lib types). */
type CryptoWithGetRandomValues = {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
};

let cachedCrypto: CryptoWithGetRandomValues | null = null;

/**
 * Resolve a usable `getRandomValues` implementation.
 */
function getCrypto(): CryptoWithGetRandomValues | null {
  if (cachedCrypto) return cachedCrypto;

  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
    cachedCrypto = globalThis.crypto as CryptoWithGetRandomValues;
    return cachedCrypto;
  }

  if (nodeWebCrypto && typeof nodeWebCrypto.getRandomValues === "function") {
    cachedCrypto = nodeWebCrypto as CryptoWithGetRandomValues;
    return cachedCrypto;
  }

  cachedCrypto = null;
  return null;
}

/** Monotonic-ish counter for fallback IDs (wraps at 16 bits). */
let fallbackCounter = 0;

/**
 * Non-crypto fallback hex (UUIDv7-style): timestamp + increment + Math.random padding.
 * Reduces collision risk under high concurrency when Web Crypto is unavailable.
 */
function generateFallbackHex(byteLength: number): string {
  const timeHex = Date.now().toString(16);
  const counterHex = (fallbackCounter++ % 0xffff).toString(16).padStart(4, "0");
  let result = timeHex + counterHex;

  while (result.length < byteLength * 2) {
    result += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0");
  }

  return result.slice(0, byteLength * 2);
}

/**
 * Hex string of `byteLength` random bytes (2 hex chars per byte).
 * Prefers `getRandomValues`; otherwise uses timestamp + counter + `Math.random` (observability IDs only).
 */
export function generateHexBytes(byteLength: number): string {
  const cryptoRef = getCrypto();
  if (cryptoRef?.getRandomValues) {
    const bytes = new Uint8Array(byteLength);
    cryptoRef.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  return generateFallbackHex(byteLength);
}
