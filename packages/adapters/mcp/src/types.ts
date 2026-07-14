/**
 * MCP Adapter Types
 *
 * Facade types for Rejelly: not the official SDK Client; use MCPClientAdapter to avoid confusion.
 */

import type { MessageContent, ToolDefinition, ToolMiddleware } from "@rejelly/core";

/**
 * Options for equipMCP(client, options)
 */
export interface EquipMCPOptions {
  /**
   * Stable id for this logical MCP client — scopes `equipMemo` / list epoch across reborn.
   * e.g. "filesystem-main"
   */
  clientId: string;
  /**
   * Namespace for tool names exposed to the agent / LLM (avoids collisions across MCP servers).
   * `tools` filter always uses native MCP tool names; namespace only affects the registered name.
   * Example: namespace "github" + tool "read_file" => "github_read_file".
   */
  namespace?: string;
  /**
   * Only register these tools — native MCP server names (not namespaced). When omitted, all listed tools are loaded.
   */
  tools?: string[];
  /**
   * When true, skip the tools/list memo for this call, fetch from MCP, and write the result into the memo cache.
   * Use when you know the server tool set changed, or when you need every `equipMCP` to list fresh (pass each time).
   */
  forceRefresh?: boolean;
  /**
   * Follow MCP listTools `nextCursor` until exhausted. Default true.
   */
  autoPaginate?: boolean;
  /**
   * Max tools to collect when auto-paginating (defense against huge servers). Default 100.
   */
  maxItems?: number;
  /**
   * When true, equipMCP adds synthetic `list_resources` / `read_resource` tools to `resourceTools`
   * (not MCP protocol ClientCapabilities — see SDK `Client` if you need those).
   */
  enableResources?: boolean;
  middleware?: ToolMiddleware[];
}

/** Single block in tools/call result.content (multimodal-safe). */
export type McpCallToolContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | {
      type: "resource";
      resource: { uri: string; text?: string; blob?: string; mimeType?: string };
    }
  | { type: string; [key: string]: unknown };

export interface CallToolResult {
  content: McpCallToolContentBlock[];
  isError?: boolean;
}

export interface MCPResourceDescriptor {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** Prompt helpers on MCPKit (optional; methods throw if server does not support prompts). */
export interface MCPPromptsKit {
  list: () => Promise<
    Array<{
      name: string;
      description?: string;
      arguments?: Array<{ name: string; description?: string; required?: boolean }>;
    }>
  >;
  get: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<{
    messages: Array<{
      role: "user" | "assistant" | "system";
      content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
    }>;
    /** Map prompt messages to `equipInstruction` input (`string | ContentPart[]`, see core `MessageContent`) */
    asInstruction: () => MessageContent;
  }>;
}

/**
 * Result of equipMCP: prepared ToolDefinitions; call inject() to register them on the agent.
 */
export interface MCPKit<TClient = unknown> {
  client: TClient;
  /** MCP server tools only (not resource helpers). */
  tools: ToolDefinition[];
  /** Synthetic list_resources / read_resource tools when enableResources is true. */
  resourceTools: ToolDefinition[];
  toolMap: Record<string, ToolDefinition>;
  resourceToolMap: Record<string, ToolDefinition>;
  /** Optional; list/get MCP server prompts for manual equipInstruction wiring. */
  prompts: MCPPromptsKit;
  inject: (options?: {
    /** Default true */
    injectTools?: boolean;
    /** Default false — set true to register resourceTools */
    injectResourceTools?: boolean;
    middleware?: ToolMiddleware[];
  }) => void;
}

/**
 * Facade contract for typing MCP clients passed to equipMCP / stored in equipResource — not SDK `Client` typing.
 * Pass-through JSON Schema on tools; multimodal content on callTool results.
 */
export interface MCPClientAdapter {
  close(): Promise<void>;
  listTools(params?: { cursor?: string }): Promise<
    | Array<{
        name: string;
        description?: string;
        /** Preserve full JSON Schema from server (anyOf, enum, etc.). */
        inputSchema?: Record<string, unknown>;
      }>
    | {
        tools: Array<{
          name: string;
          description?: string;
          inputSchema?: Record<string, unknown>;
        }>;
        nextCursor?: string;
      }
  >;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  listResources(params?: {
    cursor?: string;
  }): Promise<
    MCPResourceDescriptor[] | { resources: MCPResourceDescriptor[]; nextCursor?: string }
  >;
  readResource(uri: string | { uri: string }): Promise<{
    contents: Array<{
      uri: string;
      mimeType?: string;
      text?: string;
      blob?: string;
      [key: string]: unknown;
    }>;
  }>;
  /** Conceptually getPrompt(name, args); SDK often uses a single params object */
  getPrompt?(...args: unknown[]): Promise<unknown>;
  listPrompts?(...args: unknown[]): Promise<unknown>;
}
