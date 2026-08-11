import { arch, platform, release } from "node:os";
import { getShellPath } from "../../domains/workspace/execute/executeShellCommand";
import {
  AGENT_SCRATCH_DIR,
  getWorkspaceFsPolicy,
} from "../../shared/fs-policy/workspace-fs-policy";
import { PromptBuilder } from "../../shared/model/prompt/builder";
import { TERMINAL_USER_REPLY_RULE, TERMINAL_USER_REPLY_RULE_TITLE } from "./outputSurface";

const INSTRUCTION_ARTIFACT_ITEM_MAX_CHARS = 1000;
const INSTRUCTION_MAX_ARTIFACT_ITEMS = 8;

export function formatArtifactSummaryForInstruction(artifacts: Record<string, string>): string {
  const entries = Object.entries(artifacts);
  if (entries.length === 0) {
    return "";
  }

  const compactMiddle = (text: string, maxChars: number): string => {
    if (text.length <= maxChars) {
      return text;
    }
    if (maxChars <= 0) {
      return "";
    }
    const marker = "\n...[middle omitted]...\n";
    if (marker.length >= maxChars) {
      return text.slice(0, maxChars);
    }
    const remainingChars = maxChars - marker.length;
    const headChars = Math.ceil(remainingChars / 2);
    const tailChars = Math.floor(remainingChars / 2);
    return `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`;
  };

  const latestEntries = entries.slice(-INSTRUCTION_MAX_ARTIFACT_ITEMS);
  const lines = latestEntries.map(
    ([artifactId, full]) =>
      `- ${artifactId}: ${compactMiddle(full, INSTRUCTION_ARTIFACT_ITEM_MAX_CHARS)}`,
  );
  return lines.join("\n");
}

export function buildUnifiedSystemPrompt(options?: {
  workspaceRuleBlock: string;
  useTerminalUserReplyRule?: boolean;
}): string {
  const workspaceRuleBlock = options?.workspaceRuleBlock?.trim() ?? "";
  const builder = new PromptBuilder();
  builder.addBlock(
    "You are Evil Jelly, also called Evil, a senior coding agent running inside the Evil Jelly application. You can answer directly, inspect the local workspace, run commands, and MODIFY the repository only when the user asks for code or file changes.",
  );
  builder.addBlock(
    "When you need accurate information about Evil Jelly's CLI capabilities, commands, or options, use run_command to execute `evil --help`. For details about a discovered subcommand, execute `evil <subcommand> --help`. Treat the help output as the source of truth instead of guessing. Help commands are for discovery only; do not execute an Evil Jelly operation merely to learn what it does.",
  );
  builder.when(options?.useTerminalUserReplyRule, (b) =>
    b.addBlock(`${TERMINAL_USER_REPLY_RULE_TITLE}:\n${TERMINAL_USER_REPLY_RULE}`),
  );
  builder.addBlock(
    "For casual or conceptual questions, answer without tools when you already have enough context. For workspace questions, locate files using list_directory / fuzzy_search_paths / grep / ast_document_symbols.",
  );
  builder.addList(
    [
      "When asked to introduce, explain, or summarize a module/project at a high level, prioritize README.md, package.json descriptions, and docs/ before source code.",
      "Use AST/symbol tools for low-token file structure, exports, symbol snippets, and local dependency summaries before reading full files.",
      "For semantic TypeScript tasks such as references, definitions, hover, and implementations, use grep + read_file. There is no language-server/`ts_` tool available; grep over the workspace is the reliable way to find usages and declarations.",
      "Do not treat AST tools as semantic language-server answers for references, definitions, hover, or implementations.",
      "Use read_file only for implementation details after structural skimming or when documentation/AST/search output is insufficient.",
      "Do not recursively read every imported module. Stop after the core files needed to answer the user's request.",
    ],
    { title: "READ-ONLY WORKSPACE STRATEGY:", style: "numbered" },
  );
  builder.addList(
    [
      "For complex, context-heavy edits: Use read_file to get the exact text, then use edit_file.",
      "For bulk/cross-file tasks (e.g., renaming, removing prefixes, regex replacements): DO NOT exhaust your turn budget by reading files one by one. First, use the grep tool to locate all occurrences. Then, immediately construct a single massive edit_file batch containing all targets based on the grep context.",
    ],
    { title: "WRITE STRATEGY SELECTION:", style: "numbered" },
  );
  builder.addBlock(
    "Use edit_file with { targets: [{ filePath, edits }, ...] }. Each edits entry has searchBlock (verbatim from grep/read_file, contiguous and uniquely identifying) and replaceBlock. Batch related cross-file edits in one call when possible so the user reviews one combined diff. Edits apply in order on LF-normalized text; for multiple edits, anchor every searchBlock on the ORIGINAL file and list edits bottom-to-top (end of file first) so earlier edits do not invalidate later searchBlocks. New files use create_file with { targets: [{ filePath, content }, ...] }. Use delete_file with { targetPaths: [...] } to remove obsolete files/directories in batches; already-missing paths are non-fatal warnings. Every write is shown to the user for approval — plan concise steps and avoid redundant edits.",
  );
  builder.addBlock(
    `For temporary scripts, scratch notes, generated intermediates, and other disposable agent files, use ${AGENT_SCRATCH_DIR}/. It is inside the workspace policy boundary and is intended for agent scratch data.`,
  );
  builder.addBlock(
    "Complete related source and test edits in one pass when a change spans multiple files; " +
      "you may call run_command for optional spot-checks (e.g. a single package or test file).",
  );
  builder.addList(
    [
      "When the task is complete, stop calling tools and answer the user directly in plain text. Do not wrap the final answer in JSON, code fences, or schema labels.",
    ],
    { title: "Final output contract (strict):", style: "bullet" },
  );
  builder.addList(
    [
      "DO NOT debug git. If the working tree is correct, the task is done. When you need to know current uncommitted changes, run `git status --short` via run_command instead of assuming.",
    ],
    { title: "CRITICAL RULES:", style: "numbered" },
  );
  builder.addBlock(
    "When tool output is truncated, use the `readArtifact` tool to fetch full content before deciding.",
  );
  if (workspaceRuleBlock.length > 0) {
    // Keep the application-owned framework as the stable prompt prefix. Workspace-specific
    // guidance is the final system block, closest to the task while remaining XML-delimited.
    builder.addBlock(workspaceRuleBlock);
  }
  return builder.build();
}

export function buildUnifiedInstruction(params: { artifactSummary: string }): string {
  const { artifactSummary } = params;
  const currentOs = `${platform()} ${release()} (${arch()})`;
  const shellNote =
    process.platform === "win32"
      ? `${getShellPath()} (cmd.exe syntax; POSIX tools like head/tail/xargs are unavailable — avoid Unix-style pipes)`
      : getShellPath();
  const builder = new PromptBuilder();
  builder.addBlock(
    `## Environment\nWorkspace Root: ${getWorkspaceFsPolicy().getRoot()}\nAgent Scratch Dir: ${AGENT_SCRATCH_DIR}\nCurrent OS: ${currentOs}\nShell: ${shellNote}`,
  );
  builder.when(artifactSummary.length > 0, (b) =>
    b.addBlock(
      "## Previous tool artifacts (truncated)\n" +
        "The snippets below are truncated. Use `readArtifact` with artifactId for full content when needed.\n" +
        `${artifactSummary}`,
    ),
  );
  return builder.build();
}
