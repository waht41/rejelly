import type { z } from "zod";
import type { JsonValue } from "../../utils/type";
import { DuplicateToolNameError } from "./errors";
import type { ContentPart } from "./model";

export const TOOL_CONTENT_KEY = "$rejellyContent" as const;

/**
 * Explicit tool handler result for model-facing multimodal content.
 *
 * Plain JSON values remain normal tool outputs. Only this marked object is
 * treated as MessageContent and passed to the model without stringification.
 */
export interface ToolContent {
  readonly [TOOL_CONTENT_KEY]: ContentPart[];
}

export type ToolHandlerResult = string | JsonValue | ToolContent;

export function toolContent(parts: ContentPart[]): ToolContent {
  return { [TOOL_CONTENT_KEY]: parts };
}

export function isToolContent(value: unknown): value is ToolContent {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.hasOwn(value, TOOL_CONTENT_KEY) &&
    Array.isArray((value as Record<string, unknown>)[TOOL_CONTENT_KEY])
  );
}

/**
 * Tool choice strategy
 */
export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

/**
 * Tool context for middleware execution
 *
 * Provides unified context for tool middleware, containing tool information,
 * input parameters, and metadata. Middleware can inspect but not modify
 * the tool definition (read-only reference).
 */
export interface ToolContext {
  /** Tool name */
  toolName: string;
  /** Tool input parameters (parsed and validated) */
  input: any;
  /** Tool parameters schema */
  parameters: z.ZodTypeAny;
  /** Tool description */
  description: string;
  /** Metadata (read-only, for logging, tracing, auth, etc.) */
  metadata: {
    agentId: string;
    /**
     * @deprecated ToolContext does not own a durable application session identity. This field was
     * historically populated with traceId and must not be used. Pass application session data
     * through an application-owned resource instead.
     */
    sessionId?: string;
    traceId?: string;
    /** Provider tool-call id when execution belongs to a model tool loop. */
    toolCallId?: string;
    /** Whether the tool result was served by the core tool cache. */
    fromCache: boolean;
    /** @deprecated Metadata is a closed core contract; add an explicit field instead. */
    [key: string]: unknown;
  };
  /** Static tool definition (read-only reference for introspection) */
  readonly definition: ToolDefinition;
}

/**
 * Tool middleware interface
 *
 * Middleware must be an object with name, handler, and optional config.
 */
export interface ToolMiddleware {
  /** Middleware name (for debugging and logging) */
  name: string;

  /** The middleware handler function */
  handler: (ctx: ToolContext, next: () => Promise<unknown>) => Promise<unknown>;

  /** Optional: config snapshot for debugging/dashboard display */
  config?: Record<string, unknown>;
}

/**
 * Tool definition with Zod schema
 */
export interface ToolDefinition<TParams extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  parameters: TParams;
  handler: (args: z.infer<TParams>) => Promise<unknown>;
  /** Static middleware chain (optional, set by augment) */
  middlewares?: ToolMiddleware[];
}

/**
 * Assert that no two tools in the set share a name.
 *
 * Tool names must be unique within a tool set: the executor resolves calls by
 * name, and providers receive one schema per name. `equipTool` guards the
 * generation draft at registration; the engine primitives (`executeTurn`,
 * `executeTools`) call this on runtime-provided sets (`fork({ tools })`,
 * hand-built `PromptRuntime`) that bypass equipTool.
 *
 * @param tools - Tool set to validate
 * @param site - Entry point name for the error message (e.g. 'executeTurn')
 * @throws {DuplicateToolNameError} If two tools share a name
 */
export function assertUniqueToolNames(tools: ToolDefinition[], site: string): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new DuplicateToolNameError(tool.name, site);
    }
    seen.add(tool.name);
  }
}
