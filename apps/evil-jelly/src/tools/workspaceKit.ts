/**
 * Domain-grouped tool kits: call one function per area instead of repeating equipTool lines in agents.
 * Future: add equipGitHubKit() (git status/diff, PR APIs) when those tools exist.
 */

import { augmentTool, equipTool, type ToolDefinition } from "@rejelly/core";
import { ViewImageTool } from "../domains/workspace/ViewImageTool";
import { evilJellyToolLoggerMiddleware } from "../shared/host/withToolLogger";
import { ListDirTool, ReadFileTool } from "./FileSystemTools";
import { FuzzySearchTool } from "./FuzzySearchTool";
import { GrepSearchTool } from "./GrepSearchTool";
import {
  AstDocumentSymbolsTool,
  AstModuleExportsTool,
  AstReadSymbolCodeTool,
  AstReadSymbolTool,
  AstWorkspaceSymbolsTool,
} from "./heuristicAstTools/document-symbol";
import { AstGetFunctionDependenciesTool } from "./heuristicAstTools/function-dependencies";
import { equipReadFileDedupMiddleware } from "./hooks/readFileDedup";
import { RunCommandTool } from "./runCommandTool";

function withHostPrint(tool: ToolDefinition<any>): ToolDefinition<any> {
  return augmentTool(tool, [evilJellyToolLoggerMiddleware]);
}

const READ_ONLY_WORKSPACE_TOOLS: ToolDefinition<any>[] = [
  ListDirTool,
  FuzzySearchTool,
  GrepSearchTool,
  AstDocumentSymbolsTool,
  AstModuleExportsTool,
  AstReadSymbolTool,
  AstReadSymbolCodeTool,
  AstWorkspaceSymbolsTool,
  AstGetFunctionDependenciesTool,
  ReadFileTool,
  // Returns image `toolContent`, not text: an intake budget only charges string outputs, so
  // including it here equips it without it ever drawing down such a pool.
  ViewImageTool,
];

/**
 * Names of every read-only workspace tool. Exported so a caller that wants a hard intake ceiling
 * (e.g. the audit per-seed fan-out) can equip `equipContextIntakeBudgetMiddleware` over them
 * explicitly at its own top level, rather than having a kit install policy silently.
 */
export const READ_ONLY_WORKSPACE_TOOL_NAMES: string[] = READ_ONLY_WORKSPACE_TOOLS.map(
  (tool) => tool.name,
);

function createReadOnlyWorkspaceTools(quiet: boolean): ToolDefinition<any>[] {
  return quiet ? READ_ONLY_WORKSPACE_TOOLS : READ_ONLY_WORKSPACE_TOOLS.map(withHostPrint);
}

export interface ReadOnlyWorkspaceKitOptions {
  /**
   * Equip the tools without the host print/log middleware. Set for background/concurrent
   * sub-agents (e.g. the audit per-seed fan-out): their tool chatter must not interleave on the
   * shared terminal. Verbosity is the only difference — same tools and names.
   */
  quiet?: boolean;
}

/**
 * Read-only workspace exploration: list, fuzzy paths, grep, AST/symbol tools, read_file.
 *
 * The kit also equips read_file's context-aware result deduplication, but installs NO context/cost
 * budget. A caller that wants a hard intake ceiling declares one explicitly at its own top level
 * (see seedEvaluator), via `equipContextIntakeBudgetMiddleware` over
 * {@link READ_ONLY_WORKSPACE_TOOL_NAMES}. The interactive coding agent instead relies on the
 * tool-call loop's occupancy-based auto-compaction as its single top-level context bound.
 */
export async function equipReadOnlyWorkspaceKit(
  options: ReadOnlyWorkspaceKitOptions = {},
): Promise<void> {
  equipReadFileDedupMiddleware();
  const tools = createReadOnlyWorkspaceTools(options.quiet ?? false);
  for (const tool of tools) {
    equipTool(tool);
  }
}

/** Run shell commands in workspace cwd (tests, typecheck, etc.). */
export function equipRunCommandKit(): void {
  equipTool(augmentTool(RunCommandTool, [evilJellyToolLoggerMiddleware]));
}
