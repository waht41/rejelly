/**
 * Modified from best-effort-json-parser (BSD-2-Clause License)
 * Original Author: Xinyu (https://github.com/beenotung)
 * * Copyright (c) 2023, Xinyu
 * All rights reserved.
 * * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 * * 1. Redistributions of source code must retain the above copyright notice, this
 * list of conditions and the following disclaimer.
 * * 2. Redistributions in binary form must reproduce the above copyright notice,
 * this list of conditions and the following disclaimer in the documentation
 * and/or other materials provided with the distribution.
 * * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

// ============================================================================
// Pure module with no side effects - all parsers defined as frozen constants
// ============================================================================

type Logger = (msg: string, context?: any) => void;

type ParseOptions = {
  /**
   * Whether to silently ignore remaining characters (e.g., markdown markers) after parsing is complete, without printing an error.
   * @default true (Rejelly defaults to silent mode because LLMs often output markdown)
   */
  silentExtraToken?: boolean;

  /**
   * Custom error logger
   */
  logger?: Logger;
};

export function safeParse(s: string | undefined | null, options: ParseOptions = {}): any {
  const { silentExtraToken = true, logger = console.error } = options;

  if (s === undefined) return undefined;
  if (s === null) return null;
  if (s === "") return "";

  // Handle whitespace-only strings
  if (s.trim() === "") return "";

  // Remove incomplete escape characters at the end of the string
  s = s.replace(/\\+$/, (match) => (match.length % 2 === 0 ? match : match.slice(0, -1)));

  try {
    return JSON.parse(s);
  } catch (e) {
    // Attempt fault-tolerant parsing
    const [data, reminding] =
      s.trimLeft()[0] === ":"
        ? parseAny(s, e, logger)
        : parseAny(s, e, logger, parseStringWithoutQuote);

    // Handle remaining characters after parsing (Extra Tokens)
    if (reminding.length > 0) {
      const trimmedReminding = reminding.trimRight();
      if (trimmedReminding.length > 0 && !silentExtraToken) {
        logger("parsed json with extra tokens:", {
          text: s,
          data,
          reminding: trimmedReminding,
        });
      }
    }
    return data;
  }
}

// ================= Internal Parsers (Pure Functions) =================

type Code = string;
type ParseResult<T> = [T, Code];
type Parser<T> = (s: Code, e: unknown, logger: Logger) => ParseResult<T>;

// Includes `e`/`E` and `+` so scientific notation (1e10, 1.5e-3, 2E+5) is not
// truncated at the exponent in the fault-tolerant (unclosed-buffer) path.
const NUMBER_CHARS = "0123456789.-+eE";

function skipSpace(s: string): string {
  return s.trimStart();
}

function numToStr(s: string): number | string {
  if (s === "-") return -0;
  const num = +s;
  if (Number.isNaN(num)) return s;
  return num;
}

function fixEscapedCharacters(s: string): string {
  return s.replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/\r/g, "\\r");
}

function parseToken<T>(
  s: string,
  tokenStr: string,
  tokenVal: T,
  e: unknown,
  _logger: Logger,
): ParseResult<T> {
  for (let i = tokenStr.length; i >= 1; i--) {
    if (s.startsWith(tokenStr.slice(0, i))) {
      return [tokenVal, s.slice(i)];
    }
  }
  throw e;
}

// --- Whitespace Parser ---
const parseSpace: Parser<any> = (s, e, logger) => {
  s = skipSpace(s);
  return parseAny(s, e, logger);
};

// --- Number Parser ---
// Key logic: only continue parsing when the character is a number-related character (0-9, ., -)
// Stop when encountering any other character (including commas, spaces, brackets, etc.)
const parseNumber: Parser<number | string> = (s) => {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    // If the current character is a number character, it's still part of the number, continue
    if (NUMBER_CHARS.includes(c)) {
      continue;
    }
    // Otherwise stop parsing and return the parsed number
    const num = s.substring(0, i);
    s = s.substring(i);
    return [numToStr(num), s];
  }
  return [numToStr(s), ""];
};

// --- String Parsers ---

const isHexQuad = (s: string): boolean => /^[0-9a-fA-F]{4}$/.test(s);
const isHighSurrogate = (cu: number): boolean => cu >= 0xd800 && cu <= 0xdbff;
const isLowSurrogate = (cu: number): boolean => cu >= 0xdc00 && cu <= 0xdfff;
// A still-incomplete `\u` escape at the buffer tail: `\`, `\u`, or `\u` + 1..3 hex.
// (A full `\uXXXX` has 4 hex and is excluded — it's already a complete unit.)
const isPendingUnicodeEscape = (tail: string): boolean => /^\\u?[0-9a-fA-F]{0,3}$/.test(tail);

/**
 * Trim an incomplete trailing unit from an unterminated JSON string body (the
 * characters between the quotes, excluding them).
 *
 * Only used on the best-effort path where the string has no closing quote yet, so
 * the tail may hold a half-streamed unit. We suspend (drop) the tail when it is:
 *   - a lone backslash, or a `\uXXXX` with fewer than four hex digits — otherwise
 *     force-closing the quote makes JSON.parse throw ("Bad Unicode escape"), and
 *     that throw escapes safeParse, collapsing the whole partial object to {};
 *   - a high surrogate with no following low surrogate yet — both as a `\uD83D`
 *     escape and as a raw UTF-16 code unit — so a half-arrived emoji shows as
 *     nothing for one frame instead of a lone-surrogate replacement char (�).
 *
 * Returns the longest prefix that ends on a complete Unicode scalar.
 *
 * NOTE: scope is deliberately the Unicode *scalar* level only. It does NOT keep
 * grapheme clusters (emoji ZWJ sequences, variation selectors, skin-tone modifiers,
 * combining marks) intact: those have no deterministic end — a cluster can always be
 * extended by one more code point — so suspending on them could withhold output to
 * end-of-stream, and would need full grapheme segmentation. Mutating 👍 → 👍🏽
 * mid-stream is a benign visual refinement of valid text, which is exactly the
 * residual non-monotonicity the AgentStructuredDataStreamEvent.data contract warns about.
 */
function dropIncompleteTrailingEscape(body: string): string {
  let i = 0;
  let safeEnd = 0;
  while (i < body.length) {
    if (body[i] === "\\") {
      if (i + 1 >= body.length) break; // lone trailing backslash
      if (body[i + 1] !== "u") {
        i += 2; // single-char escape: \n \t \" \\ \/ \b \f \r ...
        safeEnd = i;
        continue;
      }
      const hex = body.slice(i + 2, i + 6);
      if (!isHexQuad(hex)) break; // `\uXXXX` not yet complete
      if (isHighSurrogate(Number.parseInt(hex, 16))) {
        // High surrogate via \u escape: keep only once its low half has arrived.
        const lowHex = body.slice(i + 8, i + 12);
        const lowArrived = body[i + 6] === "\\" && body[i + 7] === "u" && isHexQuad(lowHex);
        if (lowArrived && isLowSurrogate(Number.parseInt(lowHex, 16))) {
          i += 12; // complete \uXXXX\uXXXX pair
          safeEnd = i;
          continue;
        }
        // Low half not yet complete. Suspend while the tail is empty (high surrogate
        // sits at the very end) OR is a still-incomplete `\u` escape prefix — the low
        // surrogate's `\uXXXX` streams in over 6 chars (\, \u, \uD, \uDE, \uDE0), and
        // emitting the high surrogate alone during those frames flashes a �.
        const tail = body.slice(i + 6);
        if (tail === "" || isPendingUnicodeEscape(tail)) break;
        // else: followed by a complete unit that is not a low surrogate — genuinely
        // unpaired (bad data); leave the high surrogate as-is.
      }
      i += 6;
      safeEnd = i;
      continue;
    }

    // Raw (unescaped) character.
    if (isHighSurrogate(body.charCodeAt(i)) && i + 1 >= body.length) {
      break; // raw high surrogate at tail, awaiting its low half
    }
    i += 1;
    safeEnd = i;
  }
  return body.slice(0, safeEnd);
}

const parseDoubleQuoteString: Parser<string> = (s) => {
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === '"') {
      const str = fixEscapedCharacters(s.substring(0, i + 1));
      const rest = s.substring(i + 1);
      // Guard like the unclosed path below: a closed string can still hold content
      // JSON.parse rejects (raw C0 control chars, or invalid escapes like \x that
      // the scan loop skipped over), and a throw here unwinds through safeParse's
      // catch and collapses the whole partial object to {}. Fall back to raw inner text.
      try {
        return [JSON.parse(str), rest];
      } catch {
        return [s.substring(1, i), rest];
      }
    }
  }
  // Unclosed string at buffer end: drop any half-streamed trailing escape, then
  // force-close the quote. Guard the parse so this best-effort path never throws
  // (a throw here would collapse the whole partial object to {} for the frame).
  const body = dropIncompleteTrailingEscape(s.slice(1));
  try {
    return [JSON.parse(`"${fixEscapedCharacters(body)}"`), ""];
  } catch {
    return [body, ""];
  }
};

// Handle single-quoted strings
const parseSingleQuoteString: Parser<string> = (s) => {
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'") {
      const str = fixEscapedCharacters(s.substring(0, i + 1));
      const rest = s.substring(i + 1);
      try {
        return [JSON.parse(`"${str.slice(1, -1)}"`), rest];
      } catch {
        return [s.substring(1, i), rest];
      }
    }
  }
  // Same best-effort handling as the double-quote case above.
  const body = dropIncompleteTrailingEscape(s.slice(1));
  try {
    return [JSON.parse(`"${fixEscapedCharacters(body)}"`), ""];
  } catch {
    return [body, ""];
  }
};

function parseStringWithoutQuote(
  s: string,
  _e: unknown,
  _logger: Logger,
  delimiters: string[] = [" "],
): ParseResult<string> {
  const index = Math.min(
    ...delimiters.map((delimiter) => {
      const idx = s.indexOf(delimiter);
      return idx === -1 ? s.length : idx;
    }),
  );
  const value = s.substring(0, index).trim();
  const rest = s.substring(index);
  return [value, rest];
}

function parseStringCasual(
  s: string,
  e: unknown,
  logger: Logger,
  delimiters?: string[],
): ParseResult<string> {
  if (s[0] === '"') return parseDoubleQuoteString(s, e, logger);
  if (s[0] === "'") return parseSingleQuoteString(s, e, logger);
  return parseStringWithoutQuote(s, e, logger, delimiters);
}

// --- Array Parser ---
const parseArray: Parser<any[]> = (s, e, logger) => {
  s = s.substring(1); // skip '['
  const acc: any[] = [];
  s = skipSpace(s);
  while (s.length > 0) {
    if (s[0] === "]") {
      s = s.substring(1); // skip ']'
      break;
    }
    const res = parseAny(s, e, logger, (str, err) =>
      parseStringWithoutQuote(str, err, logger, [",", "]"]),
    );
    acc.push(res[0]);
    s = res[1];
    s = skipSpace(s);
    if (s[0] === ",") {
      s = s.substring(1);
      s = skipSpace(s);
    }
  }
  return [acc, s];
};

// --- Object Parser ---
const parseObject: Parser<Record<string, any>> = (s, e, logger) => {
  s = s.substring(1); // skip '{'
  const acc: Record<string, any> = {};
  s = skipSpace(s);
  while (s.length > 0) {
    if (s[0] === "}") {
      s = s.substring(1); // skip '}'
      break;
    }

    const keyRes = parseStringCasual(s, e, logger, [":", "}"]);
    const key = keyRes[0];
    s = keyRes[1];

    s = skipSpace(s);
    if (s[0] !== ":") {
      acc[key] = undefined;
      break;
    }
    s = s.substring(1); // skip ':'
    s = skipSpace(s);

    if (s.length === 0) {
      acc[key] = undefined;
      break;
    }
    // Pass a fallback (like parseArray does) so a value starting with an unregistered
    // char — undefined / NaN / Infinity, or any garbage — is read as a string instead
    // of letting parseAny throw and collapse the whole object to {}.
    const valueRes = parseAny(s, e, logger, (str, err) =>
      parseStringWithoutQuote(str, err, logger, [",", "}"]),
    );
    acc[key] = valueRes[0];
    s = valueRes[1];
    s = skipSpace(s);

    if (s[0] === ",") {
      s = s.substring(1);
      s = skipSpace(s);
    }
  }
  return [acc, s];
};

// --- Boolean/Null Parsers ---
const parseTrue: Parser<boolean> = (s, e, logger) => parseToken(s, "true", true, e, logger);
const parseFalse: Parser<boolean> = (s, e, logger) => parseToken(s, "false", false, e, logger);
const parseNull: Parser<null> = (s, e, logger) => parseToken(s, "null", null, e, logger);

// ================= Parser Registry (Immutable) =================

const parsers: Readonly<Record<string, Parser<any>>> = Object.freeze({
  // Whitespace
  " ": parseSpace,
  "\r": parseSpace,
  "\n": parseSpace,
  "\t": parseSpace,
  // Structures
  "[": parseArray,
  "{": parseObject,
  // Strings
  '"': parseDoubleQuoteString,
  "'": parseSingleQuoteString,
  // Numbers
  "0": parseNumber,
  "1": parseNumber,
  "2": parseNumber,
  "3": parseNumber,
  "4": parseNumber,
  "5": parseNumber,
  "6": parseNumber,
  "7": parseNumber,
  "8": parseNumber,
  "9": parseNumber,
  ".": parseNumber,
  "-": parseNumber,
  // Literals
  t: parseTrue,
  f: parseFalse,
  n: parseNull,
});

function parseAny(s: string, e: unknown, logger: Logger, fallback?: Parser<any>): ParseResult<any> {
  const parser = parsers[s[0]] || fallback;
  if (!parser) {
    // Here you can choose to throw an error, or silently swallow it in production
    throw e;
  }
  return parser(s, e, logger);
}
