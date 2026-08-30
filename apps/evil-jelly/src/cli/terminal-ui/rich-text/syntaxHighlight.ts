import { DIFF_COLORS } from "./diffTheme";

const MAX_HIGHLIGHT_BYTES = 512 * 1024;
const MAX_HIGHLIGHT_LINES = 10_000;
const MAX_HIGHLIGHT_LINE_BYTES = 4 * 1024;
const ANSI_FOREGROUND_RESET = "\u001B[39m";

type ColorFormatter = (text: string) => string;
type SyntaxHighlighter = (lines: string[], language: string) => string[];
type SyntaxHighlightListener = () => void;
export type SyntaxHighlighterState = "idle" | "loading" | "ready" | "unavailable";

let highlighter: SyntaxHighlighter | undefined;
let highlighterLoad: Promise<void> | undefined;
let highlighterState: SyntaxHighlighterState = "idle";
const listeners = new Set<SyntaxHighlightListener>();

function rgb(red: number, green: number, blue: number): ColorFormatter {
  const open = `\u001B[38;2;${red};${green};${blue}m`;
  return (text) => (text.length > 0 ? `${open}${text}${ANSI_FOREGROUND_RESET}` : text);
}

function hex(color: string): ColorFormatter {
  const value = Number.parseInt(color.slice(1), 16);
  return rgb((value >> 16) & 255, (value >> 8) & 255, value & 255);
}

const DIFF_FORMATTERS = {
  addition: hex(DIFF_COLORS.addition),
  deletion: hex(DIFF_COLORS.deletion),
  hunk: hex(DIFF_COLORS.hunk),
  meta: hex(DIFF_COLORS.meta),
};

function normalizedLanguage(language: string): string {
  return language.trim().split(/[,\s]/, 1)[0]?.toLowerCase() ?? "";
}

function exceedsHighlightLimits(code: string, lines: string[]): boolean {
  return (
    Buffer.byteLength(code) > MAX_HIGHLIGHT_BYTES ||
    lines.length > MAX_HIGHLIGHT_LINES ||
    lines.some((line) => Buffer.byteLength(line) > MAX_HIGHLIGHT_LINE_BYTES)
  );
}

function highlightDiffLines(lines: string[]): string[] {
  return lines.map((line) => {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      return DIFF_FORMATTERS.addition(line);
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      return DIFF_FORMATTERS.deletion(line);
    }
    if (line.startsWith("@@")) {
      return DIFF_FORMATTERS.hunk(line);
    }
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ")
    ) {
      return DIFF_FORMATTERS.meta(line);
    }
    return line;
  });
}

function notifyHighlighterState(): void {
  for (const listener of listeners) listener();
}

/**
 * Loads the optional syntax engine once. A failed warmup intentionally leaves
 * code blocks as plain text rather than affecting the CLI or retrying forever.
 */
export function warmSyntaxHighlighter(): Promise<void> {
  highlighterLoad ??= (() => {
    highlighterState = "loading";
    notifyHighlighterState();
    return import("./syntaxHighlightRuntime")
      .then((runtime) => {
        highlighter = runtime.highlightCodeLines;
        highlighterState = "ready";
        notifyHighlighterState();
      })
      .catch(() => {
        highlighterState = "unavailable";
        notifyHighlighterState();
      });
  })();
  return highlighterLoad;
}

export function subscribeSyntaxHighlighter(listener: SyntaxHighlightListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function syntaxHighlighterSnapshot(): SyntaxHighlighterState {
  return highlighterState;
}

/** Whether a code fence is eligible for the optional syntax engine. */
export function needsSyntaxHighlighter(lines: string[], language?: string): boolean {
  if (!language || lines.length === 0) return false;

  const code = lines.join("\n");
  const normalized = normalizedLanguage(language);
  return Boolean(normalized && normalized !== "diff" && !exceedsHighlightLimits(code, lines));
}

/** Loads the syntax engine only after a renderable non-diff code fence needs it. */
export function requestSyntaxHighlighter(lines: string[], language?: string): void {
  if (!needsSyntaxHighlighter(lines, language)) return;

  void warmSyntaxHighlighter();
}

/**
 * Diff fences stay available on the lightweight startup path. Other languages
 * render plainly until the background syntax engine becomes ready.
 */
export function highlightCodeLines(lines: string[], language?: string): string[] {
  if (!language || lines.length === 0) return lines;

  const code = lines.join("\n");
  const normalized = normalizedLanguage(language);
  if (normalized === "diff") {
    return exceedsHighlightLimits(code, lines) ? lines : highlightDiffLines(lines);
  }
  if (!normalized || !highlighter || exceedsHighlightLimits(code, lines)) return lines;

  return highlighter(lines, normalized);
}
