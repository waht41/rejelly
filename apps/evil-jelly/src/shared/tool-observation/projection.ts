/** Pure projection of tool inputs and results into bounded observation text. */

import type { ToolContext } from "@rejelly/core";

function formatPathList(paths: string[], maxShow = 4): string {
  if (paths.length === 0) {
    return "(none)";
  }
  if (paths.length <= maxShow) {
    return paths.join(", ");
  }
  return `${paths.slice(0, maxShow - 1).join(", ")} … (+${paths.length - (maxShow - 1)} more)`;
}

function formatToolProgressLine(ctx: ToolContext): string {
  const input = ctx.input as Record<string, unknown>;

  if (ctx.toolName === "list_directory") {
    const dirPath = typeof input.dirPath === "string" ? input.dirPath : ".";
    const depth = typeof input.depth === "number" ? input.depth : 1;
    return `[Tools] list_directory → ${dirPath} (depth ${depth})…\n`;
  }
  if (ctx.toolName === "read_file") {
    const rawEntries = Array.isArray(input.filePaths) ? (input.filePaths as unknown[]) : [];
    const filePaths = rawEntries.map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      const { path, offset, limit } = (entry ?? {}) as {
        path?: unknown;
        offset?: unknown;
        limit?: unknown;
      };
      const base = typeof path === "string" ? path : "(path)";
      const range =
        offset !== undefined || limit !== undefined ? `@${offset ?? 1}+${limit ?? "∞"}` : "";
      return `${base}${range}`;
    });
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    const reasonHint = reason.length > 0 ? ` | reason: ${reason.slice(0, 80)}` : "";
    return `[Tools] read_file → ${formatPathList(filePaths)}${reasonHint}\n`;
  }
  if (ctx.toolName === "grep") {
    const q = String(input.query ?? "");
    const glob = typeof input.filePattern === "string" ? input.filePattern : "";
    return `[Tools] grep → "${q}"${glob ? ` [glob ${glob}]` : ""}…\n`;
  }
  if (ctx.toolName === "ast_document_symbols") {
    const raw = input.filePath;
    const parts = typeof raw === "string" ? [raw] : Array.isArray(raw) ? (raw as string[]) : [];
    return `[Tools] ast_document_symbols → ${formatPathList(parts)}…\n`;
  }
  if (ctx.toolName === "ast_read_symbol") {
    const fp = typeof input.filePath === "string" ? input.filePath : "";
    const raw = input.symbolName;
    const syms = Array.isArray(raw)
      ? (raw as string[]).join(", ")
      : typeof raw === "string"
        ? raw
        : "";
    return `[Tools] ast_read_symbol → ${fp || "(path)"} [${syms}]…\n`;
  }
  if (ctx.toolName === "ast_read_symbol_code") {
    const fp = typeof input.filePath === "string" ? input.filePath : "";
    const raw = input.symbolName;
    const syms = Array.isArray(raw)
      ? (raw as string[]).join(", ")
      : typeof raw === "string"
        ? raw
        : "";
    return `[Tools] ast_read_symbol_code → ${fp || "(path)"} [${syms}]…\n`;
  }
  if (ctx.toolName === "ast_module_exports") {
    const fp = typeof input.filePath === "string" ? input.filePath : "";
    return `[Tools] ast_module_exports → ${fp || "(path)"}…\n`;
  }
  if (ctx.toolName === "ast_workspace_symbols") {
    const q = typeof input.queryName === "string" ? input.queryName : "";
    return `[Tools] ast_workspace_symbols → "${q}"…\n`;
  }
  if (ctx.toolName === "edit_file") {
    const targets = Array.isArray(input.targets)
      ? (input.targets as Array<Record<string, unknown>>)
      : [];
    if (targets.length > 0) {
      const filePaths = targets
        .map((item) => (typeof item.filePath === "string" ? item.filePath : ""))
        .filter((p) => p.length > 0);
      const totalEdits = targets.reduce((sum, item) => {
        const edits = Array.isArray(item.edits) ? item.edits.length : 0;
        return sum + edits;
      }, 0);
      const editsHint = totalEdits > 0 ? ` (${totalEdits} edits)` : "";
      return filePaths.length > 0
        ? `[Tools] edit_file → ${formatPathList(filePaths)}${editsHint} (building unified diff for review…)\n`
        : `[Tools] edit_file…\n`;
    }
    return `[Tools] edit_file…\n`;
  }
  if (ctx.toolName === "create_file") {
    const targets = Array.isArray(input.targets)
      ? (input.targets as Array<Record<string, unknown>>)
      : [];
    if (targets.length > 0) {
      const filePaths = targets
        .map((item) => (typeof item.filePath === "string" ? item.filePath : ""))
        .filter((p) => p.length > 0);
      return filePaths.length > 0
        ? `[Tools] create_file → ${formatPathList(filePaths)} (preview for review…)\n`
        : `[Tools] create_file…\n`;
    }
    return `[Tools] create_file…\n`;
  }
  if (ctx.toolName === "delete_file") {
    const targetPaths = Array.isArray(input.targetPaths) ? (input.targetPaths as string[]) : [];
    return targetPaths.length > 0
      ? `[Tools] delete_file → ${formatPathList(targetPaths)} (preview for review…)\n`
      : `[Tools] delete_file…\n`;
  }
  if (ctx.toolName === "view_image") {
    const image = typeof input.image === "string" ? input.image : "";
    return `[Tools] view_image → ${image || "(image)"}…\n`;
  }
  if (ctx.toolName === "run_command") {
    const command = typeof input.command === "string" ? input.command : "";
    const cwd = typeof input.cwd === "string" ? input.cwd : "";
    return `[Tools] run_command → ${command}${cwd ? ` (cwd: ${cwd})` : ""}\n`;
  }
  if (ctx.toolName === "mcp_reference") {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    return `[Tools] mcp_reference → "${query || "(empty query)"}"…\n`;
  }
  if (ctx.toolName === "mcp_call") {
    const tool =
      typeof input.tool === "object" && input.tool !== null
        ? (input.tool as Record<string, unknown>)
        : {};
    const serverId = typeof tool.serverId === "string" ? tool.serverId : "";
    const nativeToolName = typeof tool.nativeToolName === "string" ? tool.nativeToolName : "";
    const identity =
      serverId && nativeToolName ? `${serverId}/${nativeToolName}` : serverId || "(MCP tool)";
    return `[Tools] mcp_call → ${identity}…\n`;
  }

  return `[Tools] ${ctx.toolName}…\n`;
}

/**
 * A summary is a headline, rendered as a single truncated row. A command that
 * carries its own newlines (a heredoc, a pasted script) would otherwise still
 * span several rows, since truncation applies per line. The exact text stays
 * recoverable — `/expand-tool #N` prints the tool's arguments verbatim.
 */
function toHeadline(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

export function stringifyToolResult(r: unknown): string {
  if (typeof r === "string") return r;
  try {
    return JSON.stringify(r, null, 2);
  } catch {
    return String(r);
  }
}

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

function summarizeText(value: string): string {
  return `<omitted: ${value.length} chars, ${lineCount(value)} lines>`;
}

const WRITE_TEXT_KEYS = new Set([
  "content",
  "proposedContent",
  "replaceBlock",
  "searchBlock",
  "unifiedDiff",
]);

function summarizeWriteValue(value: unknown, key?: string): unknown {
  if (typeof value === "string" && key !== undefined && WRITE_TEXT_KEYS.has(key)) {
    return summarizeText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => summarizeWriteValue(item, key));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = summarizeWriteValue(child, key);
  }
  return out;
}

function isWriteTool(toolName: string): boolean {
  return ["write", "edit", "multiedit", "edit_file", "create_file", "delete_file"].includes(
    toolName.toLowerCase(),
  );
}

function stringifyToolArgs(toolName: string, input: unknown): string {
  const value = isWriteTool(toolName) ? summarizeWriteValue(input) : input;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function previewToolResult(text: string, maxLines = 6, maxChars = 600): string {
  const lines = text.split("\n").slice(0, maxLines).join("\n").slice(0, maxChars);
  return lines.length < text.length ? `${lines}\n…` : lines;
}

export function projectToolStart(ctx: ToolContext): { summary: string; args: string } {
  return {
    summary: toHeadline(formatToolProgressLine(ctx).replace(/…?\n$/, "")),
    args: stringifyToolArgs(ctx.toolName, ctx.input),
  };
}
