import { highlight, supportsLanguage, type Theme } from "cli-highlight";

const ANSI_FOREGROUND_RESET = "\u001B[39m";

type ColorFormatter = (text: string) => string;

function rgb(red: number, green: number, blue: number): ColorFormatter {
  const open = `\u001B[38;2;${red};${green};${blue}m`;
  return (text) => (text.length > 0 ? `${open}${text}${ANSI_FOREGROUND_RESET}` : text);
}

// Catppuccin Mocha keeps the same low-contrast, background-free character as
// Codex's adaptive dark-terminal default. Only foreground colors are emitted,
// so the code remains readable against the user's own terminal palette.
const CATPPUCCIN_MOCHA_THEME: Theme = {
  keyword: rgb(203, 166, 247),
  built_in: rgb(243, 139, 168),
  type: rgb(249, 226, 175),
  literal: rgb(250, 179, 135),
  number: rgb(250, 179, 135),
  regexp: rgb(243, 139, 168),
  string: rgb(166, 227, 161),
  subst: rgb(137, 220, 235),
  symbol: rgb(242, 205, 205),
  class: rgb(249, 226, 175),
  function: rgb(137, 180, 250),
  title: rgb(137, 180, 250),
  comment: rgb(108, 112, 134),
  doctag: rgb(148, 226, 213),
  meta: rgb(250, 179, 135),
  "meta-keyword": rgb(203, 166, 247),
  "meta-string": rgb(166, 227, 161),
  section: rgb(137, 180, 250),
  tag: rgb(203, 166, 247),
  name: rgb(137, 180, 250),
  "builtin-name": rgb(243, 139, 168),
  attr: rgb(249, 226, 175),
  attribute: rgb(137, 220, 235),
  variable: rgb(205, 214, 244),
  bullet: rgb(249, 226, 175),
  code: rgb(166, 227, 161),
  formula: rgb(148, 226, 213),
  link: rgb(137, 180, 250),
  quote: rgb(166, 173, 200),
  "selector-tag": rgb(203, 166, 247),
  "selector-id": rgb(137, 180, 250),
  "selector-class": rgb(249, 226, 175),
  "selector-attr": rgb(148, 226, 213),
  "selector-pseudo": rgb(245, 194, 231),
  "template-tag": rgb(203, 166, 247),
  "template-variable": rgb(137, 220, 235),
  addition: rgb(166, 227, 161),
  deletion: rgb(243, 139, 168),
};

const LANGUAGE_ALIASES: Record<string, string> = {
  csharp: "cs",
  "c-sharp": "cs",
  golang: "go",
  python3: "python",
  shell: "bash",
};

export function highlightCodeLines(lines: string[], language: string): string[] {
  const normalized = LANGUAGE_ALIASES[language] ?? language;
  if (!supportsLanguage(normalized)) return lines;

  try {
    return highlight(lines.join("\n"), {
      language: normalized,
      ignoreIllegals: true,
      theme: CATPPUCCIN_MOCHA_THEME,
    }).split("\n");
  } catch {
    return lines;
  }
}
