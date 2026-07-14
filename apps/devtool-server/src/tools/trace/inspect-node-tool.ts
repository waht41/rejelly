import { EVENTS, type ToolDefinition, type TraceEvent } from "@rejelly/core";
import type { TraceProfileExecutionNode } from "../../services/trace-profile.service";
import { renderToolOutput } from "../../utils/tool-output";
import { createNodeScopedTool } from "./shared/create-trace-tool";
import {
  normalizeTraceToolContext,
  type TraceToolContextInput,
  traceDefaultSentence,
  unavailableTraceMessage,
} from "./shared/default-trace-context";
import { asRecord, formatDuration, renderTraceEvent, truncate } from "./shared/format";
import { isDegradedToolCall, isEvent, type TraceQuery } from "./shared/trace-query";

function nodeStatusLabel(node: TraceProfileExecutionNode): string {
  return node.status === "error" ? "error (failed)" : node.status;
}

function formatErrors(events: TraceEvent[]): string[] {
  const errors = events
    .map((event) => {
      if (isEvent(event, EVENTS.ERROR)) return event.error;
      if ("success" in event && event.success === false) {
        return "error" in event ? event.error : "errors" in event ? event.errors : event;
      }
      if ("error" in event) return event.error;
      return null;
    })
    .filter((error) => error != null);

  if (errors.length === 0) return ["- none"];
  return errors.map((error, index) => `- error_${index + 1}: ${truncate(error, 1200)}`);
}

function formatUsage(events: TraceEvent[]): string[] {
  const usageLines: string[] = [];
  for (const event of events) {
    if (isEvent(event, EVENTS.MODEL_CALL_END)) {
      usageLines.push(`- model_usage: ${truncate(event.usage ?? "(none)", 1200, "structure")}`);
    }
    if (isEvent(event, EVENTS.BUDGET_UPDATE)) {
      usageLines.push(`- budget_delta: ${truncate(event.delta, 1200, "structure")}`);
    }
  }
  return usageLines.length > 0 ? usageLines : ["- none"];
}

function formatAttributes(events: TraceEvent[]): string[] {
  for (const event of [...events].reverse()) {
    const attrs = event.trace.attributes;
    if (attrs && Object.keys(attrs).length > 0) {
      return [`- ${truncate(attrs, 1600, "structure")}`];
    }
  }
  return ["- none"];
}

function formatToolResults(events: TraceEvent[]): string[] {
  const lines: string[] = [];
  for (const event of events) {
    if (!isEvent(event, EVENTS.TOOLS_EXECUTE_END)) continue;
    for (const [index, result] of event.toolResults.entries()) {
      const record = asRecord(result);
      const rawOutput = renderToolOutput(record.output);
      const degraded = isDegradedToolCall({ success: record.success === true, rawOutput })
        ? ", DEGRADED (short output)"
        : "";
      lines.push(
        `- tool_${index + 1}: ${record.toolName ?? "(unknown)"}, call_id=${record.callId ?? "(unknown)"}, success=${record.success ?? "unknown"}, duration=${record.duration ?? "n/a"}ms, output_chars=${rawOutput.length}${degraded}`,
      );
      lines.push(`  args: ${truncate(record.input ?? "(none)", 600, "structure")}`);
      if (record.error) lines.push(`  error: ${truncate(record.error, 1000)}`);
      if (rawOutput) lines.push(`  output: ${truncate(rawOutput, 1200, "middle")}`);
    }
  }
  if (lines.length === 0) return ["- none"];
  lines.push("- use list_tool_calls with callId for the full args and raw output of one call");
  return lines;
}

function formatInspectNode(query: TraceQuery, node: TraceProfileExecutionNode) {
  const nodeEvents = query.directEvents(node);
  const children = query.directChildren(node);

  return [
    "Node Inspection",
    `- ref: [${node.ref}]`,
    `- name: ${node.name}`,
    `- type: ${node.type}`,
    `- kind: ${node.kind}`,
    `- status: ${nodeStatusLabel(node)}`,
    `- duration: ${formatDuration(node.duration, "n/a")}`,
    `- span_id: ${node.spanId}`,
    `- parent_ref: ${
      node.parentNodeId ? `[${query.nodesById.get(node.parentNodeId)?.ref ?? "unknown"}]` : "(root)"
    }`,
    "",
    "Direct events",
    ...(nodeEvents.length > 0
      ? nodeEvents.flatMap((event) => renderTraceEvent(event))
      : ["(none)"]),
    "",
    "Children",
    ...(children.length > 0
      ? children.map(
          (child) =>
            `- [${child.ref}] ${child.name}${child.status === "error" ? " (failed)" : ""}: ${formatDuration(child.duration, "n/a")}`,
        )
      : ["- none"]),
    "",
    "Errors",
    ...formatErrors(nodeEvents),
    "",
    "Usage",
    ...formatUsage(nodeEvents),
    "",
    "Attributes",
    ...formatAttributes(nodeEvents),
    "",
    "Tool results",
    ...formatToolResults(nodeEvents),
  ].join("\n");
}

export function createInspectNodeTool(contextInput?: TraceToolContextInput): ToolDefinition {
  const context = normalizeTraceToolContext(contextInput);
  return createNodeScopedTool(
    {
      name: "inspect_node",
      description: `Inspect one or more execution nodes from get_trace_profile by node ref, including direct events, children, errors, usage, and tool results. Use this to answer why nodes failed, why they were slow, or what happened inside them. ${traceDefaultSentence(context)}`,
      unavailableMessage: unavailableTraceMessage("Node inspection", context),
      nodeRefRequired: true,
      notFoundMessage: (ref) =>
        `Node Inspection\n- ref: ${ref}\n- error: node not found. Call get_trace_profile again and use refs like [n1].`,
      format: formatInspectNode,
    },
    context,
  );
}
