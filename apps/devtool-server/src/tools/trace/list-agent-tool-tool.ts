import { EVENTS, type ToolDefinition } from "@rejelly/core";
import type { TraceProfileExecutionNode } from "../../services/trace-profile.service";
import { createNodeScopedTool } from "./shared/create-trace-tool";
import {
  normalizeTraceToolContext,
  type TraceToolContextInput,
  traceDefaultSentence,
  unavailableTraceMessage,
} from "./shared/default-trace-context";
import { asRecord, truncate } from "./shared/format";
import { isEvent, type TraceQuery } from "./shared/trace-query";

function schemaPropertyNames(parameters: unknown): string {
  const params = asRecord(parameters);
  const properties = asRecord(params.properties);
  const names = Object.keys(properties);
  return names.length > 0 ? names.join(", ") : "(none)";
}

function formatLoadedTools(toolConfig: unknown): string[] {
  const config = asRecord(toolConfig);
  const tools = Array.isArray(config.tools) ? config.tools : [];
  if (tools.length === 0) return ["- none"];

  return tools.map((tool, index) => {
    const record = asRecord(tool);
    const middlewares = Array.isArray(record.middlewares)
      ? `, middlewares=${record.middlewares
          .map((middleware) => asRecord(middleware).name)
          .filter((name) => typeof name === "string")
          .join("|")}`
      : "";
    return `- ${index + 1}. ${record.name ?? "(unknown)"}: params=${schemaPropertyNames(record.parameters)}${middlewares}\n  description: ${truncate(record.description ?? "", 500)}`;
  });
}

function formatToolChoice(toolConfig: unknown): string {
  const config = asRecord(toolConfig);
  if (!("toolChoice" in config)) return "auto/default";
  return truncate(config.toolChoice, 500, "structure");
}

function findRequestedToolCalls(query: TraceQuery, turnNode: TraceProfileExecutionNode) {
  const modelSpanIds = new Set(
    query.events
      .filter(
        (event) =>
          event.trace.parentSpanId === turnNode.spanId && isEvent(event, EVENTS.MODEL_CALL_START),
      )
      .map((event) => event.trace.spanId),
  );

  return query.events.flatMap((event) => {
    if (!isEvent(event, EVENTS.MODEL_CALL_END) || !modelSpanIds.has(event.trace.spanId)) return [];
    return event.toolCalls ?? [];
  });
}

function formatRequestedToolCalls(toolCalls: unknown[]): string[] {
  if (toolCalls.length === 0) return ["- none"];

  return toolCalls.map((toolCall, index) => {
    const record = asRecord(toolCall);
    return `- ${index + 1}. ${record.name ?? record.toolName ?? "(unknown)"} id=${record.id ?? record.callId ?? "unknown"} args=${truncate(record.args ?? record.input ?? {}, 700, "structure")}`;
  });
}

function formatTurnTools(query: TraceQuery, turnNode: TraceProfileExecutionNode) {
  const turnStart = query.eventOfType(turnNode.spanId, EVENTS.TURN_START);
  const toolConfig = turnStart?.toolConfig;
  const loadedTools = formatLoadedTools(toolConfig);
  const requestedToolCalls = findRequestedToolCalls(query, turnNode);

  return [
    "Agent Tools",
    `- turn_ref: [${turnNode.ref}]`,
    `- turn_span_id: ${turnNode.spanId}`,
    `- tool_choice: ${formatToolChoice(toolConfig)}`,
    `- loaded_tool_count: ${loadedTools[0] === "- none" ? 0 : loadedTools.length}`,
    "",
    "Loaded tools",
    ...loadedTools,
    "",
    "Requested tool calls",
    ...formatRequestedToolCalls(requestedToolCalls),
  ].join("\n");
}

export function createListAgentToolTool(contextInput?: TraceToolContextInput): ToolDefinition {
  const context = normalizeTraceToolContext(contextInput);
  return createNodeScopedTool(
    {
      name: "list_agent_tool",
      description: `List the tools actually loaded for a Turn. Defaults to the latest Turn. Also shows tool calls requested by the model in that Turn. ${traceDefaultSentence(context)}`,
      unavailableMessage: unavailableTraceMessage("Agent tool listing", context),
      defaultToLastTurn: true,
      requireTurn: true,
      notFoundMessage: (ref) =>
        ref
          ? `Agent Tools\n- ref: ${ref}\n- error: node not found. Use a Turn ref from get_trace_profile.`
          : "Agent Tools\n- error: no Turn node was found in this trace.",
      notTurnMessage: (node) =>
        `Agent Tools\n- ref: [${node.ref}]\n- error: ${node.name} is not a Turn node.`,
      format: formatTurnTools,
    },
    context,
  );
}
