import { EVENTS, type Message, type ToolDefinition } from "@rejelly/core";
import { z } from "zod";
import type { TraceProfileExecutionNode } from "../../services/trace-profile.service";
import {
  createTraceIdParameter,
  normalizeTraceToolContext,
  type TraceToolContextInput,
  traceDefaultSentence,
  unavailableTraceMessage,
} from "./shared/default-trace-context";
import { asRecord, compactPreview, truncate } from "./shared/format";
import { contentLength, roleOf } from "./shared/message";
import { normalizeNodeRefs, TraceQuery } from "./shared/trace-query";

const DEFAULT_TAIL_LIMIT = 5;
const HEAD_ANCHOR_COUNT = 2;

function createListMessagesParameters(context: ReturnType<typeof normalizeTraceToolContext>) {
  return z.object({
    traceId: createTraceIdParameter(context, "listing messages for"),
    nodeRef: z
      .union([z.string(), z.array(z.string()).min(1)])
      .optional()
      .describe(
        "Optional Turn node ref(s) from get_trace_profile, for example n4, [n4], or [n4, n8]. Defaults to the last Turn.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Tail window size for default mode. Defaults to 5."),
    range: z
      .tuple([z.number().int().min(1), z.number().int().min(1)])
      .optional()
      .describe("1-based inclusive message range to show in full. Overrides default windowing."),
    mode: z
      .enum(["full", "index"])
      .optional()
      .describe(
        "full shows selected message bodies; index shows all messages as one-line summaries.",
      ),
  });
}

type ListMessagesArgs = z.infer<ReturnType<typeof createListMessagesParameters>>;

function contentOf(message: unknown): unknown {
  const candidate = message as Partial<Message>;
  return "content" in candidate ? candidate.content : message;
}

function textPreview(value: unknown, maxLength: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return compactPreview(text, maxLength);
}

function toolCallNames(message: unknown): string[] {
  const toolCalls = (message as Partial<Message>).tool_calls;
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls
    .map((toolCall) => asRecord(toolCall).name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

function indexLine(message: unknown, index: number): string {
  const content = contentOf(message);
  const length = contentLength(content);
  const preview = textPreview(content, 80);
  const tools = toolCallNames(message);
  const toolSuffix = tools.length > 0 ? ` [tool_calls: ${tools.join(", ")}]` : "";
  const previewSuffix = preview ? ` "${preview}"` : "";
  return `#${index + 1} ${roleOf(message)} (${formatCharCount(length)} chars)${previewSuffix}${toolSuffix}`;
}

function formatCharCount(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}

function formatFullMessage(message: unknown, index: number): string[] {
  const tools = toolCallNames(message);
  return [
    `Message ${index + 1}`,
    `- role: ${roleOf(message)}`,
    ...(tools.length > 0 ? [`- tool_calls: ${tools.join(", ")}`] : []),
    `- content: ${truncate(contentOf(message), 2200, "middle")}`,
    "",
  ];
}

function selectedDefaultIndexes(messageCount: number, limit: number): Set<number> {
  const selected = new Set<number>();
  for (let index = 0; index < Math.min(HEAD_ANCHOR_COUNT, messageCount); index += 1) {
    selected.add(index);
  }
  for (let index = Math.max(0, messageCount - limit); index < messageCount; index += 1) {
    selected.add(index);
  }
  return selected;
}

function formatIndexBlock(messages: unknown[], indexes: number[]): string[] {
  if (indexes.length === 0) return [];
  const first = indexes[0];
  const last = indexes[indexes.length - 1];
  return [
    `Messages ${first + 1}-${last + 1} index`,
    ...indexes.map((index) => `- ${indexLine(messages[index], index)}`),
    "- use range=[start,end] for full message bodies",
    "",
  ];
}

function formatMessages(
  turnNode: TraceProfileExecutionNode,
  messages: unknown[],
  options: Pick<ListMessagesArgs, "limit" | "range" | "mode">,
) {
  const mode = options.mode ?? "full";
  const limit = options.limit ?? DEFAULT_TAIL_LIMIT;
  const header = [
    "Turn Messages",
    `- turn_ref: [${turnNode.ref}]`,
    `- turn_span_id: ${turnNode.spanId}`,
    `- message_count: ${messages.length}`,
    "",
  ];

  if (mode === "index") {
    return [...header, ...messages.map((message, index) => `- ${indexLine(message, index)}`)]
      .join("\n")
      .trimEnd();
  }

  if (options.range) {
    const [start, end] = options.range;
    const from = Math.max(0, Math.min(start, end) - 1);
    const to = Math.min(messages.length - 1, Math.max(start, end) - 1);
    const body =
      from <= to
        ? messages
            .slice(from, to + 1)
            .flatMap((message, offset) => formatFullMessage(message, from + offset))
        : [`- range: [${start}, ${end}] selected no messages`, ""];
    return [...header, ...body].join("\n").trimEnd();
  }

  const selected = selectedDefaultIndexes(messages.length, limit);
  const body: string[] = [];
  let collapsed: number[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    if (selected.has(index)) {
      body.push(...formatIndexBlock(messages, collapsed));
      collapsed = [];
      body.push(...formatFullMessage(messages[index], index));
    } else {
      collapsed.push(index);
    }
  }
  body.push(...formatIndexBlock(messages, collapsed));

  return [...header, ...body].join("\n").trimEnd();
}

function formatTurnMessages(
  query: TraceQuery,
  turnNode: TraceProfileExecutionNode,
  options: Pick<ListMessagesArgs, "limit" | "range" | "mode">,
) {
  const turnStart = query.eventOfType(turnNode.spanId, EVENTS.TURN_START);
  return formatMessages(turnNode, turnStart?.messages ?? [], options);
}

export function createListMessagesTool(contextInput?: TraceToolContextInput): ToolDefinition {
  const context = normalizeTraceToolContext(contextInput);
  const parameters = createListMessagesParameters(context);
  return {
    name: "list_message",
    description: `List messages for a Turn node in a trace. Defaults to the latest Turn with head anchors, a tail window, and middle message indexes. Use range for exact message bodies. ${traceDefaultSentence(context)}`,
    parameters,
    handler: async ({ traceId, nodeRef, limit, range, mode }) => {
      const targetTraceId = traceId ?? context.traceId;
      if (!targetTraceId) {
        return unavailableTraceMessage("Message listing", context);
      }

      const query = await TraceQuery.load(targetTraceId);
      const sections = normalizeNodeRefs(nodeRef).map((ref) => {
        const turnNode = ref ? query.findNode(ref) : query.lastTurn();
        if (!turnNode) {
          return ref
            ? `Turn Messages\n- ref: ${ref}\n- error: node not found. Use a Turn ref from get_trace_profile.`
            : "Turn Messages\n- error: no Turn node was found in this trace.";
        }
        if (turnNode.type !== "turn") {
          return `Turn Messages\n- ref: [${turnNode.ref}]\n- error: ${turnNode.name} is not a Turn node.`;
        }

        return formatTurnMessages(query, turnNode, { limit, range, mode });
      });

      return sections.join("\n\n---\n\n");
    },
  };
}
