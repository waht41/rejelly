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
import { contentLength, roleOf } from "./shared/message";
import { type FieldHit, findFieldHits } from "./shared/search";
import { normalizeNodeRefs, TraceQuery } from "./shared/trace-query";

const DEFAULT_MESSAGE_LIMIT = 20;
const MAX_FIELD_HITS_PER_MESSAGE = 3;

function createSearchTraceMessagesParameters(
  context: ReturnType<typeof normalizeTraceToolContext>,
) {
  return z.object({
    traceId: createTraceIdParameter(context, "searching messages in"),
    text: z
      .string()
      .min(1)
      .describe("Case-insensitive text to find in Turn messages, prompts, or tool messages."),
    nodeRef: z
      .union([z.string(), z.array(z.string()).min(1)])
      .optional()
      .describe(
        "Optional Turn node ref(s) from get_trace_profile. Defaults to all Turn nodes in the trace.",
      ),
    role: z
      .enum(["system", "user", "assistant", "tool"])
      .optional()
      .describe("Optional message role filter."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Maximum number of matching messages to show. Defaults to 20."),
  });
}

type SearchTraceMessagesArgs = z.infer<ReturnType<typeof createSearchTraceMessagesParameters>>;

interface MessageMatch {
  turnNode: TraceProfileExecutionNode;
  messageIndex: number;
  message: unknown;
  hits: FieldHit[];
}

function searchMessage(message: unknown, needle: string): FieldHit[] {
  return findFieldHits(message, needle, { maxHits: MAX_FIELD_HITS_PER_MESSAGE });
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function messageDedupeKey(message: unknown, messageIndex: number): string {
  return `${messageIndex}:${stableStringify(message)}`;
}

function turnNodesForSearch(
  query: TraceQuery,
  nodeRef: SearchTraceMessagesArgs["nodeRef"],
): Array<{ node?: TraceProfileExecutionNode; ref?: string }> {
  if (nodeRef !== undefined) {
    return normalizeNodeRefs(nodeRef).map((ref) => ({
      ref,
      node: ref ? query.findNode(ref) : undefined,
    }));
  }

  return [...query.profile.execution.nodes]
    .filter((node) => node.type === "turn")
    .sort((a, b) => a.startTime - b.startTime)
    .map((node) => ({ node }));
}

function messagesForTurn(query: TraceQuery, turnNode: TraceProfileExecutionNode): unknown[] {
  const turnStart = query.eventOfType(turnNode.spanId, EVENTS.TURN_START);
  return turnStart?.messages ?? [];
}

function formatMessageMatch(match: MessageMatch, index: number): string[] {
  const messageNumber = match.messageIndex + 1;
  return [
    `${index + 1}. [${match.turnNode.ref}] message #${messageNumber} ${roleOf(match.message)} (${contentLength((match.message as Partial<Message>).content)} chars)`,
    ...match.hits.map((hit) => `   - ${hit.path}: "${hit.excerpt}"`),
    `   - full: list_message nodeRef="${match.turnNode.ref}" range=[${messageNumber},${messageNumber}]`,
  ];
}

function formatSearchResult(
  query: TraceQuery,
  text: string,
  args: Pick<SearchTraceMessagesArgs, "nodeRef" | "role" | "limit">,
  matches: MessageMatch[],
  errors: string[],
  stats: { scannedTurns: number; scannedMessages: number; matchedMessages: number },
): string {
  const lines = [
    "Message Search",
    `- trace_id: ${query.traceId}`,
    `- text: "${text}"`,
    `- node_ref_filter: ${args.nodeRef === undefined ? "(all turns)" : JSON.stringify(args.nodeRef)}`,
    `- role_filter: ${args.role ?? "(none)"}`,
    `- scanned_turns: ${stats.scannedTurns}`,
    `- scanned_messages: ${stats.scannedMessages}`,
    `- matched_messages: ${stats.matchedMessages}${
      stats.matchedMessages > matches.length ? ` (showing first ${matches.length})` : ""
    }`,
    "",
  ];

  if (errors.length > 0) {
    lines.push(...errors.map((error) => `- ${error}`), "");
  }

  if (matches.length === 0) {
    lines.push("- no messages matched");
    return lines.join("\n");
  }

  for (const [index, match] of matches.entries()) {
    lines.push(...formatMessageMatch(match, index));
  }
  lines.push("", "- cumulative Turn message history is de-duplicated by message index and content");
  return lines.join("\n");
}

export function createSearchTraceMessagesTool(
  contextInput?: TraceToolContextInput,
): ToolDefinition {
  const context = normalizeTraceToolContext(contextInput);
  const parameters = createSearchTraceMessagesParameters(context);
  return {
    name: "search_trace_messages",
    description: `Search Turn messages in a trace for text in user prompts, assistant replies, tool messages, reasoning, or tool call arguments. De-duplicates cumulative Turn history and returns Turn refs plus list_message ranges for full bodies. ${traceDefaultSentence(context)}`,
    parameters,
    handler: async ({ traceId, text, nodeRef, role, limit }) => {
      const targetTraceId = traceId ?? context.traceId;
      if (!targetTraceId) {
        return unavailableTraceMessage("Message search", context);
      }

      const query = await TraceQuery.load(targetTraceId);
      const needle = text.toLowerCase();
      const maxMessages = limit ?? DEFAULT_MESSAGE_LIMIT;
      const matches: MessageMatch[] = [];
      const errors: string[] = [];
      const seenMessages = new Set<string>();
      let scannedTurns = 0;
      let scannedMessages = 0;
      let matchedMessages = 0;

      for (const { node, ref } of turnNodesForSearch(query, nodeRef)) {
        if (!node) {
          errors.push(`ref ${ref ?? "(none)"} not found. Use a Turn ref from get_trace_profile.`);
          continue;
        }
        if (node.type !== "turn") {
          errors.push(`ref [${node.ref}] is not a Turn node.`);
          continue;
        }

        scannedTurns += 1;
        for (const [messageIndex, message] of messagesForTurn(query, node).entries()) {
          if (role && roleOf(message) !== role) continue;
          scannedMessages += 1;

          const key = messageDedupeKey(message, messageIndex);
          if (seenMessages.has(key)) continue;
          seenMessages.add(key);

          const hits = searchMessage(message, needle);
          if (hits.length === 0) continue;

          matchedMessages += 1;
          if (matches.length < maxMessages) {
            matches.push({ turnNode: node, messageIndex, message, hits });
          }
        }
      }

      return formatSearchResult(query, text, { nodeRef, role, limit }, matches, errors, {
        scannedTurns,
        scannedMessages,
        matchedMessages,
      });
    },
  };
}
