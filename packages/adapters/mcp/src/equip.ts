/**
 * equipMCP — build MCP tool definitions (external client + memoized list); inject() registers them
 */

import {
  type ContentPart,
  equipMemo,
  equipMemory,
  equipTool,
  type MessageContent,
  type ToolDefinition,
  type ToolMiddleware,
} from "@rejelly/core";
import { z } from "zod";
import { McpProtocolError } from "./errors";
import { fromMCPTool } from "./from-mcp-tool";
import { type McpNativeToolDescriptor, normalizeMcpToolCatalog } from "./gateway";
import {
  listResourcesPage,
  type MCPClientLike,
  normalizeListTools,
  readResourceNormalized,
} from "./mcp-compat";
import type { EquipMCPOptions, MCPKit, MCPPromptsKit } from "./types";

/**
 * Namespaces equipMemory / equipMemo keys for this adapter (aligns with core `__rejelly_internal_*__::`).
 * Shape: `${INTERNAL_MCP_PREFIX}${clientId}::<op>` so keys group by clientId in devtools.
 */
const INTERNAL_MCP_PREFIX = "__rejelly_internal_mcp__::";

function resolvedToolName(mcpName: string, namespace?: string): string {
  if (!namespace) return mcpName;
  return `${namespace}_${mcpName}`;
}

async function normalizeGetPrompt(
  client: MCPClientLike,
  name: string,
  args?: Record<string, unknown>,
): Promise<{
  messages: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  }>;
}> {
  const g = client.getPrompt;
  if (typeof g !== "function") {
    throw new Error("[@rejelly/adapter-mcp] Client has no getPrompt()");
  }
  const fn = g.bind(client) as (...a: unknown[]) => Promise<unknown>;
  let raw: unknown = await fn({ name, arguments: args }).catch(() => undefined);
  if (!raw || typeof raw !== "object" || !("messages" in raw)) {
    raw = await fn(name, args);
  }
  if (!raw || typeof raw !== "object" || !("messages" in raw)) {
    throw new Error("[@rejelly/adapter-mcp] getPrompt() returned an unexpected shape");
  }
  return raw as {
    messages: Array<{
      role: string;
      content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
    }>;
  };
}

function buildPromptsKit(client: MCPClientLike): MCPPromptsKit {
  return {
    list: async () => {
      if (typeof client.listPrompts !== "function") {
        throw new Error("[@rejelly/adapter-mcp] Client has no listPrompts()");
      }
      const raw: unknown = await client.listPrompts();
      if (!Array.isArray(raw)) return [];
      return raw as Awaited<ReturnType<MCPPromptsKit["list"]>>;
    },
    get: async (name, args) => {
      const { messages } = await normalizeGetPrompt(client, name, args);
      return {
        messages: messages as Awaited<ReturnType<MCPPromptsKit["get"]>>["messages"],
        asInstruction: () => messagesToInstruction(messages),
      };
    },
  };
}

function mcpBlockToContentPart(block: {
  type: string;
  [key: string]: unknown;
}): ContentPart | null {
  const t = block.type;
  if (t === "text") {
    const text = typeof block.text === "string" ? block.text : "";
    if (!text) return null;
    return { type: "text", text };
  }
  if (t === "image") {
    let url = "";
    if (typeof block.url === "string") url = block.url;
    else if (
      block.image &&
      typeof block.image === "object" &&
      block.image !== null &&
      "url" in block.image
    ) {
      url = String((block.image as { url?: string }).url ?? "");
    } else if (typeof block.data === "string") {
      url = block.data;
    }
    if (!url) return null;
    return { type: "image", image: { url } };
  }
  if (t === "video") {
    const url = typeof block.url === "string" ? block.url : "";
    if (!url) return null;
    return { type: "video", video: { url } };
  }
  return null;
}

function mcpContentToParts(
  content: string | Array<{ type: string; [key: string]: unknown }>,
): ContentPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  const out: ContentPart[] = [];
  for (const block of content) {
    const part = mcpBlockToContentPart(block);
    if (part) out.push(part);
  }
  return out;
}

/** Aligns with core `MessageContent` / `equipInstruction(content: string | ContentPart[])`. */
function messagesToInstruction(
  messages: Array<{
    role: string;
    content: string | Array<{ type: string; [key: string]: unknown }>;
  }>,
): MessageContent {
  const parts: ContentPart[] = [];
  for (const m of messages) {
    parts.push(...mcpContentToParts(m.content));
  }
  if (parts.length === 0) return "";
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts;
}

function buildMcpToolDefinitions(
  mcpTools: readonly McpNativeToolDescriptor[],
  client: MCPClientLike,
  namespace?: string,
): { tools: ToolDefinition[]; toolMap: Record<string, ToolDefinition> } {
  const tools: ToolDefinition[] = [];
  for (const mcpTool of mcpTools) {
    const regName = resolvedToolName(mcpTool.name, namespace);
    tools.push(fromMCPTool(mcpTool, client, { name: regName }));
  }
  const toolMap: Record<string, ToolDefinition> = {};
  for (const tool of tools) {
    toolMap[tool.name] = tool;
  }
  return { tools, toolMap };
}

function buildResourceToolDefinitions(
  client: MCPClientLike,
  namespace: string | undefined,
  enableResources: boolean,
): { resourceTools: ToolDefinition[]; resourceToolMap: Record<string, ToolDefinition> } {
  const resourceTools: ToolDefinition[] = [];
  if (!enableResources) {
    return { resourceTools, resourceToolMap: {} };
  }
  const listName = namespace ? `${namespace}_list_resources` : "mcp_list_resources";
  const readName = namespace ? `${namespace}_read_resource` : "mcp_read_resource";

  resourceTools.push({
    name: listName,
    description:
      "List MCP resources (paginated). Use the cursor from the response to fetch the next page if present.",
    parameters: z.object({
      cursor: z
        .string()
        .optional()
        .describe("Pagination cursor returned by a previous list_resources call"),
    }),
    handler: async (args) => {
      const page = await listResourcesPage(client, args.cursor);
      return JSON.stringify({
        resources: page.resources.map((r) => ({
          uri: r.uri,
          name: r.name,
          description: r.description,
        })),
        nextCursor: page.nextCursor,
      });
    },
  });

  resourceTools.push({
    name: readName,
    description: "Read one MCP resource by URI. Use list_resources to discover URIs when needed.",
    parameters: z.object({ uri: z.string().describe("Exact resource URI to read") }),
    handler: async (args) => {
      const result = await readResourceNormalized(client, args.uri);
      return result.contents
        .map((c) => c.text ?? (c.blob ? `[Blob: ${c.mimeType ?? "unknown"}]` : JSON.stringify(c)))
        .join("\n");
    },
  });

  const resourceToolMap: Record<string, ToolDefinition> = {};
  for (const tool of resourceTools) {
    resourceToolMap[tool.name] = tool;
  }
  return { resourceTools, resourceToolMap };
}

/**
 * Discover MCP tools and build ToolDefinitions; use kit.inject() to equip them on the current agent.
 * Uses equipMemo so reborn() does not re-fetch the tool list when deps are unchanged; use `forceRefresh` to bust cache.
 */
export async function equipMCP(
  client: MCPClientLike,
  options: EquipMCPOptions,
): Promise<MCPKit<MCPClientLike>> {
  const {
    clientId,
    namespace,
    tools: toolFilter,
    forceRefresh = false,
    autoPaginate = true,
    maxItems = 100,
    enableResources = false,
    middleware = [],
  } = options;

  const [, setListEpoch] = equipMemory<number>(`${INTERNAL_MCP_PREFIX}${clientId}::list_epoch`, 0);
  if (forceRefresh) {
    setListEpoch((e) => e + 1);
  }
  const [listEpoch] = equipMemory<number>(`${INTERNAL_MCP_PREFIX}${clientId}::list_epoch`, 0);

  const toolFilterKey =
    toolFilter !== undefined && toolFilter.length > 0 ? JSON.stringify([...toolFilter].sort()) : "";

  const requiredNames = toolFilter !== undefined && toolFilter.length > 0 ? toolFilter : undefined;

  const loadList = async (): Promise<readonly McpNativeToolDescriptor[]> => {
    if (toolFilter !== undefined && toolFilter.length === 0) {
      return [];
    }
    return normalizeListTools(client, {
      autoPaginate,
      maxItems,
      requiredNames,
    });
  };

  const memoKey = `${INTERNAL_MCP_PREFIX}${clientId}::tools_list`;
  const raw = await equipMemo(memoKey, async () => JSON.stringify(await loadList()), [
    clientId,
    autoPaginate,
    maxItems,
    listEpoch,
    toolFilterKey,
  ] as const);
  const parsedTools: unknown = JSON.parse(raw);
  if (!Array.isArray(parsedTools)) {
    throw new McpProtocolError("Cached tools/list value is not an array", {
      code: "invalid_catalog_shape",
    });
  }
  const mcpTools = normalizeMcpToolCatalog(parsedTools);

  const { tools, toolMap } = buildMcpToolDefinitions(mcpTools, client, namespace);
  const { resourceTools, resourceToolMap } = buildResourceToolDefinitions(
    client,
    namespace,
    enableResources,
  );

  const prompts = buildPromptsKit(client);

  /**
   * Registers MCP tools on the current agent via `equipTool`.
   * Must run in the same Generation and **before** `promptAgent()`; otherwise `@rejelly/core` throws `AfterPromptAgentError` (from the first offending `equipTool` call).
   */
  const inject = (injectOptions?: {
    injectTools?: boolean;
    injectResourceTools?: boolean;
    middleware?: ToolMiddleware[];
  }) => {
    const mw = injectOptions?.middleware ?? middleware;
    const doTools = injectOptions?.injectTools !== false;
    const doResourceTools = injectOptions?.injectResourceTools === true;
    if (doTools) {
      for (const tool of tools) {
        equipTool(tool, { middleware: mw });
      }
    }
    if (doResourceTools) {
      for (const tool of resourceTools) {
        equipTool(tool, { middleware: mw });
      }
    }
  };

  return {
    client,
    tools,
    resourceTools,
    toolMap,
    resourceToolMap,
    prompts,
    inject,
  };
}
