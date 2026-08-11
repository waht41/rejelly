/**
 * Shared structured streaming: registers onStream before a model prompt (draft barrier).
 */

import { type AgentStreamEvent, onStream } from "@rejelly/core";
import { COMPACTION_STREAM_CHANNEL } from "../../domains/policy/compactionChannel";
import type { RuntimePhase } from "../../shared/conversation/presentationBindings";
import { getBinding } from "../../shared/host/context";

type StandardStreamingTextMode = "none" | "tool-preamble" | "plain";

export interface StandardStreamingOptions {
  /** Structured string field to stream from `structured_data` snapshots. */
  structuredKey?: string;
  /**
   * `tool-preamble`: print buffered raw text only for tool-call turns.
   * `plain`: print raw text deltas for non-structured agents.
   * `none`: never print raw text.
   */
  textMode?: StandardStreamingTextMode;
}

function normalizeStandardStreamingOptions(
  options: string | StandardStreamingOptions | undefined,
): Required<Pick<StandardStreamingOptions, "textMode">> &
  Pick<StandardStreamingOptions, "structuredKey"> {
  if (typeof options === "string") {
    return { structuredKey: options, textMode: "tool-preamble" };
  }
  if (options === undefined) {
    return { structuredKey: "reply", textMode: "tool-preamble" };
  }
  return {
    structuredKey: options.structuredKey,
    textMode: options.textMode ?? "tool-preamble",
  };
}

/** Where the current turn stands, for the events whose meaning depends on it. */
export interface StreamTurnProgress {
  /**
   * Whether the model has produced answer-shaped output yet. Separates leading reasoning, which
   * means it is still thinking, from a reasoning delta trailing the answer on interleaving models.
   */
  modelSpoke: boolean;
  /**
   * Whether `turn_done` has already arrived. It is the final event in the current engine contract;
   * retaining this guard also keeps late or externally supplied events from restarting the timer.
   */
  turnEnded: boolean;
}

/**
 * The phase an event moves the runtime to, or null to leave it where it is.
 *
 * Kept separate from the rendering loop below because the two disagree about side-turns: a named
 * channel's *output* must stay hidden (it is an internal handoff, not a reply), while its *wait* is
 * as real as any other — compaction is a full model round trip behind an otherwise empty screen.
 */
export function phaseForStreamEvent(
  event: Pick<AgentStreamEvent, "type" | "channel"> & { delta?: string; data?: unknown },
  { modelSpoke, turnEnded }: StreamTurnProgress,
): RuntimePhase | null {
  if (event.channel !== undefined) {
    // Only the channel we can name gets a label; an unrecognized side-turn belongs to some future
    // feature, and guessing "compacting" for it would be a wrong answer rather than a missing one.
    if (event.channel !== COMPACTION_STREAM_CHANNEL) {
      return null;
    }
    if (event.type === "turn_start") {
      return "compacting";
    }
    return event.type === "turn_done" ? "working" : null;
  }

  switch (event.type) {
    case "turn_start":
      // Spans the request until the model's first event, so a stalled connection reads as a
      // climbing counter instead of a frozen screen.
      return "connecting";
    case "reasoning":
      return modelSpoke ? null : "thinking";
    case "text":
      if (event.delta === undefined || event.delta.length === 0) {
        return null;
      }
      return turnEnded ? null : "streaming";
    case "structured_data":
      // A snapshot that carries no value (empty/initial parse state) is not output yet:
      // flipping to "streaming" on it would cut "thinking" short before the model spoke.
      if (
        turnEnded ||
        event.data === undefined ||
        event.data === null ||
        (typeof event.data === "object" && Object.keys(event.data as object).length === 0)
      ) {
        return null;
      }
      return "streaming";
    case "tool_call_stream":
      return turnEnded ? null : "streaming";
    case "turn_done":
      // Whatever comes next (tools, another turn, the reply) owns the phase from here; left on
      // "streaming" the counter would keep running against a turn that already ended.
      return "working";
    default:
      return null;
  }
}

/**
 * Stream structured field deltas when available. Raw text handling is controlled by
 * `textMode`; the default preserves the structured-agent behavior by buffering raw text
 * and only printing it as a tool-call preamble.
 * Call once per turn, immediately before promptAgent()/promptChat().
 */
export function useStandardStreaming(options?: string | StandardStreamingOptions): void {
  const { printOut, onPhaseUpdate, logToolRound } = getBinding();
  const { structuredKey, textMode } = normalizeStandardStreamingOptions(options);
  onStream(async (stream) => {
    // Mirrored locally so the per-delta calls below collapse to nothing: text events arrive
    // dozens of times a second and each host hop would otherwise touch the UI store.
    let phase: RuntimePhase | null = null;
    const enterPhase = (next: RuntimePhase) => {
      if (phase === next) {
        return;
      }
      phase = next;
      onPhaseUpdate?.(next);
    };

    let lastStructuredValue = "";
    let textBuffer = "";
    let structuredThisTurn = false;
    let streamedThisTurn = false;
    let turnEnded = false;
    let toolRequested = false;
    /**
     * Distinct tool calls requested this turn, keyed by the adapter's chunk index because a
     * single call streams as many chunks. Counting the chunks lets the UI know the batch size as
     * early as possible; the assembled `tool_call` events also arrive before `turn_done` now.
     * An adapter that omits the index collapses to one entry, which degrades to no header rather
     * than a wrong one.
     */
    const toolCallIndexes = new Set<number>();
    /** Whether the model has produced answer-shaped output yet, for reasoning/streaming ordering. */
    let modelSpoke = false;

    const resetTurn = () => {
      lastStructuredValue = "";
      textBuffer = "";
      structuredThisTurn = false;
      streamedThisTurn = false;
      turnEnded = false;
      toolRequested = false;
      toolCallIndexes.clear();
      modelSpoke = false;
    };

    const appendStructuredSnapshot = (value: string): boolean => {
      structuredThisTurn = true;
      if (value === lastStructuredValue) {
        return false;
      }

      if (value.startsWith(lastStructuredValue)) {
        printOut(value.slice(lastStructuredValue.length));
      } else {
        printOut(value);
      }
      lastStructuredValue = value;
      streamedThisTurn = true;
      return true;
    };

    for await (const event of stream) {
      // Phase first, and for every channel: the rendering below deliberately drops side-turns,
      // but their wait still belongs on the status line.
      const nextPhase = phaseForStreamEvent(event, { modelSpoke, turnEnded });
      if (nextPhase !== null) {
        modelSpoke ||= nextPhase === "streaming";
        enterPhase(nextPhase);
      }

      // Named-channel events come from internal side-turns (e.g. the compaction summarization
      // call), not the conversation - rendering them would present internal handoff text as the
      // agent's reply. Only the main (channel-less) stream is user-facing output.
      if (event.channel !== undefined) {
        continue;
      }
      switch (event.type) {
        case "turn_start":
          resetTurn();
          break;

        case "text":
          if (event.delta.length > 0) {
            textBuffer += event.delta;
            if (textMode === "plain" && structuredKey === undefined) {
              printOut(event.delta);
              streamedThisTurn = true;
            }
          }
          break;

        case "structured_data": {
          if (structuredKey === undefined) {
            break;
          }
          const data =
            event.data && typeof event.data === "object"
              ? (event.data as Record<string, unknown>)
              : undefined;
          const cur = data?.[structuredKey];
          if (typeof cur !== "string") {
            break;
          }
          if (appendStructuredSnapshot(cur) && turnEnded) {
            printOut("\n");
          }
          break;
        }

        case "tool_call_stream":
          toolRequested = true;
          toolCallIndexes.add(event.chunk.index);
          break;

        case "turn_done":
          if (textMode === "tool-preamble" && toolRequested) {
            const preamble = textBuffer.trim();
            if (!structuredThisTurn && preamble.length > 0) {
              printOut(`${preamble}\n`);
              streamedThisTurn = true;
            }
          }
          if (streamedThisTurn) {
            printOut("\n");
          }
          // After the text, before the tools: the batch is announced where it was decided, so
          // the confirmations and blocks that follow read as belonging to it.
          if (toolCallIndexes.size > 1) {
            logToolRound?.(toolCallIndexes.size);
          }
          turnEnded = true;
          break;
      }
    }
  });
}
