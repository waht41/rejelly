import type { ToolDefinition, TraceEvent } from "@rejelly/core";
import { z } from "zod";
import {
  createTraceIdParameter,
  normalizeTraceToolContext,
  type TraceToolContextInput,
  traceDefaultSentence,
  unavailableTraceMessage,
} from "./shared/default-trace-context";
import { collectFieldHits, type FieldHit } from "./shared/search";
import { TraceQuery } from "./shared/trace-query";

const DEFAULT_EVENT_LIMIT = 20;
const MAX_FIELD_HITS_PER_EVENT = 5;

function createSearchTraceEventsParameters(context: ReturnType<typeof normalizeTraceToolContext>) {
  return z.object({
    traceId: createTraceIdParameter(context, "searching events in"),
    text: z
      .string()
      .min(1)
      .describe(
        "Case-insensitive text to find anywhere in the trace events, e.g. a URL, error message, state path, or tool argument.",
      ),
    eventType: z
      .string()
      .optional()
      .describe('Only search events of this type, e.g. "tools:execute:end" or "model:call:end".'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Maximum number of matching events to show. Defaults to 20."),
  });
}

interface EventMatch {
  sequence: number;
  event: TraceEvent;
  hits: FieldHit[];
}

// "messages" is the cumulative turn history; searching it repeats every earlier
// hit on each later turn. The originating events still match, and list_message
// covers message-level questions.
const EVENT_SKIP_FIELDS = new Set(["type", "trace", "timestamp", "messages"]);

function searchEvent(event: TraceEvent, needle: string): FieldHit[] {
  const hits: FieldHit[] = [];
  for (const [key, value] of Object.entries(event)) {
    if (EVENT_SKIP_FIELDS.has(key)) continue;
    collectFieldHits(value, needle, key, hits, { maxHits: MAX_FIELD_HITS_PER_EVENT });
    if (hits.length >= MAX_FIELD_HITS_PER_EVENT) break;
  }
  return hits;
}

function formatEventMatch(query: TraceQuery, match: EventMatch, index: number): string[] {
  const ref = query.refForEvent(match.sequence, match.event.trace.spanId);
  const refLabel = ref ? `[${ref}] ` : "";
  return [
    `${index + 1}. ${refLabel}${match.event.type} @ ${match.event.timestamp}`,
    ...match.hits.map((hit) => `   - ${hit.path}: "${hit.excerpt}"`),
  ];
}

function formatSearchResult(
  query: TraceQuery,
  text: string,
  eventType: string | undefined,
  matches: EventMatch[],
  stats: { scanned: number; matchedEvents: number },
): string {
  const lines = [
    "Event Search",
    `- trace_id: ${query.traceId}`,
    `- text: "${text}"`,
    `- event_type_filter: ${eventType ?? "(none)"}`,
    `- scanned_events: ${stats.scanned}`,
    `- matched_events: ${stats.matchedEvents}${
      stats.matchedEvents > matches.length ? ` (showing first ${matches.length})` : ""
    }`,
    "",
  ];

  if (matches.length === 0) {
    lines.push("- no events matched");
    return lines.join("\n");
  }

  for (const [index, match] of matches.entries()) {
    lines.push(...formatEventMatch(query, match, index));
  }
  lines.push(
    "",
    "- cumulative turn message history is not searched; use list_message for messages",
    "- use inspect_node with a ref for full event details, or list_tool_calls for tool call details",
  );
  return lines.join("\n");
}

export function createSearchTraceEventsTool(contextInput?: TraceToolContextInput): ToolDefinition {
  const context = normalizeTraceToolContext(contextInput);
  const parameters = createSearchTraceEventsParameters(context);
  return {
    name: "search_trace_events",
    description: `Search all events of a trace for a text such as a URL, error message, state path, or tool argument. Returns matching events with node refs, field paths, and excerpts. Use this to locate where something appears in a trace instead of inspecting nodes one by one. ${traceDefaultSentence(context)}`,
    parameters,
    handler: async ({ traceId, text, eventType, limit }) => {
      const targetTraceId = traceId ?? context.traceId;
      if (!targetTraceId) {
        return unavailableTraceMessage("Event search", context);
      }

      const query = await TraceQuery.load(targetTraceId);
      const needle = text.toLowerCase();
      const maxEvents = limit ?? DEFAULT_EVENT_LIMIT;

      const matches: EventMatch[] = [];
      let scanned = 0;
      let matchedEvents = 0;
      for (const [sequence, event] of query.events.entries()) {
        if (eventType && event.type !== eventType) continue;
        scanned += 1;
        const hits = searchEvent(event, needle);
        if (hits.length === 0) continue;
        matchedEvents += 1;
        if (matches.length < maxEvents) matches.push({ sequence, event, hits });
      }

      return formatSearchResult(query, text, eventType, matches, { scanned, matchedEvents });
    },
  };
}
