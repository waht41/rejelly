/**
 * MCP SDK compatibility helpers (listTools pagination, etc.)
 */

import { type ContentPart, type JsonSchema, toolContent } from "@rejelly/core";
import type { CallToolResult, MCPResourceDescriptor } from "./types";

/** MCP tools/list item shape */
export interface MCPToolDescriptor {
  name: string;
  description?: string;
  /** Full JSON Schema from server — preserve for jsonSchemaToZod */
  inputSchema?: JsonSchema;
}

/** Minimal surface needed by fromMCPTool / equipMCP */
export interface MCPClientLike {
  listTools(params?: { cursor?: string }): Promise<unknown>;
  callTool(...args: unknown[]): Promise<unknown>;
  listResources?(params?: { cursor?: string }): Promise<unknown>;
  readResource?(uri: string | { uri: string }): Promise<unknown>;
  listPrompts?(...args: unknown[]): Promise<unknown>;
  getPrompt?(...args: unknown[]): Promise<unknown>;
}

function parseListToolsPage(raw: unknown): {
  tools: MCPToolDescriptor[];
  nextCursor?: string;
} {
  if (Array.isArray(raw)) return { tools: raw as MCPToolDescriptor[] };
  if (raw && typeof raw === "object") {
    const o = raw as { tools?: unknown; nextCursor?: string };
    if (Array.isArray(o.tools)) {
      return { tools: o.tools as MCPToolDescriptor[], nextCursor: o.nextCursor };
    }
  }
  return { tools: [] };
}

export interface NormalizeListToolsOptions {
  /** When false, only the first page is fetched. Default true. */
  autoPaginate?: boolean;
  /** Max distinct tool names to collect. Default 100. */
  maxItems?: number;
  /**
   * Native MCP tool names that must be present (exact match).
   * When set, pagination continues until all are found or the server is exhausted.
   * Throws if any remain missing (maxItems hit before all found, or no next page).
   */
  requiredNames?: string[];
}

/**
 * Fetches tools from MCP, optionally following pagination cursors.
 * When requiredNames is set, fails fast if not all names can be resolved.
 */
export async function normalizeListTools(
  client: MCPClientLike,
  options?: NormalizeListToolsOptions,
): Promise<MCPToolDescriptor[]> {
  const autoPaginate = options?.autoPaginate !== false;
  const maxItems = options?.maxItems ?? 100;
  const required = options?.requiredNames?.length ? new Set(options.requiredNames) : null;

  const byName = new Map<string, MCPToolDescriptor>();
  let cursor: string | undefined;
  const listFn = client.listTools.bind(client);

  const missingRequired = (): string[] =>
    required ? [...required].filter((n) => !byName.has(n)) : [];

  for (;;) {
    let raw: unknown;
    try {
      raw = cursor !== undefined ? await listFn({ cursor }) : await listFn();
    } catch {
      raw = await listFn();
    }
    const { tools, nextCursor } = parseListToolsPage(raw);

    for (const t of tools) {
      if (!byName.has(t.name)) {
        byName.set(t.name, t);
      }
      if (!required && byName.size >= maxItems) {
        return Array.from(byName.values()).slice(0, maxItems);
      }
    }

    if (required) {
      const miss = missingRequired();
      if (miss.length === 0) {
        break;
      }
      if (byName.size >= maxItems) {
        throw new Error(
          `[@rejelly/adapter-mcp] maxItems (${maxItems}) reached before collecting all requested tools. Missing: ${miss.join(", ")}`,
        );
      }
      if (!nextCursor || !autoPaginate) {
        throw new Error(
          `[@rejelly/adapter-mcp] Requested tools not found on MCP server. Missing: ${miss.join(", ")}`,
        );
      }
    } else {
      if (byName.size >= maxItems) {
        return Array.from(byName.values()).slice(0, maxItems);
      }
      if (!nextCursor || !autoPaginate) {
        break;
      }
    }

    cursor = nextCursor;
  }

  if (required) {
    const miss = missingRequired();
    if (miss.length > 0) {
      throw new Error(
        `[@rejelly/adapter-mcp] Requested tools not found on MCP server. Missing: ${miss.join(", ")}`,
      );
    }
    return [...required].map((n) => byName.get(n)!);
  }

  return Array.from(byName.values()).slice(0, maxItems);
}

export function parseListResourcesPage(raw: unknown): {
  resources: MCPResourceDescriptor[];
  nextCursor?: string;
} {
  if (Array.isArray(raw)) return { resources: raw };
  if (raw && typeof raw === "object") {
    const o = raw as { resources?: unknown; nextCursor?: string };
    if (Array.isArray(o.resources)) {
      return { resources: o.resources as MCPResourceDescriptor[], nextCursor: o.nextCursor };
    }
  }
  return { resources: [] };
}

export async function listResourcesPage(client: MCPClientLike, cursor?: string) {
  if (typeof client.listResources !== "function") {
    throw new Error("[@rejelly/adapter-mcp] Client has no listResources()");
  }
  try {
    const raw = await client.listResources(cursor !== undefined ? { cursor } : undefined);
    return parseListResourcesPage(raw);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("-32601")) {
      console.warn("[@rejelly/adapter-mcp] Server does not support resources/list.");
      return { resources: [] };
    }
    throw error;
  }
}

type ReadResourceResult = {
  contents: Array<{
    text?: string;
    blob?: string;
    mimeType?: string;
    [key: string]: unknown;
  }>;
};

export async function readResourceNormalized(
  client: MCPClientLike,
  uri: string,
): Promise<ReadResourceResult> {
  if (typeof client.readResource !== "function") {
    throw new Error("[@rejelly/adapter-mcp] Client has no readResource()");
  }
  const fn = client.readResource.bind(client);
  try {
    return (await fn({ uri })) as ReadResourceResult;
  } catch {
    return (await fn(uri)) as ReadResourceResult;
  }
}

function isCallToolResult(x: unknown): x is CallToolResult {
  return !!(
    x &&
    typeof x === "object" &&
    "content" in x &&
    Array.isArray((x as CallToolResult).content)
  );
}

export async function normalizeCallTool(
  client: MCPClientLike,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const fn = client.callTool.bind(client);
  let result: unknown = await fn({ name, arguments: args }).catch(() => undefined);
  if (isCallToolResult(result)) return result;
  result = await fn(name, args).catch(() => undefined);
  if (isCallToolResult(result)) return result;
  throw new Error(`[@rejelly/adapter-mcp] Unexpected callTool() return shape for "${name}"`);
}

function blockToContentPart(block: CallToolResult["content"][number]): ContentPart {
  if (block.type === "text") {
    return { type: "text", text: typeof block.text === "string" ? block.text : "" };
  }

  if (block.type === "image") {
    const data = typeof block.data === "string" ? block.data : "";
    const mimeType = typeof block.mimeType === "string" ? block.mimeType : "image/png";
    return {
      type: "image",
      image: { url: `data:${mimeType};base64,${data}` },
    };
  }

  if (block.type === "resource") {
    const resource =
      block.resource && typeof block.resource === "object"
        ? (block.resource as { uri?: unknown; text?: unknown; blob?: unknown; mimeType?: unknown })
        : {};
    const uri = typeof resource.uri === "string" ? resource.uri : "unknown";
    if (typeof resource.text === "string") {
      return { type: "text", text: resource.text };
    }
    const label = resource.blob
      ? `[Resource blob: ${uri} (${typeof resource.mimeType === "string" ? resource.mimeType : "unknown"})]`
      : `[Resource: ${uri}]`;
    return { type: "text", text: label };
  }

  return { type: "text", text: JSON.stringify(block) };
}

export function formatCallToolResult(result: CallToolResult): unknown {
  if (result.isError) {
    const errorText = result.content
      .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
      .join("\n");
    throw new Error(`MCP tool error: ${errorText}`);
  }
  const onlyText = result.content.every((c) => c.type === "text");
  if (onlyText) {
    const textContent = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    return textContent || result;
  }

  return toolContent(result.content.map(blockToContentPart));
}
