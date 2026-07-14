import type { ToolDefinition } from "@rejelly/core";
import type { TraceToolContext } from "./trace/shared/default-trace-context";

export interface TraceContext extends TraceToolContext {}

export interface TraceToolDefinition {
  name: string;
  createTool: (context: TraceContext) => ToolDefinition;
}

export async function findLatestTraceId(): Promise<string | undefined> {
  const { traceService } = await import("../services/trace.service");
  const traces = await traceService.listTraces({ pageSize: 1, page: 1, order: "desc" });
  return traces.items[0]?.traceId;
}

export interface ResolvedTraceId {
  traceId: string;
  /** Set when the input was resolved to a different id; surface it to the caller. */
  note?: string;
}

const TRACE_ID_PREFIX_MIN_LENGTH = 6;
const TRACE_ID_PREFIX_CANDIDATE_LIMIT = 10;

/**
 * Resolve a traceId input tolerantly, git-short-SHA style: exact match wins;
 * otherwise a unique prefix (as produced by context-summarization truncation)
 * resolves to the full id. An ambiguous prefix throws with the candidate list;
 * an unknown id passes through so downstream not-found handling applies.
 */
export async function resolveTraceIdInput(input: string): Promise<ResolvedTraceId> {
  const { traceService } = await import("../services/trace.service");
  const candidate = input.replace(/(?:…|\.{3})$/, "");

  if (candidate.length > 0 && (await traceService.hasTrace(candidate))) {
    return candidate === input
      ? { traceId: input }
      : { traceId: candidate, note: `Resolved traceId "${input}" to "${candidate}".` };
  }

  if (candidate.length < TRACE_ID_PREFIX_MIN_LENGTH) {
    return { traceId: input };
  }

  const matches = await traceService.findTraceIdsByPrefix(
    candidate,
    TRACE_ID_PREFIX_CANDIDATE_LIMIT,
  );
  if (matches.length === 1) {
    return {
      traceId: matches[0],
      note: `Resolved traceId prefix "${input}" to "${matches[0]}". Use the full id in later calls.`,
    };
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous traceId prefix "${input}" matches ${matches.length} traces: ${matches.join(", ")}. Provide more characters or the full id.`,
    );
  }
  return { traceId: input };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function traceIdFromArgs(args: unknown): string | undefined {
  if (!isObject(args)) return undefined;
  const traceId = args.traceId;
  return typeof traceId === "string" && traceId.length > 0 ? traceId : undefined;
}

export interface ResolvedCallContext {
  context: TraceContext;
  /** Set when a traceId prefix was resolved to a full id; surface it to the caller. */
  note?: string;
}

/**
 * Resolve the effective trace context for one tool invocation: a traceId in
 * args wins (tolerantly prefix-resolved), otherwise fall back to the base
 * context's traceId or the latest trace. Shared by the MCP server and the CLI
 * so both entry points resolve traceIds the same way.
 */
export async function resolveContext(
  baseContext: TraceContext,
  args: unknown,
): Promise<ResolvedCallContext> {
  const argTraceId = traceIdFromArgs(args);
  if (argTraceId) {
    const { traceId, note } = await resolveTraceIdInput(argTraceId);
    return { context: { ...baseContext, traceId }, note };
  }
  return {
    context: { ...baseContext, traceId: baseContext.traceId ?? (await findLatestTraceId()) },
  };
}

export async function createTraceTools(): Promise<TraceToolDefinition[]> {
  const { createGetTraceProfileTool } = await import("./trace/get-trace-profile-tool");
  const { createInspectNodeTool } = await import("./trace/inspect-node-tool");
  const { createListAgentToolTool } = await import("./trace/list-agent-tool-tool");
  const { createListMessagesTool } = await import("./trace/list-messages-tool");
  const { createListToolCallsTool } = await import("./trace/list-tool-calls-tool");
  const { createSearchTracesTool } = await import("./trace/search-traces-tool");
  const { createSearchTraceEventsTool } = await import("./trace/search-trace-events-tool");
  const { createSearchTraceMessagesTool } = await import("./trace/search-trace-messages-tool");

  return [
    {
      name: "search_traces",
      createTool: (context) => createSearchTracesTool(context),
    },
    {
      name: "get_trace_profile",
      createTool: (context) => createGetTraceProfileTool(context),
    },
    {
      name: "inspect_node",
      createTool: (context) => createInspectNodeTool(context),
    },
    {
      name: "list_message",
      createTool: (context) => createListMessagesTool(context),
    },
    {
      name: "search_trace_messages",
      createTool: (context) => createSearchTraceMessagesTool(context),
    },
    {
      name: "list_agent_tool",
      createTool: (context) => createListAgentToolTool(context),
    },
    {
      name: "search_trace_events",
      createTool: (context) => createSearchTraceEventsTool(context),
    },
    {
      name: "list_tool_calls",
      createTool: (context) => createListToolCallsTool(context),
    },
  ];
}
