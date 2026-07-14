/**
 * Shared structured streaming: registers onStream before a model prompt (draft barrier).
 */

import { onStream } from "@rejelly/core";
import { getBinding } from "./hostBindings";

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

/**
 * Stream structured field deltas when available. Raw text handling is controlled by
 * `textMode`; the default preserves the structured-agent behavior by buffering raw text
 * and only printing it as a tool-call preamble.
 * Call once per turn, immediately before promptAgent()/promptChat().
 */
export function useStandardStreaming(options?: string | StandardStreamingOptions): void {
  const { printOut } = getBinding();
  const { structuredKey, textMode } = normalizeStandardStreamingOptions(options);
  onStream(async (stream) => {
    let lastStructuredValue = "";
    let textBuffer = "";
    let structuredThisTurn = false;
    let streamedThisTurn = false;
    let turnEnded = false;
    let toolRequested = false;

    const resetTurn = () => {
      lastStructuredValue = "";
      textBuffer = "";
      structuredThisTurn = false;
      streamedThisTurn = false;
      turnEnded = false;
      toolRequested = false;
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
          turnEnded = true;
          break;
      }
    }
  });
}
