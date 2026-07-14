/**
 * Zustand store: transient stream + `<Static>` history for the Ink CLI.
 */

import { create } from "zustand";
import { normalizeNewlines } from "../../shared/lib/string";
import type { ToolTranscriptDetail } from "../../shared/types";
import { StreamStableTailController } from "./streamStableTail";

const TRANSIENT_STREAM_CAP = 96_000;
const TRANSIENT_TOOL_PROGRESS_CAP = 100;
const STREAM_FLUSH_INTERVAL_MS = 50;
export const TOOL_FULL_CAP = 96_000;

let turnIdCounter = 0;
let pendingStreamText = "";
let streamFlushTimer: ReturnType<typeof setTimeout> | undefined;
const streamController = new StreamStableTailController();

export type ToolBlock = {
  toolName: string;
  summary: string;
  args?: string;
  detail?: ToolTranscriptDetail;
  preview: string;
  fullResult: string;
  ok: boolean;
  ordinal?: number;
};

/** Session header shown at the top of a fresh view (startup and after `/clear`). */
export type SessionBanner = {
  model: string;
  dir: string;
  version: string;
};

export type Turn =
  | { id: string; type: "user" | "system"; content: string }
  | { id: string; type: "assistant"; content: string; hidden?: boolean }
  | { id: string; type: "assistant_stream"; content: string; final?: boolean }
  | { id: string; type: "tool"; content: string; tool: ToolBlock }
  | { id: string; type: "diff"; diff: DiffBlockDetail }
  | { id: string; type: "banner"; banner: SessionBanner };

/** Reviewed diff committed to scrollback history (so the user can scroll back to it later). */
export type DiffBlockDetail = {
  text: string;
  caption?: string;
  captionTitle?: string;
};

interface OutputState {
  streamBuffer: string;
  toolProgress: string[];
  status: string;
  history: Turn[];
  /**
   * Turns wiped by `/clear`, kept as a frozen prefix for the Dashboard `<Static>` items.
   * Ink's `<Static>` counts already-flushed items in instance state, so its items array must
   * never shrink while mounted: shrink+repopulate in one batched render leaves that count past
   * the new items and they are silently swallowed. The screen wipe itself is `clearScreen`'s
   * job; this prefix only keeps the flushed-count bookkeeping consistent.
   */
  clearedStaticTurns: Turn[];

  appendStream: (text: string) => void;
  appendToolProgress: (text: string) => void;
  setStatus: (status: string) => void;
  logUser: (content: string) => void;
  logAssistant: (content: string) => void;
  logTool: (block: ToolBlock) => void;
  logDiff: (diff: DiffBlockDetail) => void;
  logSystem: (content: string) => void;
  logBanner: (banner: SessionBanner) => void;
  clearStream: () => void;
  clearHistory: () => void;
}

function capTransientStream(value: string): string {
  if (value.length <= TRANSIENT_STREAM_CAP) {
    return value;
  }
  return value.slice(-TRANSIENT_STREAM_CAP);
}

function clearStreamFlushTimer(): void {
  if (streamFlushTimer === undefined) {
    return;
  }
  clearTimeout(streamFlushTimer);
  streamFlushTimer = undefined;
}

function clearPendingStream(): void {
  pendingStreamText = "";
  clearStreamFlushTimer();
}

function flushPendingStream(): void {
  if (pendingStreamText.length === 0) {
    clearStreamFlushTimer();
    return;
  }
  const text = pendingStreamText;
  pendingStreamText = "";
  clearStreamFlushTimer();
  const { stableText, tailText } = streamController.push(text);
  useOutputStore.setState((state) => ({
    history:
      stableText.length === 0
        ? state.history
        : [
            ...state.history,
            { id: `as_${turnIdCounter++}`, type: "assistant_stream", content: stableText },
          ],
    streamBuffer: capTransientStream(tailText),
  }));
}

function clearStreamState(): void {
  clearPendingStream();
  streamController.reset();
}

export const useOutputStore = create<OutputState>((set) => ({
  streamBuffer: "",
  toolProgress: [],
  status: "Ready",
  history: [],
  clearedStaticTurns: [],

  appendStream: (text) => {
    pendingStreamText += text;
    if (streamFlushTimer === undefined) {
      streamFlushTimer = setTimeout(flushPendingStream, STREAM_FLUSH_INTERVAL_MS);
    }
  },

  appendToolProgress: (text) =>
    set((state) => {
      const lines = normalizeNewlines(text)
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);
      if (lines.length === 0) {
        return { toolProgress: state.toolProgress };
      }
      return {
        toolProgress: [...state.toolProgress, ...lines].slice(-TRANSIENT_TOOL_PROGRESS_CAP),
      };
    }),

  setStatus: (status) => set({ status }),

  logUser: (content) =>
    set((state) => ({
      history: [...state.history, { id: `u_${turnIdCounter++}`, type: "user", content }],
    })),

  logAssistant: (content) => {
    flushPendingStream();
    const { visualRemainder, shouldHideFinal } = streamController.finalize(content);
    set((state) => ({
      history: [
        ...state.history,
        ...(shouldHideFinal && visualRemainder.length > 0
          ? [
              {
                id: `as_${turnIdCounter++}`,
                type: "assistant_stream" as const,
                content: visualRemainder,
                final: true,
              },
            ]
          : []),
        {
          id: `a_${turnIdCounter++}`,
          type: "assistant",
          content,
          hidden: shouldHideFinal,
        },
      ],
      streamBuffer: "",
      toolProgress: [],
      status: "Ready",
    }));
  },

  logTool: (block: ToolBlock) => {
    flushPendingStream();
    set((state) => {
      const progressIndex = state.toolProgress.indexOf(block.summary);
      const toolProgress =
        progressIndex === -1
          ? state.toolProgress
          : [
              ...state.toolProgress.slice(0, progressIndex),
              ...state.toolProgress.slice(progressIndex + 1),
            ];
      return {
        history: [
          ...state.history,
          {
            id: `t_${turnIdCounter++}`,
            type: "tool",
            content: block.summary,
            tool: {
              ...block,
              ordinal:
                block.ordinal ??
                state.history.filter(
                  (turn): turn is Extract<Turn, { type: "tool" }> => turn.type === "tool",
                ).length + 1,
            },
          },
        ],
        toolProgress,
      };
    });
  },

  logDiff: (diff) => {
    flushPendingStream();
    set((state) => ({
      history: [...state.history, { id: `d_${turnIdCounter++}`, type: "diff", diff }],
    }));
  },

  logBanner: (banner) =>
    set((state) => ({
      history: [...state.history, { id: `b_${turnIdCounter++}`, type: "banner", banner }],
    })),

  logSystem: (content) => {
    clearStreamState();
    set((state) => ({
      history: [...state.history, { id: `s_${turnIdCounter++}`, type: "system", content }],
      streamBuffer: "",
      toolProgress: [],
      status: "Ready",
    }));
  },

  clearStream: () => {
    clearStreamState();
    set({ streamBuffer: "", toolProgress: [], status: "Ready" });
  },
  clearHistory: () => {
    // turnIdCounter keeps counting: ids must stay unique across clearedStaticTurns + history.
    clearStreamState();
    set((state) => ({
      clearedStaticTurns: [...state.clearedStaticTurns, ...state.history],
      history: [],
      streamBuffer: "",
      toolProgress: [],
      status: "Ready",
    }));
  },
}));

export function isRuntimeActive(status: string, streamBuffer: string): boolean {
  if (streamBuffer.length > 0) {
    return true;
  }
  if (status === "Ready" || status === "Waiting for input") {
    return false;
  }
  return !status.startsWith("Waiting for ");
}

/** Clear history/stream for a new CLI session (singleton store). */
export function resetOutputSession(): void {
  turnIdCounter = 0;
  clearStreamState();
  useOutputStore.setState({
    streamBuffer: "",
    toolProgress: [],
    status: "Ready",
    history: [],
    clearedStaticTurns: [],
  });
}

/**
 * Drop the cleared-turns prefix. Only safe while Ink is unmounted (e.g. before remounting
 * after an external editor): a fresh `<Static>` starts its flushed count at 0, so the prefix
 * would otherwise be re-emitted — and while mounted, shrinking the items array swallows
 * whatever the stale count now points past.
 */
export function pruneClearedStaticTurns(): void {
  useOutputStore.setState({ clearedStaticTurns: [] });
}
