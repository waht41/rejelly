import { registerStartupReadyTask } from "../../../shared/profile/startup/readyTasks";
import { DIFF_COLORS } from "./diffTheme";

const MAX_HIGHLIGHT_BYTES = 512 * 1024;
const MAX_HIGHLIGHT_LINES = 10_000;
const MAX_HIGHLIGHT_LINE_BYTES = 4 * 1024;
const HIGHLIGHT_WARMUP_DELAY_MS = 250;
const ANSI_FOREGROUND_RESET = "\u001B[39m";

type ColorFormatter = (text: string) => string;
type SyntaxHighlighter = (lines: string[], language: string) => string[];
type SyntaxHighlightListener = () => void;

let highlighter: SyntaxHighlighter | undefined;
let highlighterLoad: Promise<void> | undefined;
let snapshotVersion = 0;
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

function notifyHighlighterReady(): void {
  snapshotVersion += 1;
  for (const listener of listeners) listener();
}

/**
 * Loads the optional syntax engine once. A failed warmup intentionally leaves
 * code blocks as plain text rather than affecting the CLI or retrying forever.
 */
export function warmSyntaxHighlighter(): Promise<void> {
  highlighterLoad ??= import("./syntaxHighlightRuntime")
    .then((runtime) => {
      highlighter = runtime.highlightCodeLines;
      notifyHighlighterReady();
    })
    .catch(() => undefined);
  return highlighterLoad;
}

export function subscribeSyntaxHighlighter(listener: SyntaxHighlightListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function syntaxHighlighterSnapshot(): number {
  return snapshotVersion;
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

registerStartupReadyTask(() => {
  const timer = setTimeout(() => {
    void warmSyntaxHighlighter();
  }, HIGHLIGHT_WARMUP_DELAY_MS);
  timer.unref();
});
