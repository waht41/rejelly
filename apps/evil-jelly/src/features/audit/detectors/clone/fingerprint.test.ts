import { describe, expect, it } from "vitest";
import { hashToken, kgramHashes, winnow } from "./fingerprint";

/** Naive reference: recompute every k-gram polynomial hash directly (mod 2^32 via imul). */
function naiveKgramHashes(tokenHashes: Int32Array, k: number): Int32Array {
  const B = 0x9e3779b1 | 0;
  const n = tokenHashes.length;
  if (n < k) {
    return new Int32Array(0);
  }
  const out = new Int32Array(n - k + 1);
  for (let i = 0; i + k <= n; i++) {
    let h = 0 | 0;
    for (let j = 0; j < k; j++) {
      h = (Math.imul(h, B) + tokenHashes[i + j]) | 0;
    }
    out[i] = h;
  }
  return out;
}

describe("hashToken", () => {
  it("is deterministic and distinguishes lexemes", () => {
    expect(hashToken("$ID")).toBe(hashToken("$ID"));
    expect(hashToken("$ID")).not.toBe(hashToken("$LIT"));
    expect(hashToken("const")).not.toBe(hashToken("let"));
  });
});

describe("kgramHashes", () => {
  it("matches the naive reference across window sizes", () => {
    const tokenHashes = Int32Array.from(
      [..."function f a b c return a plus b times c end"].map((ch) => hashToken(ch)),
    );
    for (const k of [1, 3, 8, 12]) {
      const rolled = kgramHashes(tokenHashes, k);
      const naive = naiveKgramHashes(tokenHashes, k);
      expect(Array.from(rolled)).toEqual(Array.from(naive));
    }
  });

  it("returns empty when fewer than k tokens", () => {
    expect(kgramHashes(Int32Array.from([1, 2]), 5).length).toBe(0);
  });
});

describe("winnow", () => {
  it("guarantees identical token runs of length >= w+k-1 share a fingerprint", () => {
    const k = 4;
    const w = 5;
    // Two copies of the same 12-token run embedded in different surrounding noise.
    const run = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
    const left = [1, 2, 3, ...run, 4, 5];
    const right = [9, 8, ...run, 7, 6, 5, 4];

    const fpLeft = new Set(
      winnow(kgramHashes(Int32Array.from(left), k), w).map(
        (p) => kgramHashes(Int32Array.from(left), k)[p],
      ),
    );
    const fpRight = winnow(kgramHashes(Int32Array.from(right), k), w).map(
      (p) => kgramHashes(Int32Array.from(right), k)[p],
    );

    expect(fpRight.some((h) => fpLeft.has(h))).toBe(true);
  });

  it("selects fewer fingerprints than there are k-grams (sparse index)", () => {
    const hashes = Int32Array.from(
      Array.from({ length: 100 }, (_, i) => Math.imul(i + 1, 0x9e3779b1) | 0),
    );
    const selected = winnow(hashes, 8);
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThan(hashes.length);
    // Ascending, in-range.
    for (let i = 1; i < selected.length; i++) {
      expect(selected[i]).toBeGreaterThan(selected[i - 1]);
    }
    expect(selected[selected.length - 1]).toBeLessThan(hashes.length);
  });
});
