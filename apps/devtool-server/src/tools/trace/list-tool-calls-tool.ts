import type { ToolDefinition } from "@rejelly/core";
import { z } from "zod";
import {
  createTraceIdParameter,
  normalizeTraceToolContext,
  type TraceToolContextInput,
  traceDefaultSentence,
  unavailableTraceMessage,
} from "./shared/default-trace-context";
import { compactPreview, truncate } from "./shared/format";
import {
  DEGRADED_OUTPUT_CHARS,
  isDegradedToolCall,
  type ToolCallRecord,
  TraceQuery,
} from "./shared/trace-query";

const DEFAULT_LIST_LIMIT = 30;
const DETAIL_OUTPUT_CHARS = 4000;

function createListToolCallsParameters(context: ReturnType<typeof normalizeTraceToolContext>) {
  return z.object({
    traceId: createTraceIdParameter(context, "listing tool calls for"),
    toolName: z.string().optional().describe("Only calls of this tool name."),
    success: z.boolean().optional().describe("Filter by success (true) or failure (false)."),
    maxOutputChars: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Only calls whose raw output length is at most this many chars. Useful for finding degraded results.",
      ),
    minDuration: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Only calls that took at least this many milliseconds."),
    textMatch: z
      .string()
      .optional()
      .describe("Case-insensitive text that must appear in the call args or output, e.g. a URL."),
    callId: z
      .string()
      .optional()
      .describe(
        "Show full detail for one call by its call id, including complete args and raw output. Other filters are ignored.",
      ),
    outputOffset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Char offset into the raw output for callId detail mode. Defaults to 0."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Maximum calls listed. Defaults to 30."),
  });
}

type ListToolCallsArgs = z.infer<ReturnType<typeof createListToolCallsParameters>>;

function compactArgs(input: unknown, maxLength: number): string {
  if (input === undefined || input === null) return "(none)";
  try {
    return compactPreview(JSON.stringify(input), maxLength);
  } catch {
    return compactPreview(String(input), maxLength);
  }
}

function statusLabel(call: ToolCallRecord): string {
  if (call.success === true) return "success";
  if (call.success === false) return "failed";
  return "unknown";
}

function matchesFilters(call: ToolCallRecord, args: ListToolCallsArgs): boolean {
  if (args.toolName && call.toolName !== args.toolName) return false;
  if (args.success !== undefined && call.success !== args.success) return false;
  if (args.maxOutputChars !== undefined && call.rawOutput.length > args.maxOutputChars)
    return false;
  if (args.minDuration !== undefined && (call.duration ?? 0) < args.minDuration) return false;
  if (args.textMatch) {
    const needle = args.textMatch.toLowerCase();
    const inArgs = JSON.stringify(call.input ?? "")
      .toLowerCase()
      .includes(needle);
    const inOutput = call.rawOutput.toLowerCase().includes(needle);
    if (!inArgs && !inOutput) return false;
  }
  return true;
}

function formatCallLine(call: ToolCallRecord): string[] {
  const ref = call.nodeRef ? `[${call.nodeRef}] ` : "";
  const degraded = isDegradedToolCall(call) ? " DEGRADED" : "";
  const cache = call.cache ? " (cache)" : "";
  const lines = [
    `${call.ordinal}. ${ref}${call.toolName} call_id=${call.callId} ${statusLabel(call)} ${
      call.duration != null ? `${call.duration}ms` : "n/a"
    } output_chars=${call.rawOutput.length}${degraded}${cache}`,
    `   args: ${compactArgs(call.input, 240)}`,
  ];
  if (call.rawOutput) lines.push(`   output: "${compactPreview(call.rawOutput, 160)}"`);
  if (call.error) lines.push(`   error: ${truncate(call.error, 300)}`);
  return lines;
}

function formatCallDetail(call: ToolCallRecord, outputOffset: number): string {
  const lines = [
    "Tool Call Detail",
    `- call_id: ${call.callId}`,
    `- tool: ${call.toolName}`,
    `- node_ref: ${call.nodeRef ? `[${call.nodeRef}]` : "(unknown)"}`,
    `- status: ${statusLabel(call)}${isDegradedToolCall(call) ? " (degraded: short output)" : ""}`,
    `- duration: ${call.duration != null ? `${call.duration}ms` : "unknown"}`,
    ...(call.cache ? ["- cache: hit"] : []),
    `- args: ${truncate(call.input ?? "(none)", 2000, "structure")}`,
    ...(call.error ? [`- error: ${truncate(call.error, 1200)}`] : []),
    `- output_chars: ${call.rawOutput.length}`,
  ];

  const from = Math.min(outputOffset, call.rawOutput.length);
  const to = Math.min(from + DETAIL_OUTPUT_CHARS, call.rawOutput.length);
  if (call.rawOutput.length === 0) {
    lines.push("- output: (empty)");
  } else {
    lines.push(`- output[${from}..${to}]:`, call.rawOutput.slice(from, to));
    if (to < call.rawOutput.length) {
      lines.push(
        `... use outputOffset=${to} to continue (${call.rawOutput.length - to} chars remaining)`,
      );
    }
  }
  return lines.join("\n");
}

function formatCallList(query: TraceQuery, args: ListToolCallsArgs): string {
  const all = query.toolCalls;
  const matched = all.filter((call) => matchesFilters(call, args));
  const limit = args.limit ?? DEFAULT_LIST_LIMIT;
  const shown = matched.slice(0, limit);
  const failed = matched.filter((call) => call.success === false).length;
  const degraded = matched.filter((call) => isDegradedToolCall(call)).length;

  const lines = [
    "Tool Calls",
    `- trace_id: ${query.traceId}`,
    `- total_calls: ${all.length}`,
    `- matched: ${matched.length}${matched.length > shown.length ? ` (showing first ${shown.length})` : ""}`,
    `- failed: ${failed}, degraded: ${degraded} (success with output < ${DEGRADED_OUTPUT_CHARS} chars)`,
    "",
  ];

  if (shown.length === 0) {
    lines.push("- no tool calls matched");
    return lines.join("\n");
  }

  for (const call of shown) {
    lines.push(...formatCallLine(call));
  }
  lines.push("", "- use callId for full args and raw output of one call");
  return lines.join("\n");
}

export function createListToolCallsTool(contextInput?: TraceToolContextInput): ToolDefinition {
  const context = normalizeTraceToolContext(contextInput);
  const parameters = createListToolCallsParameters(context);
  return {
    name: "list_tool_calls",
    description: `List individual tool calls across a trace with args, output size, success, and duration. Filter by tool name, success, output size, duration, or text match (e.g. a URL) to find failed, degraded, or related calls. Pass callId for the full args and raw output of one call. ${traceDefaultSentence(context)}`,
    parameters,
    handler: async (args) => {
      const targetTraceId = args.traceId ?? context.traceId;
      if (!targetTraceId) {
        return unavailableTraceMessage("Tool call listing", context);
      }

      const query = await TraceQuery.load(targetTraceId);

      if (args.callId) {
        const call = query.toolCalls.find((candidate) => candidate.callId === args.callId);
        if (!call) {
          return `Tool Call Detail\n- call_id: ${args.callId}\n- error: call not found in this trace. Run list_tool_calls without callId to see available call ids.`;
        }
        return formatCallDetail(call, args.outputOffset ?? 0);
      }

      return formatCallList(query, args);
    },
  };
}
