/**
 * Winnowing fingerprints over a normalized token stream (Schleimer/Wilkerson/Aiken, "Winnowing:
 * Local Algorithms for Document Fingerprinting"). Pure, deterministic, zero IO.
 *
 * Pipeline: token -> 32-bit token hash -> rolling k-gram hash -> winnow to a sparse, position-stable
 * fingerprint set. Winnowing with window `w` guarantees any shared token run of length >= w + k - 1
 * shares at least one selected fingerprint, while keeping the index small.
 */

import type { Fingerprint, NormalizedToken } from "./types";

/** Polynomial base for the rolling hash; mixing constant from the 32-bit golden ratio. */
const ROLLING_BASE = 0x9e3779b1 | 0;

/** FNV-1a 32-bit hash of a token's normalized lexeme. */
export function hashToken(s: string): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

/**
 * Rolling polynomial hash for every k-gram in `tokenHashes`.
 * Returns a hash per window start `i` in `[0, n - k]`; empty when fewer than `k` tokens.
 * All arithmetic is mod 2^32 via {@link Math.imul}, so there is no precision loss.
 */
export function kgramHashes(tokenHashes: Int32Array, k: number): Int32Array {
  const n = tokenHashes.length;
  if (k <= 0 || n < k) {
    return new Int32Array(0);
  }
  const count = n - k + 1;
  const out = new Int32Array(count);

  // basePow = ROLLING_BASE^(k-1), the coefficient of the window's leading token.
  let basePow = 1 | 0;
  for (let i = 0; i < k - 1; i++) {
    basePow = Math.imul(basePow, ROLLING_BASE);
  }

  // First window, computed directly.
  let h = 0 | 0;
  for (let i = 0; i < k; i++) {
    h = (Math.imul(h, ROLLING_BASE) + tokenHashes[i]) | 0;
  }
  out[0] = h;

  // Slide: drop leading token, shift, append trailing token.
  for (let i = 1; i < count; i++) {
    const leading = Math.imul(tokenHashes[i - 1], basePow);
    h = (Math.imul((h - leading) | 0, ROLLING_BASE) + tokenHashes[i + k - 1]) | 0;
    out[i] = h;
  }
  return out;
}

/**
 * Standard winnowing: from the sequence of k-gram hashes, in each window of `windowSize`
 * consecutive hashes select the minimum (rightmost on ties), de-duplicating the same minimum
 * across overlapping windows. Returns the selected k-gram start indices, in ascending order.
 */
export function winnow(hashes: Int32Array, windowSize: number): number[] {
  const count = hashes.length;
  if (count === 0) {
    return [];
  }
  if (windowSize <= 1 || count < windowSize) {
    // Degenerate window: every k-gram is its own fingerprint.
    const all: number[] = [];
    for (let i = 0; i < count; i++) {
      all.push(i);
    }
    return all;
  }

  const selected: number[] = [];
  let minPos = -1;
  for (let i = 0; i + windowSize <= count; i++) {
    if (minPos < i) {
      // Previous minimum slid out of the window: rescan for the rightmost minimum.
      minPos = i;
      for (let j = i + 1; j < i + windowSize; j++) {
        if (hashes[j] <= hashes[minPos]) {
          minPos = j;
        }
      }
      selected.push(minPos);
    } else if (hashes[i + windowSize - 1] <= hashes[minPos]) {
      // New rightmost element is a new minimum (<= keeps rightmost).
      minPos = i + windowSize - 1;
      selected.push(minPos);
    }
  }
  return selected;
}

/**
 * Full fingerprint pass for one file's token stream: tokenize hashes, roll k-grams, winnow,
 * and resolve each selected position back to its source line range.
 */
export function fingerprintTokens(
  tokens: NormalizedToken[],
  k: number,
  windowSize: number,
): Fingerprint[] {
  if (tokens.length < k) {
    return [];
  }
  const tokenHashes = new Int32Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) {
    tokenHashes[i] = hashToken(tokens[i].norm);
  }
  const hashes = kgramHashes(tokenHashes, k);
  const positions = winnow(hashes, windowSize);

  const fingerprints: Fingerprint[] = [];
  for (const pos of positions) {
    fingerprints.push({
      hash: hashes[pos],
      tokenPos: pos,
      startLine: tokens[pos].line,
      endLine: tokens[pos + k - 1].line,
    });
  }
  return fingerprints;
}
