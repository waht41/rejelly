import type { ToolDefinition } from "@rejelly/core";
import { z } from "zod";
import type {
  TraceProfile,
  TraceProfileExecutionNode,
  TraceProfileSpan,
} from "../../services/trace-profile.service";
import { getTraceProfile } from "../../services/trace-profile.service";
import {
  createTraceIdParameter,
  normalizeTraceToolContext,
  type TraceToolContextInput,
  traceDefaultSentence,
  unavailableTraceMessage,
} from "./shared/default-trace-context";
import { asRecord, formatDuration } from "./shared/format";
import { DEGRADED_OUTPUT_CHARS, TraceQuery } from "./shared/trace-query";

function createGetTraceProfileParameters(context: ReturnType<typeof normalizeTraceToolContext>) {
  return z.object({
    traceId: createTraceIdParameter(context, "profiling"),
  });
}

function formatTokens(promptTokens: number, completionTokens: number, totalTokens: number): string {
  return `${totalTokens} = ${promptTokens} prompt + ${completionTokens} completion`;
}

function readFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatTokenDetails(details: Record<string, number>): string {
  const labels: Record<string, string> = {
    cacheReadTokens: "cache_read",
    cacheWriteTokens: "cache_write",
    cacheCreationTokens: "cache_create",
  };
  const order = ["cacheReadTokens", "cacheWriteTokens", "cacheCreationTokens"];
  const parts = order
    .map((key) => ({ key, value: details[key] ?? 0 }))
    .filter(({ value }) => value !== 0)
    .map(({ key, value }) => `${labels[key]}=${value}`);

  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function getSummaryCacheTokenDetails(profile: TraceProfile): Record<string, number> {
  const result: Record<string, number> = {};
  for (const usage of Object.values(profile.usageByModel)) {
    const details = asRecord(asRecord(usage).details);
    for (const key of ["cacheReadTokens", "cacheWriteTokens", "cacheCreationTokens"]) {
      const value = readFiniteNumber(details[key]);
      if (value !== 0) result[key] = (result[key] ?? 0) + value;
    }
  }
  return result;
}

const MAX_ATTR_VALUE_CHARS = 200;

function formatRootAttributes(profile: TraceProfile): string[] {
  const entries = Object.entries(profile.rootAttributes ?? {});
  if (entries.length === 0) return ["(none)"];

  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      const text =
        typeof value === "string"
          ? value
          : typeof value === "number" || typeof value === "boolean"
            ? String(value)
            : JSON.stringify(value);
      const clipped =
        text != null && text.length > MAX_ATTR_VALUE_CHARS
          ? `${text.slice(0, MAX_ATTR_VALUE_CHARS)}...`
          : text;
      return `- ${key}: ${clipped}`;
    });
}

function formatNodeName(node: TraceProfileExecutionNode): string {
  return node.status === "error" ? `${node.name} (failed)` : node.name;
}

function formatNodeTiming(node: TraceProfileExecutionNode): string {
  if (node.duration != null) return ` ${formatDuration(node.duration)}`;
  return node.kind === "span" ? " unknown" : "";
}

const MAX_EXECUTION_PATH_LINES = 80;

function buildExecutionTree(query: TraceQuery): string[] {
  const { profile } = query;
  const result: string[] = [];
  const visited = new Set<string>();
  const roots = profile.execution.rootNodeIds
    .map((nodeId) => query.nodesById.get(nodeId))
    .filter((node): node is TraceProfileExecutionNode => node != null);
  const rootsToPrint = roots.length > 0 ? roots : (query.childrenByParent.get(null) ?? []);

  function visit(node: TraceProfileExecutionNode, depth: number) {
    if (visited.has(node.nodeId) || result.length >= MAX_EXECUTION_PATH_LINES) return;

    visited.add(node.nodeId);
    const branch = depth === 0 ? "" : `${"   ".repeat(depth - 1)}|- `;
    result.push(`${branch}[${node.ref}] ${formatNodeName(node)}${formatNodeTiming(node)}`);

    for (const child of query.directChildren(node)) {
      visit(child, depth + 1);
      if (result.length >= MAX_EXECUTION_PATH_LINES) break;
    }
  }

  for (const root of rootsToPrint.sort((a, b) => a.startTime - b.startTime)) {
    visit(root, 0);
    if (result.length >= MAX_EXECUTION_PATH_LINES) break;
  }

  const remaining = profile.execution.nodes.length - visited.size;
  if (remaining > 0) {
    result.push(`... ${remaining} more nodes omitted`);
  }

  return result.length > 0 ? result : ["(no spans)"];
}

function formatLongestModelCalls(query: TraceQuery): string[] {
  const calls = [...query.profile.llmCalls]
    .filter((call) => call.duration != null)
    .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
    .slice(0, 5);

  if (calls.length === 0) return ["(none)"];

  return calls.map((call, index) => {
    const finish = call.finishReason ?? "unknown";
    const model = call.model ? `, model=${call.model}` : "";
    const ref = query.refBySpanId.get(call.spanId);
    const prefix = ref ? `[${ref}] ` : "";
    return `${index + 1}. ${prefix}${formatDuration(call.duration)}, finish=${finish}, tokens=${call.totalTokens}${model}`;
  });
}

function formatToolExecutions(query: TraceQuery): string[] {
  const usage = new Map<
    string,
    {
      count: number;
      totalDuration: number;
      hasDuration: boolean;
      refs: Set<string>;
      failed: number;
      degraded: number;
    }
  >();

  for (const execution of query.profile.toolExecutions) {
    const ref = query.refBySpanId.get(execution.spanId);
    // Older traces without per-call results fall back to one entry per tool name on the span.
    const calls =
      execution.calls.length > 0
        ? execution.calls
        : (execution.toolNames.length > 0 ? execution.toolNames : [null]).map((toolName) => ({
            toolName,
            duration: execution.duration,
            success: execution.success,
            outputChars: null,
          }));

    for (const call of calls) {
      const name = call.toolName ?? "(unknown tool)";
      const current = usage.get(name) ?? {
        count: 0,
        totalDuration: 0,
        hasDuration: false,
        refs: new Set<string>(),
        failed: 0,
        degraded: 0,
      };
      current.count += 1;
      if (call.duration != null) {
        current.totalDuration += call.duration;
        current.hasDuration = true;
      }
      if (call.success === false) {
        current.failed += 1;
      } else if (
        call.success === true &&
        call.outputChars != null &&
        call.outputChars < DEGRADED_OUTPUT_CHARS
      ) {
        current.degraded += 1;
      }
      if (ref) current.refs.add(ref);
      usage.set(name, current);
    }
  }

  if (usage.size === 0) return ["(none)"];

  return [...usage.entries()]
    .sort((a, b) => b[1].totalDuration - a[1].totalDuration || a[0].localeCompare(b[0]))
    .map(([name, stats]) => {
      const count = stats.count > 1 ? ` x${stats.count}` : "";
      const duration = stats.hasDuration ? `${stats.totalDuration}ms` : "unknown";
      const refs =
        stats.refs.size > 0 ? ` ${[...stats.refs].map((ref) => `[${ref}]`).join(", ")}` : "";
      const flags: string[] = [];
      if (stats.failed > 0) flags.push(`${stats.failed} failed`);
      if (stats.degraded > 0) {
        flags.push(`${stats.degraded} degraded <${DEGRADED_OUTPUT_CHARS} chars output`);
      }
      const flagSuffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
      return `- ${name}${count}${refs}: ${duration}${flagSuffix}`;
    });
}

function getTimingDiagnostics(profile: TraceProfile) {
  const spans = profile.waterfall.spans;
  const spansById = new Map(spans.map((span) => [span.spanId, span]));
  const childrenByParent = new Map<string, TraceProfileSpan[]>();
  let missingParent = 0;
  let childOutsideParent = 0;
  let negativeDuration = 0;
  let siblingOverlap = 0;

  for (const span of spans) {
    if (span.duration != null && span.duration < 0) {
      negativeDuration += 1;
    }

    if (!span.parentSpanId) continue;

    const parent = spansById.get(span.parentSpanId);
    if (!parent) {
      missingParent += 1;
      continue;
    }

    const siblings = childrenByParent.get(span.parentSpanId) ?? [];
    siblings.push(span);
    childrenByParent.set(span.parentSpanId, siblings);

    if (
      span.endTime != null &&
      parent.endTime != null &&
      (span.startTime < parent.startTime || span.endTime > parent.endTime)
    ) {
      childOutsideParent += 1;
    }
  }

  for (const siblings of childrenByParent.values()) {
    const ordered = siblings
      .filter((span) => span.endTime != null)
      .sort((a, b) => a.startTime - b.startTime);

    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (previous.endTime != null && current.startTime < previous.endTime) {
        siblingOverlap += 1;
      }
    }
  }

  return {
    missingParent,
    childOutsideParent,
    negativeDuration,
    siblingOverlap,
  };
}

function formatTraceProfile(query: TraceQuery): string {
  const { profile } = query;
  const { summary } = profile;
  const diagnostics = getTimingDiagnostics(profile);
  const tokenDetails = formatTokenDetails(getSummaryCacheTokenDetails(profile));

  return [
    "Trace Summary",
    `- trace_id: ${profile.traceId}`,
    `- name: ${summary.name ?? "unknown"}`,
    `- status: ${summary.status ?? "unknown"}`,
    `- end_reason: ${summary.endReason ?? "unknown"}`,
    `- duration: ${formatDuration(summary.duration)}`,
    `- spans: ${summary.spanCount}`,
    `- events: ${summary.eventCount}`,
    `- llm_calls: ${summary.llmCallCount}`,
    `- tool_calls: ${summary.toolCallCount}`,
    `- tokens: ${formatTokens(summary.promptTokens, summary.completionTokens, summary.totalTokens)}${tokenDetails}`,
    "",
    "Root attributes",
    ...formatRootAttributes(profile),
    "",
    "Execution tree",
    ...buildExecutionTree(query),
    "",
    "Longest model calls",
    ...formatLongestModelCalls(query),
    "",
    "Tool executions",
    ...formatToolExecutions(query),
    "",
    "Timing diagnostics",
    `- missing_parent: ${diagnostics.missingParent}`,
    `- child_outside_parent: ${diagnostics.childOutsideParent}`,
    `- negative_duration: ${diagnostics.negativeDuration}`,
    `- sibling_overlap: ${diagnostics.siblingOverlap}`,
  ].join("\n");
}

export function createGetTraceProfileTool(contextInput?: TraceToolContextInput): ToolDefinition {
  const context = normalizeTraceToolContext(contextInput);
  const parameters = createGetTraceProfileParameters(context);
  return {
    name: "get_trace_profile",
    description: `Fetch a compact execution profile for a trace: waterfall spans, longest spans, LLM token usage, tool executions, event counts, and summary metrics. Use this before answering questions about trace duration, token usage, execution path, or what the agent did. ${traceDefaultSentence(context)} Framework node names in the execution tree: 'Generation #n' is one agent lifecycle iteration — a generation ending '(reborn)' means the agent restarted itself with new props as generation n+1 (marked by an 'Agent Reborn' node); 'Resource Op create|destroy <resourceId>' is an equipResource lifecycle operation ('(reused)' = an active instance was reused); '<name>.<method>' spans are instrument()-traced dependency calls.`,
    parameters,
    handler: async ({ traceId }) => {
      const targetTraceId = traceId ?? context.traceId;
      if (!targetTraceId) {
        return `${unavailableTraceMessage(
          "Trace profile",
          context,
        )} Ask the user to open a trace or provide a traceId.`;
      }

      return formatTraceProfile(TraceQuery.fromProfile(await getTraceProfile(targetTraceId)));
    },
  };
}
