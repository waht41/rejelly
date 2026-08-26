/**
 * Analyze Agent
 *
 * Observe-only DevTool assistant.
 * Answers questions about the current trace and can call trace analysis tools.
 */

import { isDeepStrictEqual } from "node:util";
import {
  createAgent,
  equipSystem,
  equipTool,
  equipTraceAttr,
  type Message,
  type ModelAdapter,
  onStream,
  promptChat,
} from "@rejelly/core";
import type { AnalyzeChatMessage, AnalyzeContext } from "@rejelly/devtool-contracts";
import { z } from "zod";
import { createGetTraceProfileTool } from "../tools/trace/get-trace-profile-tool";
import { createInspectNodeTool } from "../tools/trace/inspect-node-tool";
import { createListAgentToolTool } from "../tools/trace/list-agent-tool-tool";
import { createListMessagesTool } from "../tools/trace/list-messages-tool";
import { createListToolCallsTool } from "../tools/trace/list-tool-calls-tool";
import { createSearchTraceEventsTool } from "../tools/trace/search-trace-events-tool";
import { createSearchTraceMessagesTool } from "../tools/trace/search-trace-messages-tool";
import { createSearchTracesTool } from "../tools/trace/search-traces-tool";
import { createDevtoolModel, enableDevtoolReviewOnce } from "./shared";

const AnalyzeContextSchema = z
  .object({
    traceId: z.string().nullable().optional(),
    conversationId: z.string().nullable().optional(),
    activeNodeId: z.string().nullable().optional(),
    activeNodeType: z.string().nullable().optional(),
  })
  .passthrough();

const ANALYZE_SYSTEM_PROMPT = `
You are a DevTool trace analysis assistant in observe-only mode. You do not mutate UI state, execute UI actions, or output state patches. Use tools to gather facts, then answer the user.

Each user message may carry a <current-ui-context> block describing the UI state at the time that question was asked. When turns carry different contexts, trust the block closest to the question you are answering; the latest block reflects the current UI.

Your task:
1. Analyze the user's latest chat message.
2. If the user asks about trace duration, token usage, execution path, why something happened, or what the agent did, call get_trace_profile first. If they refer to the current trace, omit traceId and the tool will use the current request's UI context.
3. If the profile shows a relevant node ref like [n4] and the user asks why it failed, why it was slow, whether it succeeded, or what happened inside it, call inspect_node with that ref.
4. If the user asks what tools were available, loaded, enabled, or actually called in a Turn, call list_agent_tool. It defaults to the last Turn.
5. If the user asks what the model saw, prompt/messages/context, or why a model answered a certain way, call list_message. It defaults to the last Turn.
6. If the user asks whether the conversation mentioned something, what the user asked for, whether login/download/success/failure was discussed, or where a natural-language phrase appears in prompts/replies/tool messages, call search_trace_messages.
7. If the user asks whether or where a URL, error message, state path, or other text appears in trace events or tool payloads, call search_trace_events instead of inspecting nodes one by one.
8. If the user asks about tool calls across the trace (which calls failed, which returned suspiciously small output, all calls touching a URL, or the full args/output of one call), call list_tool_calls.
9. If the user asks to find traces across history, list traces matching criteria, or search for traces by status, end reason, text, model, tool, duration, tokens, call counts, or starred state, call search_traces. This is observe-only and does not mutate UI filters.
10. Answer with concrete observations and evidence from the profile or search results. If the request needs mutation, explain that this mode is observe-only.

Rules:
- The response is rendered as markdown in a narrow side panel (~360px). Keep it compact: short paragraphs, bullet lists, inline code. Do not use horizontal rules (---), tables, or headings; use **bold** labels instead. Truncate long URLs/values to their meaningful part.
- For trace analysis, do not guess from the UI tree alone. Use get_trace_profile and cite concrete profile facts such as duration, token totals, LLM calls, tool calls, longest spans, and node refs.
- Use inspect_node for node-specific diagnosis instead of guessing from a summary line.
- Use list_agent_tool for tool availability/tool-call questions instead of inferring from tool execution spans alone.
- Use list_message for prompt/message questions instead of inferring from model output.
- Use search_trace_messages to locate relevant original conversation text before diagnosing intent-heavy questions like login success, download failure, or whether the agent addressed a user request.
- Use search_traces for cross-history trace search. modelsAny/toolsAny mean existence: a trace used any listed model/tool at least once. statuses/endReasons arrays are OR filters; different parameters combine with AND.
- If get_trace_profile returns no traceId error, ask the user to open a trace or provide a traceId.
- For UI mutation requests like filtering, navigating, selecting, expanding, or changing UI state, explain directly that observe-only mode cannot mutate UI state.
- For casual chat ("hi", "hello"), respond briefly and helpfully.
- If a request is impossible or unclear, explain the constraint or ask a concise clarifying question.

Examples:
- "why is this trace slow?" → call get_trace_profile, then explain the longest spans and likely bottleneck.
- "what did the agent do?" → call get_trace_profile, then summarize the execution path.
- "why did [n4] fail?" → call inspect_node with nodeRef "n4", then explain the failure evidence.
- "what tools were loaded?" → call list_agent_tool, then summarize loaded tools and requested tool calls.
- "what messages were sent to the last model call?" → call list_message, then summarize the relevant messages.
- "did login succeed?" → call get_trace_profile and search_trace_messages for login-related text; inspect relevant refs/tool calls if needed.
- "was https://example.com/page ever fetched?" → call search_trace_events with that URL, then report where it appears.
- "which tool calls failed or returned almost nothing?" → call list_tool_calls with success/maxOutputChars filters, then summarize the suspicious calls.
- "find failed traces from the last 24 hours" → call search_traces with timeRange preset 24h and statuses ["failed"], then summarize matching trace ids.
- "show traces that used shell_command" → call search_traces with toolsAny ["shell_command"], then summarize matching trace ids.
- "filter errors" → "Observe-only mode cannot change trace filters. I can search matching traces instead."
- "hi" → "Hello! How can I help?"
`;

function formatUserContent(content: AnalyzeChatMessage["content"], context: AnalyzeContext) {
  const contextBlock = `<current-ui-context>\n${JSON.stringify(
    context,
    null,
    2,
  )}\n(Attached by the system: UI state at the time of this question.)\n</current-ui-context>`;

  if (typeof content === "string") {
    return `${contextBlock}\n\n${content}`;
  }

  if (content === null) {
    return contextBlock;
  }

  return [{ type: "text" as const, text: contextBlock }, ...content];
}

export function buildAnalyzeMessages(
  history: AnalyzeChatMessage[],
  current: { question: string; context?: AnalyzeContext | null },
): Message[] {
  const turns: AnalyzeChatMessage[] = [
    ...history,
    {
      role: "user",
      content: current.question,
      ...(current.context ? { context: current.context } : {}),
    },
  ];
  let previousUserContext: AnalyzeContext | undefined;

  return turns.map((turn) => {
    let content = turn.content;
    if (turn.role === "user" && turn.context) {
      const isDuplicate =
        previousUserContext !== undefined && isDeepStrictEqual(previousUserContext, turn.context);
      previousUserContext = turn.context;
      if (!isDuplicate) {
        content = formatUserContent(content, turn.context);
      }
    }

    if (turn.role === "user") {
      return { role: turn.role, content } satisfies Message;
    }

    return { ...turn, content } satisfies Message;
  });
}

export type AnalyzeAgentResponse = {
  message: string;
  delta: Message[];
};

/**
 * Create analyze agent
 */
export function createAnalyzeAgent(model?: ModelAdapter) {
  // Use provided model or create default one
  const adapter = model || createDevtoolModel();

  enableDevtoolReviewOnce();

  return createAgent<
    {
      question: string;
      history?: AnalyzeChatMessage[];
      context?: AnalyzeContext | null;
      handleReasoningDelta?: (delta: string) => void;
      handleTextDelta?: (delta: string) => void;
      handleToolCall?: (toolName: string, toolCallId?: string) => void;
    },
    AnalyzeAgentResponse
  >({
    id: "analyze_agent",
    model: adapter,
    handler: async (props) => {
      const {
        question,
        history = [],
        context,
        handleReasoningDelta,
        handleTextDelta,
        handleToolCall,
      } = props;
      const safeContext = AnalyzeContextSchema.nullable().optional().parse(context);
      const currentTraceId = safeContext?.traceId ?? null;
      const conversationId = safeContext?.conversationId ?? null;
      const traceToolContext = {
        traceId: currentTraceId,
        defaultTraceDescription: "the current UI trace",
      };

      equipTraceAttr({
        "devtool.source": "ai_analyze",
        "devtool.target_trace_id": currentTraceId,
        "devtool.analyze.conversation_id": conversationId,
        "devtool.active_node_id": safeContext?.activeNodeId ?? null,
        "devtool.active_node_type": safeContext?.activeNodeType ?? null,
      });
      equipTool(createGetTraceProfileTool(traceToolContext));
      equipTool(createInspectNodeTool(traceToolContext));
      equipTool(createListAgentToolTool(traceToolContext));
      equipTool(createListMessagesTool(traceToolContext));
      equipTool(createSearchTraceMessagesTool(traceToolContext));
      equipTool(createSearchTraceEventsTool(traceToolContext));
      equipTool(createListToolCallsTool(traceToolContext));
      equipTool(createSearchTracesTool(traceToolContext));

      equipSystem(ANALYZE_SYSTEM_PROMPT);

      if (handleReasoningDelta || handleTextDelta || handleToolCall) {
        const streamedToolCallKeys = new Set<string>();

        onStream(async (stream) => {
          for await (const event of stream) {
            if (event.type === "reasoning" && event.delta) {
              handleReasoningDelta?.(event.delta);
              continue;
            }

            if (event.type === "text" && event.delta) {
              handleTextDelta?.(event.delta);
              continue;
            }

            if (event.type === "tool_call" && event.toolCall.name) {
              const key = event.toolCall.id || event.toolCall.name;
              if (!streamedToolCallKeys.has(key)) {
                streamedToolCallKeys.add(key);
                handleToolCall?.(event.toolCall.name, event.toolCall.id);
              }
            }
          }
        });
      }

      const result = await promptChat({
        message: buildAnalyzeMessages(history, { question, context: safeContext }),
      });

      return {
        message: result.data,
        delta: result.delta,
      };
    },
  });
}
