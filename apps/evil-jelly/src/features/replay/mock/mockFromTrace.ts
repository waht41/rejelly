import {
  type AgentSnapshot,
  type AgentStartEvent,
  EVENTS,
  type Message,
  type ModelAdapter,
  type StreamEvent,
  type TraceEvent,
  type TurnEndEvent,
} from "@rejelly/core";
import { restoreSnapshot } from "@rejelly/core/debugger";
import { fetchTraceEvents } from "../traceClient";

type TraceReplayStep =
  | {
      type: "stream";
      chunks: string[];
      chunkInterval?: number;
      extra?: Record<string, unknown>;
    }
  | {
      type: "tool_calls";
      calls: Array<{
        id: string;
        name: string;
        arguments: string;
        extra?: Record<string, unknown>;
      }>;
    };

const DEFAULT_TEXT_CHUNK_SIZE = 12;
const MIN_CHUNK_INTERVAL_MS = 1;
const MAX_CHUNK_INTERVAL_MS = 80;
const CONVERSATION_AGENT_IDS = new Set(["evil_jelly_unified_agent", "evil_jelly_workspace_agent"]);

function isTurnEndEvent(event: TraceEvent): event is TurnEndEvent {
  return event.type === EVENTS.TURN_END;
}

function isAgentStartEvent(event: TraceEvent): event is AgentStartEvent {
  return event.type === EVENTS.AGENT_START;
}

function messageText(message: Message): string {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === "text" ? part.text : ""))
      .filter((text) => text.length > 0)
      .join("");
  }
  return "";
}

function splitTextIntoChunks(text: string, chunkSize = DEFAULT_TEXT_CHUNK_SIZE): string[] {
  if (text.length === 0) {
    return [""];
  }
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

function chunkIntervalFor(duration: number, chunkCount: number): number | undefined {
  if (!Number.isFinite(duration) || duration <= 0 || chunkCount <= 1) {
    return undefined;
  }
  const interval = Math.round(duration / chunkCount);
  return Math.max(MIN_CHUNK_INTERVAL_MS, Math.min(MAX_CHUNK_INTERVAL_MS, interval));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function turnEndToReplayStep(event: TurnEndEvent): TraceReplayStep | undefined {
  if (!event.success || !event.message) {
    return undefined;
  }

  const toolCalls = event.message.tool_calls ?? [];
  if (toolCalls.length > 0) {
    return {
      type: "tool_calls",
      calls: toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
        ...(call.extra && Object.keys(call.extra).length > 0 ? { extra: call.extra } : {}),
      })),
    };
  }

  const text = messageText(event.message);
  const chunks = splitTextIntoChunks(text);
  return {
    type: "stream",
    chunks,
    chunkInterval: chunkIntervalFor(event.duration, chunks.length),
    ...(event.message.extra && Object.keys(event.message.extra).length > 0
      ? { extra: event.message.extra }
      : {}),
  };
}

export function traceEventsToReplaySteps(events: TraceEvent[]): TraceReplayStep[] {
  return events
    .filter(isTurnEndEvent)
    .filter((event) => event.success && event.message !== undefined)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((event) => turnEndToReplayStep(event))
    .filter((step): step is TraceReplayStep => step !== undefined);
}

export function createTraceReplayModel(steps: TraceReplayStep[]): ModelAdapter {
  let index = 0;
  return {
    id: "evil-jelly-trace-replay",
    async *stream(): AsyncGenerator<StreamEvent> {
      const step = steps[index];
      index += 1;
      if (!step) {
        throw new Error(
          `Trace replay model exhausted after ${steps.length} step(s); no recorded turn for call ${index}.`,
        );
      }

      if (step.type === "stream") {
        for (let i = 0; i < step.chunks.length; i++) {
          yield { type: "text", content: step.chunks[i] ?? "" };
          if (step.chunkInterval && i < step.chunks.length - 1) {
            await delay(step.chunkInterval);
          }
        }
        if (step.extra && Object.keys(step.extra).length > 0) {
          yield { type: "extra", extra: step.extra };
        }
        yield { type: "finish", finishReason: "stop" };
        return;
      }

      for (let i = 0; i < step.calls.length; i++) {
        const call = step.calls[i];
        yield {
          type: "tool_call",
          toolCall: {
            index: i,
            id: call.id,
            name: call.name,
            arguments: call.arguments,
            ...(call.extra && Object.keys(call.extra).length > 0 ? { extra: call.extra } : {}),
          },
        };
      }
      yield { type: "finish", finishReason: "tool_calls" };
    },
  };
}

export function stripPromptJournal(snapshot: AgentSnapshot): AgentSnapshot {
  const cloned = structuredClone(snapshot);
  const stripFrame = (frame: AgentSnapshot["root"]) => {
    frame.journal.prompt = {};
    for (const child of Object.values(frame.children)) {
      stripFrame(child);
    }
  };
  stripFrame(cloned.root);
  return cloned;
}

function propsUserInput(props: unknown): string | undefined {
  if (!props || typeof props !== "object" || Array.isArray(props)) {
    return undefined;
  }
  const raw = (props as Record<string, unknown>).userInput;
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function traceEventsToMockInputs(events: TraceEvent[]): string[] {
  const inputs: string[] = [];
  for (const event of [...events].sort((a, b) => a.timestamp - b.timestamp)) {
    if (!isAgentStartEvent(event) || !CONVERSATION_AGENT_IDS.has(event.agentId ?? "")) {
      continue;
    }
    const input = propsUserInput(event.props);
    if (input === undefined || inputs[inputs.length - 1] === input) {
      continue;
    }
    inputs.push(input);
  }
  return inputs;
}

export async function loadMockReplayFromTraceId(traceId: string): Promise<{
  model: ModelAdapter;
  snapshot: AgentSnapshot;
  sequenceLength: number;
  inputs: string[];
}> {
  const events = await fetchTraceEvents(traceId);
  const steps = traceEventsToReplaySteps(events);
  if (steps.length === 0) {
    throw new Error(
      `No successful turn:end events with assistant messages found in trace ${traceId}`,
    );
  }

  const model = createTraceReplayModel(steps);
  const snapshot = stripPromptJournal(restoreSnapshot(events));
  return {
    model,
    snapshot,
    sequenceLength: steps.length,
    inputs: traceEventsToMockInputs(events),
  };
}
