/**
 * Cheap, dependency-free token estimation for budgeting tool output.
 *
 * Not a real tokenizer — a guard heuristic. CJK code points tokenize at ~1 token each, while
 * ASCII/code runs ~4 chars/token; counting them separately keeps the estimate honest for
 * Chinese/Japanese/Korean-heavy content (comments, docs) that a flat chars/4 under-charges ~4x.
 */

import type { Message, MessageContent } from "@rejelly/core";

/** Rough chars-per-token for non-CJK text (code/ASCII); on the cheap side so we under-charge slightly. */
const NON_CJK_CHARS_PER_TOKEN = 4;

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

/** Flatten message content to its text; non-text parts (images) contribute no text. */
export function messageContentToText(content: MessageContent | null): string {
  if (content == null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  return content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

/**
 * Cheap token estimate over a list of messages: each message's text content plus its tool-call
 * arguments. Stateless — measures whatever is actually in the given messages, so it reflects
 * compaction/trimming automatically (no running tally to reset).
 */
export function estimateMessagesTokens(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokens(messageContentToText(message.content));
    for (const call of message.tool_calls ?? []) {
      total += estimateTokens(JSON.stringify(call));
    }
  }
  return total;
}
