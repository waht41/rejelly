/**
 * Domain-grouped tool kits: call one function per area instead of repeating equipTool lines in agents.
 * Future: add equipGitHubKit() (git status/diff, PR APIs) when those tools exist.
 */

import { augmentTool, equipTool, type ToolDefinition } from "@rejelly/core";
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
import { evilJellyToolLoggerMiddleware } from "./middlewares/withToolLogger";
import { ReadWebpageTool } from "./readWebpageTool";
import { RunCommandTool } from "./runCommandTool";
import { ViewImageTool } from "./ViewImageTool";
import { WebSearchTool } from "./webSearchTool";

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
 * Kits equip tools only — they install NO context/cost budget. A caller that wants a hard intake
 * ceiling declares one explicitly at its own top level (see seedEvaluator), via
 * `equipContextIntakeBudgetMiddleware` over {@link READ_ONLY_WORKSPACE_TOOL_NAMES}. The interactive
 * coding agent instead relies on the tool-call loop's occupancy-based auto-compaction as its single
 * top-level context bound.
 */
export async function equipReadOnlyWorkspaceKit(
  options: ReadOnlyWorkspaceKitOptions = {},
): Promise<void> {
  const tools = createReadOnlyWorkspaceTools(options.quiet ?? false);
  for (const tool of tools) {
    equipTool(tool);
  }
}

/** Run shell commands in workspace cwd (tests, typecheck, etc.). */
export function equipRunCommandKit(): void {
  equipTool(augmentTool(RunCommandTool, [evilJellyToolLoggerMiddleware]));
}

export interface WebResearchKitOptions {
  /**
   * Equip without the host print/log middleware, for concurrent/background fan-out (e.g. a future
   * batch of research sub-agents) whose tool chatter must not interleave on the shared terminal.
   * Mirrors {@link ReadOnlyWorkspaceKitOptions.quiet}.
   */
  quiet?: boolean;
}

/**
 * Web research substrate: web_search (Bing SERP) + read_webpage (fetch → clean markdown).
 *
 * Like the other kits, this equips tools only — no intake budget. See {@link equipReadOnlyWorkspaceKit}.
 */
export function equipWebResearchKit(options: WebResearchKitOptions = {}): void {
  const quiet = options.quiet ?? false;
  const tools = quiet
    ? [WebSearchTool, ReadWebpageTool]
    : [withHostPrint(WebSearchTool), withHostPrint(ReadWebpageTool)];

  for (const tool of tools) {
    equipTool(tool);
  }
}
