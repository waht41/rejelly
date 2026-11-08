/** Web research tool assembly, kept separate from workspace tools. */

import { augmentTool, equipTool, type ToolDefinition } from "@rejelly/core";
import { evilJellyToolLoggerMiddleware } from "../../shared/tool-observation/middleware";
import { createReadWebpageTool } from "./readWebpageTool";
import { isWebSearchConfigured } from "./webConfig";
import { WebSearchTool } from "./webSearchTool";

function withHostPrint(tool: ToolDefinition<any>): ToolDefinition<any> {
  return augmentTool(tool, [evilJellyToolLoggerMiddleware]);
}

export interface WebResearchKitOptions {
  /** Session-owned snapshot directory; created only when a page exceeds the inline budget. */
  webpageDirectory: string;
  /**
   * Equip without the host print/log middleware, for concurrent/background fan-out whose tool
   * chatter must not interleave on the shared terminal.
   */
  quiet?: boolean;
}

/** Equip server-side web_search and read_webpage without workspace-tool coupling. */
export function equipWebResearchKit(options: WebResearchKitOptions): void {
  const quiet = options.quiet ?? false;
  const readWebpageTool = createReadWebpageTool(options.webpageDirectory);
  const tools = isWebSearchConfigured() ? [WebSearchTool, readWebpageTool] : [readWebpageTool];

  for (const tool of tools) {
    equipTool(quiet ? tool : withHostPrint(tool));
  }
}
