/**
 * Cheap, dependency-free token estimation for budgeting tool output.
 *
 * Not a real tokenizer — a guard heuristic. CJK code points tokenize at ~1 token each, while
 * ASCII/code runs ~4 chars/token; counting them separately keeps the estimate honest for
 * Chinese/Japanese/Korean-heavy content (comments, docs) that a flat chars/4 under-charges ~4x.
 */

import type { ImageContent, Message, MessageContent } from "@rejelly/core";
import { type ImageDimensions, readImageDimensions } from "../../foundation/media/imageDimensions";

/** Rough chars-per-token for non-CJK text (code/ASCII); on the cheap side so we under-charge slightly. */
const NON_CJK_CHARS_PER_TOKEN = 4;
/**
 * Conservative fallback/ceiling for an image whose dimensions are unavailable or exceed the
 * dimension tiers. Actual vision usage remains provider- and model-specific.
 */
export const IMAGE_CONTENT_TOKEN_ESTIMATE = 4096;
/** Low-detail vision requests are deliberately resolution-independent. */
export const LOW_DETAIL_IMAGE_TOKEN_ESTIMATE = 512;
const SMALL_IMAGE_TOKEN_ESTIMATE = 1024;
const MEDIUM_IMAGE_TOKEN_ESTIMATE = 2048;
const SMALL_IMAGE_MAX_DIMENSION = 512;
const MEDIUM_IMAGE_MAX_DIMENSION = 1024;
const MAX_DECODED_IMAGE_HEADER_BYTES = 256 * 1024;
const imageDimensionCache = new WeakMap<ImageContent, ImageDimensions | null>();

function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x3000 && cp <= 0x9fff) || // CJK punctuation, kana, CJK unified ideographs
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xff00 && cp <= 0xffef) || // fullwidth / halfwidth forms
    (cp >= 0x20000 && cp <= 0x3ffff) // CJK unified ideographs extension B+
  );
}

export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (isCjkCodePoint(ch.codePointAt(0) ?? 0)) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(cjk + other / NON_CJK_CHARS_PER_TOKEN);
}

function dimensionsFromDataUrl(image: ImageContent): ImageDimensions | undefined {
  const cached = imageDimensionCache.get(image);
  if (cached !== undefined) {
    return cached ?? undefined;
  }
  let dimensions: ImageDimensions | undefined;
  const match = /^data:image\/[^;,]+;base64,(.+)$/s.exec(image.url);
  if (match) {
    try {
      // Raster dimensions live in headers. Decode only a bounded prefix so estimating a large
      // tool-returned image does not duplicate its full decoded payload in memory.
      const maxBase64Chars = Math.ceil((MAX_DECODED_IMAGE_HEADER_BYTES * 4) / 3) + 4;
      dimensions = readImageDimensions(Buffer.from(match[1].slice(0, maxBase64Chars), "base64"));
    } catch {
      // Malformed data URLs retain the conservative fallback below.
    }
  }
  imageDimensionCache.set(image, dimensions ?? null);
  return dimensions;
}

function estimateImageTokens(
  image: ImageContent,
  suppliedDimensions: ImageDimensions | undefined,
): number {
  if (image.detail === "low") {
    return LOW_DETAIL_IMAGE_TOKEN_ESTIMATE;
  }
  const dimensions = suppliedDimensions ?? dimensionsFromDataUrl(image);
  if (!dimensions) {
    return IMAGE_CONTENT_TOKEN_ESTIMATE;
  }
  const { width, height } = dimensions;
  const maxDimension = Math.max(width, height);
  if (maxDimension <= SMALL_IMAGE_MAX_DIMENSION) {
    return SMALL_IMAGE_TOKEN_ESTIMATE;
  }
  if (maxDimension <= MEDIUM_IMAGE_MAX_DIMENSION) {
    return MEDIUM_IMAGE_TOKEN_ESTIMATE;
  }
  return IMAGE_CONTENT_TOKEN_ESTIMATE;
}

function dimensionsFromMessageExtra(message: Message): Array<ImageDimensions | undefined> {
  const rejelly = message.extra?.rejelly;
  if (typeof rejelly !== "object" || rejelly === null) {
    return [];
  }
  const raw = (rejelly as Record<string, unknown>).imageDimensions;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((value) => {
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    const { width, height } = value as Record<string, unknown>;
    return typeof width === "number" &&
      Number.isInteger(width) &&
      width > 0 &&
      typeof height === "number" &&
      Number.isInteger(height) &&
      height > 0
      ? { width, height }
      : undefined;
  });
}

export function estimateMessageContentTokens(
  content: MessageContent | null,
  imageDimensions: readonly (ImageDimensions | undefined)[] = [],
): number {
  if (content == null) {
    return 0;
  }
  if (typeof content === "string") {
    return estimateTokens(content);
  }
  let total = 0;
  let imageIndex = 0;
  for (const part of content) {
    if (part.type === "text") {
      total += estimateTokens(part.text);
    } else if (part.type === "image") {
      total += estimateImageTokens(part.image, imageDimensions[imageIndex]);
      imageIndex += 1;
    } else {
      total += IMAGE_CONTENT_TOKEN_ESTIMATE;
    }
  }
  return total;
}

/**
 * Cheap token estimate over a list of messages: each message's text content plus its tool-call
 * arguments. Stateless — measures whatever is actually in the given messages, so it reflects
 * compaction/trimming automatically (no running tally to reset).
 */
export function estimateMessagesTokens(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateMessageContentTokens(message.content, dimensionsFromMessageExtra(message));
    for (const call of message.tool_calls ?? []) {
      total += estimateTokens(JSON.stringify(call));
    }
  }
  return total;
}
