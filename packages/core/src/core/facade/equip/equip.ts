/**
 * Equip Series (Input Equipment)
 *
 * Functions for configuring agent behavior before LLM calls.
 * All equip* functions modify the current context's draft state.
 */

import type { z } from "zod";
import { assertSerializable, sanitizeUndefined } from "../../../utils/object";
import type { Loose } from "../../../utils/type";
import { getCurrentContext } from "../../context/accessor";
import type { EquipToolOptions, ToolCallLoopMiddleware } from "../../context/tool-call-loop";
import { AfterPromptAgentError, DuplicateToolNameError } from "../../domain/errors";
import type { ContentPart, MessageContent } from "../../domain/model";
import type { ToolDefinition } from "../../domain/tool";
import { REJELLY_ROOT } from "../../shared/const";
import { logger } from "../../shared/logger/instance";

function assertBeforePromptAgent(ctx: { draft: { prompted?: boolean } }, fnName: string): void {
  if (ctx.draft.prompted) {
    throw new AfterPromptAgentError(fnName);
  }
}

// ============ Prompt Equipment ============

/**
 * Equip system-level instruction (highest priority)
 *
 * System prompts are placed at the beginning of the conversation.
 * Cleared on each reborn, must be called again.
 *
 * @param text - System instruction text
 *
 * @example
 * equipSystem('You are a helpful customer service agent.');
 * equipSystem('Always respond in JSON format.');
 */
export function equipSystem(text: string): void {
  const ctx = getCurrentContext();
  assertBeforePromptAgent(ctx, "equipSystem");
  ctx.draft.systemPrompts.push(text);
}

/**
 * Equip task instruction
 *
 * Task instructions are sent as user messages.
 * Cleared on each reborn, must be called again.
 *
 * Supports both plain text (string) and multimodal content (ContentPart[]).
 * When string is provided, it's automatically converted to ContentPart[] internally.
 *
 * @param content - Task instruction content (string or ContentPart[])
 *
 * @example
 * // Plain text (backward compatible)
 * equipInstruction('Analyze the following customer query:');
 *
 * @example
 * // Multimodal content
 * equipInstruction([
 *   { type: 'text', text: 'Please look at this chart:' },
 *   { type: 'image', image: { url: 'https://example.com/chart.png' } },
 *   { type: 'text', text: 'Is the trend in the chart rising or falling?' }
 * ]);
 */
export function equipInstruction(content: string | ContentPart[]): void {
  const ctx = getCurrentContext();
  assertBeforePromptAgent(ctx, "equipInstruction");
  // Convert string to ContentPart[] for consistency
  const messageContent: MessageContent = typeof content === "string" ? content : content;
  ctx.draft.instructions.push(messageContent);
}

// ============ Tool Equipment ============

/**
 * Equip tool
 *
 * Registers a tool that LLM can call during conversation.
 * Cleared on each reborn, must be registered again.
 *
 * Supports both static middlewares (via augment) and dynamic middlewares (via options).
 * Execution order (onion model): Dynamic (outer) -> Static (middle) -> Handler (inner)
 *
 * Tool names must be unique within a generation; equipping a name that is
 * already registered throws {@link DuplicateToolNameError}.
 *
 * @param tool - Tool definition with name, description, parameters, and handler
 * @param options - Optional configuration including dynamic middleware array
 * @throws {DuplicateToolNameError} If a tool with the same name is already equipped
 *
 * @example
 * const searchSchema = z.object({
 *   query: z.string().describe('Search keywords'),
 *   limit: z.number().optional().default(10),
 * });
 *
 * equipTool({
 *   name: 'search',
 *   description: 'Search the web for information',
 *   parameters: searchSchema,
 *   handler: async (args) => {
 *     // args is typed as { query: string; limit?: number }
 *     return await searchAPI(args.query, args.limit);
 *   },
 * });
 *
 * @example
 * // With dynamic middleware (contextual, per-agent)
 * equipTool(SafeSearchTool, {
 *   middleware: [
 *     async (ctx, next) => {
 *       // Log tool usage
 *       console.log(`Using tool: ${ctx.toolName}`);
 *       const result = await next();
 *       // Update memory
 *       setHistory(prev => [...prev, result]);
 *       return result;
 *     }
 *   ]
 * });
 */
export function equipTool<TParams extends z.ZodTypeAny>(
  tool: ToolDefinition<TParams>,
  options?: EquipToolOptions,
): void {
  const ctx = getCurrentContext();
  assertBeforePromptAgent(ctx, "equipTool");

  if (ctx.draft.tools.some((t) => t.name === tool.name)) {
    throw new DuplicateToolNameError(tool.name);
  }

  // Merge dynamic and static middlewares
  // Order: Dynamic (outer) -> Static (middle) -> Handler (inner)
  // This ensures:
  // 1. Retry (Static) is closer to handler, avoiding duplicate memory writes on retry
  // 2. Dynamic middleware can access agent context (memory, etc.)
  const dynamicMiddlewares = options?.middleware || [];
  const staticMiddlewares = tool.middlewares || [];
  const allMiddlewares = [...dynamicMiddlewares, ...staticMiddlewares];

  // If no middlewares, register tool as-is
  if (allMiddlewares.length === 0) {
    ctx.draft.tools.push(tool as unknown as ToolDefinition);
    return;
  }

  // Create wrapped tool with merged middlewares
  // The actual middleware execution happens in tool-executor.ts
  const wrappedTool: ToolDefinition<TParams> = {
    ...tool,
    middlewares: allMiddlewares,
  };

  ctx.draft.tools.push(wrappedTool as unknown as ToolDefinition);
}

/**
 * Equip tool-call loop middleware
 *
 * Registers middleware for tool call loop: after the model has already decided
 * to call tools, but before the actual tool execution happens.
 *
 * Middleware receives a read-only snapshot (`ctx`) plus the current tool-call
 * list flowing through the chain (`currentCalls`), and `next(filteredCalls)` to
 * continue. The model's initial list for the turn is always in `originalCalls`.
 *
 * It cannot mutate prompt instructions or schema.
 */
export function equipToolCallLoopMiddleware(middleware: ToolCallLoopMiddleware): void {
  const ctx = getCurrentContext();
  assertBeforePromptAgent(ctx, "equipToolCallLoopMiddleware");
  ctx.draft.toolCallLoopMiddlewares.push(middleware);
}

// ============ Scope Equipment ============

/**
 * Equip scope for child agents
 *
 * Provides environment variables to descendant agents.
 * Data is pushed onto current scope's layer stack.
 *
 * **Semantics**: Current agent provides data for **its child/descendant agents**.
 *
 * **Behavior**:
 * - Data is pushed as a new layer onto the scope stack
 * - Child agents see all ancestor layers (lexical scoping)
 * - Key-level replacement: child layer shadows parent layer (no deep merge)
 * - **undefined** in a layer overwrites the parent's value for that key when merged (use to clear upstream values)
 *
 * **Lifecycle**: Draft state - cleared on reborn, must be called again.
 *
 * **Restrictions**: Values must be JSON-serializable except **undefined** is allowed.
 * - ✅ string, number, boolean, null, undefined, plain object, array
 * - ❌ function, symbol, class instances (Date, Map, Set, etc.)
 * Non-undefined parts are validated; the original object (including undefined keys) is stored so that undefined can clear parent keys.
 *
 * @param data - Scope layer (plain object; values may be undefined to clear parent keys)
 * @throws {TypeError} If data contains non-serializable values (e.g. function, class instance)
 *
 * @example
 * // Parent agent
 * handler: async () => {
 *   equipScope({
 *     userId: 'u_123',
 *     config: { debug: true }
 *   });
 *   await ChildAgent({ ... });
 * }
 *
 * @example
 * // Child can clear parent key with undefined
 * equipScope({ theme: 'dark' });        // parent
 * equipScope({ theme: undefined });     // child overwrites with undefined
 *
 * @example
 * // ❌ These will throw TypeError
 * equipScope({ handler: () => {} });        // function forbidden
 * equipScope({ id: Symbol('id') });         // symbol forbidden
 * equipScope({ date: new Date() });         // class instance forbidden
 * equipScope({ items: new Map() });         // class instance forbidden
 */
export function equipScope<T>(data: Loose<T>): void {
  if (!data || Object.keys(data).length === 0) return;
  // Allow undefined in input; sanitize only for validation (non-undefined parts must be serializable)
  const sanitized = sanitizeUndefined(data);
  assertSerializable(sanitized, "equipScope");

  const ctx = getCurrentContext();
  ctx.draft.scopeLayers.push(data);
}

// ============ Trace Equipment ============

/**
 * Equip trace attributes for the current agent run
 *
 * Attributes are merged onto the event's trace context (`event.trace.attributes`), NOT into
 * the event payload. Where they surface depends on `target` (see below): `agent` (default)
 * tags the agent:end span, `local` tags the current span immediately, `root` tags the
 * top-level (runWith) span immediately. Useful for tagging spans with custom labels
 * (e.g. userId, requestId).
 * Cleared on each reborn; call again after reborn if needed.
 *
 * **Restrictions**: Only JSON-serializable values (same as equipScope).
 *
 * **Key naming**: keys land verbatim as OTLP span attributes (no prefixing), so they appear
 * in your tracing backend exactly as written. Two things to avoid:
 * - The `rejelly.` prefix is reserved for framework attributes; keys starting with it are
 *   skipped (with a warning) to prevent shadowing structural data.
 * - Prefer your own namespace over OTel semantic-convention keys (`http.*`, `service.*`,
 *   `user.id`, …); reusing those can confuse OTel-aware backends.
 *
 * @param attrs - Key-value attributes to merge into the agent span
 *
 * @example
 * equipTraceAttr({ userId: 'u_123', requestId: 'req_abc' });
 */
export interface EquipTraceAttrOptions {
  /**
   * Where to attach attributes:
   * - agent: merge into draft and emit on generation:end/agent:end (default)
   * - local: merge into the current trace span immediately
   * - root: walk up to the top-level (runWith) context and merge into its span
   *   immediately. Surfaces on runWith:end (not runWith:start, which has already
   *   been emitted). Use to tag the run-level span from deep inside a nested agent.
   */
  target?: "agent" | "local" | "root";
}

export function equipTraceAttr(
  attrs: Record<string, unknown>,
  options?: EquipTraceAttrOptions,
): void {
  assertSerializable(attrs, "equipTraceAttr");

  const ctx = getCurrentContext();
  if (options?.target === "local") {
    if (!ctx.trace) return;
    ctx.trace.attributes = { ...(ctx.trace.attributes ?? {}), ...attrs };
    return;
  }

  if (options?.target === "root") {
    let root = ctx;
    while (root.parentContext) root = root.parentContext;
    if (!root.trace) return;
    root.trace.attributes = { ...(root.trace.attributes ?? {}), ...attrs };
    return;
  }

  if (!ctx.agentId && ctx.callId === REJELLY_ROOT) {
    logger.warn(
      "[equipTraceAttr] target 'agent' was called in runWith root context. These attributes do not have an agent:end event to attach to. Use { target: 'local' } (or { target: 'root' }) or call equipTraceAttr inside an agent handler.",
    );
  }

  const draft = ctx.draft;
  if (!draft.traceAttributes) {
    draft.traceAttributes = {};
  }
  Object.assign(draft.traceAttributes, attrs);
}
