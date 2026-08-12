/**
 * Tool approval classifier deciding whether a shell command may auto-pass, needs a prompt, or must
 * always be confirmed (and can never be auto-allowed). No IO — keep it deterministic and
 * unit-testable.
 *
 * Tiers (severity auto < confirm < block):
 *  - "auto"    read-only / inspection only → safe to run without asking.
 *  - "confirm" default → prompt; user may still teach an auto-allow prefix.
 *  - "block"   irreversible / privileged / outbound → always prompt, and the host MUST NOT offer or
 *              honour prefix auto-allow for it (overrides any learned prefix).
 *
 * Conservative by design: a tier is only "auto" when the whole command is provably read-only, and
 * only "block" when it is high-precision dangerous. Everything ambiguous falls back to "confirm".
 */

export type ShellRisk = "auto" | "confirm" | "block";

const SEVERITY: Record<ShellRisk, number> = { auto: 0, confirm: 1, block: 2 };

function worse(a: ShellRisk, b: ShellRisk): ShellRisk {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

interface ParsedCommand {
  /** One argv array per top-level segment, split on operators (&&, ||, |, ;, &). */
  segments: string[][];
  /** $(...) or `...` present anywhere outside single quotes. */
  hasCommandSubstitution: boolean;
  /** > >> < redirection present. */
  hasRedirect: boolean;
  /** Quote never closed — refuse to reason about it. */
  unbalanced: boolean;
}

/**
 * Quote-aware tokenizer. Splits into segments on shell control operators, into argv on whitespace,
 * stripping matched quotes. Good enough to classify; not a full POSIX parser.
 */
function parseCommand(command: string): ParsedCommand {
  const segments: string[][] = [];
  let current: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: '"' | "'" | null = null;
  let hasCommandSubstitution = false;
  let hasRedirect = false;
  let unbalanced = false;

  const endToken = () => {
    if (tokenStarted) {
      current.push(token);
      token = "";
      tokenStarted = false;
    }
  };
  const endSegment = () => {
    endToken();
    if (current.length > 0) {
      segments.push(current);
      current = [];
    }
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];

    if (quote === "'") {
      if (c === "'") quote = null;
      else {
        token += c;
        tokenStarted = true;
      }
      continue;
    }
    if (quote === '"') {
      if (c === '"') {
        quote = null;
      } else if (c === "`") {
        hasCommandSubstitution = true;
      } else if (c === "$" && next === "(") {
        hasCommandSubstitution = true;
        i++;
      } else {
        token += c;
        tokenStarted = true;
      }
      continue;
    }

    if (c === "'" || c === '"') {
      quote = c;
      tokenStarted = true; // empty quotes still form a token (e.g. "")
      continue;
    }
    if (c === "\\") {
      if (next !== undefined) {
        token += next;
        tokenStarted = true;
        i++;
      }
      continue;
    }
    if (c === "`") {
      hasCommandSubstitution = true;
      continue;
    }
    if (c === "$" && next === "(") {
      hasCommandSubstitution = true;
      i++;
      continue;
    }

    if (c === "&" && next === "&") {
      endSegment();
      i++;
      continue;
    }
    if (c === "|" && next === "|") {
      endSegment();
      i++;
      continue;
    }
    if (c === "|" || c === ";" || c === "&") {
      endSegment();
      continue;
    }
    // Newline is a command separator in shell, not whitespace — must split segments so a hidden
    // second command on its own line cannot ride along under the first command's classification.
    if (c === "\n" || c === "\r") {
      endSegment();
      continue;
    }
    if (c === ">" || c === "<") {
      hasRedirect = true;
      endToken();
      if (c === ">" && next === ">") i++;
      continue;
    }
    if (c === " " || c === "\t") {
      endToken();
      continue;
    }

    token += c;
    tokenStarted = true;
  }

  if (quote) unbalanced = true;
  endSegment();

  return { segments, hasCommandSubstitution, hasRedirect, unbalanced };
}

function baseName(token: string): string {
  const parts = token.split(/[/\\]/);
  return parts[parts.length - 1] ?? token;
}

/** First token that is not an option flag. */
function firstPositional(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith("-"));
}

/** Always-block binaries: privileged escalation or raw-disk / power operations. */
const BLOCK_COMMANDS = new Set([
  "sudo",
  "doas",
  "su",
  "dd",
  "mkfs",
  "mkswap",
  "fdisk",
  "parted",
  "wipefs",
  "shred",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "init",
]);

/** Read-only / inspection binaries: safe to auto-run with any arguments. */
const AUTO_COMMANDS = new Set([
  "ls",
  "pwd",
  "echo",
  "cat",
  "head",
  "tail",
  "wc",
  "which",
  "whoami",
  "id",
  "date",
  "hostname",
  "uname",
  "true",
  "printenv",
  "basename",
  "dirname",
  "realpath",
  "stat",
  "file",
  "du",
  "df",
  "tree",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "jq",
  "nl",
  "cmp",
  "diff",
  "comm",
  "column",
]);

const PKG_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);

const GIT_AUTO_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "describe",
  "blame",
  "ls-files",
  "shortlog",
  "reflog",
  "cat-file",
  "version",
]);

const INFO_FLAGS = new Set(["--version", "--help"]);

function rmIsDestructive(args: string[]): boolean {
  for (const a of args) {
    if (a === "--recursive" || a === "--force" || a === "--dir" || a === "-no-preserve-root") {
      return true;
    }
    if (a.startsWith("-") && !a.startsWith("--") && /[rRfd]/.test(a.slice(1))) {
      return true;
    }
  }
  return false;
}

function hasRecursiveFlag(args: string[]): boolean {
  return args.some(
    (a) =>
      a === "-R" ||
      a === "--recursive" ||
      (a.startsWith("-") && !a.startsWith("--") && a.includes("R")),
  );
}

/** Resolve `git`'s subcommand, skipping global options that take a value (-C, -c, …). */
function gitSubcommand(args: string[]): { sub: string; rest: string[] } | null {
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === "-C" || a === "-c" || a === "--git-dir" || a === "--work-tree") {
      i += 2;
      continue;
    }
    if (a.startsWith("-")) {
      i++;
      continue;
    }
    return { sub: a.toLowerCase(), rest: args.slice(i + 1) };
  }
  return null;
}

function classifySegment(argv: string[]): ShellRisk {
  // Strip leading NAME=value environment assignments to reach the real command.
  let idx = 0;
  while (idx < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[idx])) idx++;
  const rest = argv.slice(idx);
  if (rest.length === 0) return "confirm";

  const cmd = baseName(rest[0]).toLowerCase();
  const args = rest.slice(1);

  if (BLOCK_COMMANDS.has(cmd)) return "block";

  if (cmd === "rm") return rmIsDestructive(args) ? "block" : "confirm";
  if ((cmd === "chmod" || cmd === "chown") && hasRecursiveFlag(args)) return "block";

  if (PKG_MANAGERS.has(cmd) && firstPositional(args) === "publish") return "block";

  if (cmd === "git") {
    const g = gitSubcommand(args);
    if (!g) return "confirm";
    if (g.sub === "push" || g.sub === "clean") return "block";
    if (g.sub === "reset" && g.rest.includes("--hard")) return "block";
    if (GIT_AUTO_SUBCOMMANDS.has(g.sub)) return "auto";
    return "confirm";
  }

  // Pure --version / --help invocation of any (non-block) command just prints.
  if (args.length > 0 && args.every((a) => INFO_FLAGS.has(a))) return "auto";

  if (cmd === "tsc") {
    return args.some((a) => a.toLowerCase() === "--noemit") ? "auto" : "confirm";
  }

  if (AUTO_COMMANDS.has(cmd)) return "auto";

  return "confirm";
}

/**
 * A single command with no operators, command substitution, or redirection. Learned auto-allow
 * prefixes only match these — a chained `prefix && something-else` must never slip through a
 * string-prefix match.
 */
export function isSimpleCommand(command: string): boolean {
  const parsed = parseCommand(command.trim());
  return (
    !parsed.unbalanced &&
    parsed.segments.length === 1 &&
    !parsed.hasCommandSubstitution &&
    !parsed.hasRedirect
  );
}

/**
 * Classify a full command line. Returns the worst tier across all top-level segments; command
 * substitution or redirection can never stay "auto" (they may run hidden commands or write files).
 */
export function classifyShellCommand(command: string): ShellRisk {
  const trimmed = command.trim();
  if (!trimmed) return "confirm";

  const parsed = parseCommand(trimmed);
  if (parsed.unbalanced || parsed.segments.length === 0) return "confirm";

  let risk: ShellRisk = "auto";
  for (const segment of parsed.segments) {
    risk = worse(risk, classifySegment(segment));
    if (risk === "block") return "block";
  }

  if (risk === "auto" && (parsed.hasCommandSubstitution || parsed.hasRedirect)) {
    return "confirm";
  }
  return risk;
}
