/**
 * Zustand store: transient stream + `<Static>` history for the Ink CLI.
 */

import { create } from "zustand";
import type { TranscriptItem } from "../../services/session/sessionHistoryProjection";
import type { ToolCallHandle, ToolTranscriptDetail } from "../../shared/types";
import { StreamStableTailController } from "./streamStableTail";
import { drainToolOutput } from "./toolTailWindow";

const TRANSIENT_STREAM_CAP = 96_000;
/**
 * Lines kept per running tool. Only a handful are ever on screen; the slack lets
 * a quiet tool's rows be spent on a chatty one without losing its own backlog.
 */
const TOOL_TAIL_CAP = 32;
const STREAM_FLUSH_INTERVAL_MS = 50;
const TOOL_OUTPUT_FLUSH_INTERVAL_MS = 50;
export const TOOL_FULL_CAP = 96_000;

let turnIdCounter = 0;
let toolOrdinalCounter = 0;
let pendingStreamText = "";
let streamFlushTimer: ReturnType<typeof setTimeout> | undefined;
// Raw chunks per tool call id, drained on a timer. Chunks arrive far faster than
// the terminal can repaint, so batching here is what keeps a chatty command from
// melting the render loop.
const pendingToolOutput = new Map<string, string>();
let toolOutputFlushTimer: ReturnType<typeof setTimeout> | undefined;
const streamController = new StreamStableTailController();

export type ToolBlock = {
  id?: string;
  toolName: string;
  summary: string;
  args?: string;
  detail?: ToolTranscriptDetail;
  preview: string;
  fullResult: string;
  ok: boolean;
  ordinal?: number;
};

/** A tool call between `beginTool` and `logTool`, with whatever it has printed so far. */
export type RunningTool = {
  id: string;
  ordinal: number;
  summary: string;
  /** Complete output lines, oldest first, capped at {@link TOOL_TAIL_CAP}. */
  tail: string[];
  /** Raw unterminated remainder of the newest line. */
  partial: string;
  /** Complete lines seen in total, so a squeezed-out tool can still show progress. */
  lineCount: number;
};

/** Session header shown at the top of a fresh view (startup and after `/clear`). */
export type SessionBanner = {
  model: string;
  dir: string;
  version: string;
};

export type Turn =
  | { id: string; type: "user"; content: string }
  /** `oneLine`: a notice, truncated to a single row rather than wrapped. */
  | { id: string; type: "system"; content: string; oneLine?: boolean }
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
  runningTools: RunningTool[];
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
  beginTool: (start: { toolName: string; summary: string }) => ToolCallHandle;
  appendToolOutput: (toolCallId: string, chunk: string) => void;
  setStatus: (status: string) => void;
  logUser: (content: string) => void;
  logAssistant: (content: string) => void;
  logTool: (block: ToolBlock) => void;
  logDiff: (diff: DiffBlockDetail) => void;
  logSystem: (content: string, options?: { oneLine?: boolean }) => void;
  logBanner: (banner: SessionBanner) => void;
  clearStream: () => void;
  clearHistory: () => void;
  hydrateHistory: (items: readonly TranscriptItem[]) => void;
}

function transcriptTurn(item: TranscriptItem): Turn {
  switch (item.type) {
    case "user": {
      const actions = item.attachments?.map(
        (attachment) => `  -> ${attachment.action} ${attachment.label}`,
      );
      return {
        id: `resume_${item.id}`,
        type: "user",
        content: actions?.length ? `${item.content}\n${actions.join("\n")}` : item.content,
      };
    }
    case "assistant":
      return {
        id: `resume_${item.id}`,
        type: "assistant",
        content: item.content,
        hidden: false,
      };
    case "system":
      return { id: `resume_${item.id}`, type: "system", content: item.content };
    case "tool": {
      const compactArgs = item.arguments?.trim().replace(/\s+/g, " ");
      const suffix =
        compactArgs && compactArgs.length > 120 ? `${compactArgs.slice(0, 117)}...` : compactArgs;
      const summary = `[Tools] ${item.toolName}${suffix ? ` ${suffix}` : ""} (resumed)`;
      const fullResult = item.result ?? "";
      return {
        id: `resume_${item.id}`,
        type: "tool",
        content: summary,
        tool: {
          toolName: item.toolName,
          summary,
          args: item.arguments,
          preview: fullResult.split("\n").slice(0, 6).join("\n").slice(0, 600),
          fullResult,
          ok: item.ok,
        },
      };
    }
  }
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

function clearToolOutputFlushTimer(): void {
  if (toolOutputFlushTimer === undefined) {
    return;
  }
  clearTimeout(toolOutputFlushTimer);
  toolOutputFlushTimer = undefined;
}

function flushPendingToolOutput(): void {
  clearToolOutputFlushTimer();
  if (pendingToolOutput.size === 0) {
    return;
  }
  const drained = new Map<string, ReturnType<typeof drainToolOutput>>();
  for (const [id, buffer] of pendingToolOutput) {
    const result = drainToolOutput(buffer);
    drained.set(id, result);
    pendingToolOutput.set(id, result.rest);
  }

  useOutputStore.setState((state) => ({
    runningTools: state.runningTools.map((tool) => {
      const result = drained.get(tool.id);
      if (!result) {
        return tool;
      }
      const tail = [...tool.tail, ...result.lines];
      return {
        ...tool,
        tail: tail.length > TOOL_TAIL_CAP ? tail.slice(-TOOL_TAIL_CAP) : tail,
        partial: result.rest,
        lineCount: tool.lineCount + result.lines.length,
      };
    }),
  }));
}

function clearToolOutputState(): void {
  clearToolOutputFlushTimer();
  pendingToolOutput.clear();
}

function clearStreamState(): void {
  clearPendingStream();
  clearToolOutputState();
  streamController.reset();
}

export const useOutputStore = create<OutputState>((set) => ({
  streamBuffer: "",
  runningTools: [],
  status: "Ready",
  history: [],
  clearedStaticTurns: [],

  appendStream: (text) => {
    pendingStreamText += text;
    if (streamFlushTimer === undefined) {
      streamFlushTimer = setTimeout(flushPendingStream, STREAM_FLUSH_INTERVAL_MS);
    }
  },

  beginTool: ({ toolName, summary }) => {
    // Numbered here, when the call starts, so parallel tools read in the order
    // the model issued them rather than the order they happen to finish in.
    const handle: ToolCallHandle = {
      id: `tc_${toolName}_${++toolOrdinalCounter}`,
      ordinal: toolOrdinalCounter,
    };
    set((state) => ({
      runningTools: [
        ...state.runningTools,
        { id: handle.id, ordinal: handle.ordinal, summary, tail: [], partial: "", lineCount: 0 },
      ],
    }));
    return handle;
  },

  appendToolOutput: (toolCallId, chunk) => {
    if (chunk.length === 0) {
      return;
    }
    pendingToolOutput.set(toolCallId, (pendingToolOutput.get(toolCallId) ?? "") + chunk);
    if (toolOutputFlushTimer === undefined) {
      toolOutputFlushTimer = setTimeout(flushPendingToolOutput, TOOL_OUTPUT_FLUSH_INTERVAL_MS);
    }
  },

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
      runningTools: [],
      status: "Ready",
    }));
  },

  logTool: (block: ToolBlock) => {
    flushPendingStream();
    if (block.id !== undefined) {
      pendingToolOutput.delete(block.id);
    }
    set((state) => ({
      history: [
        ...state.history,
        {
          id: `t_${turnIdCounter++}`,
          type: "tool",
          content: block.summary,
          tool: {
            ...block,
            // Without a handle the host never numbered this call, so fall back to
            // the order blocks land in.
            ordinal:
              block.ordinal ??
              state.history.filter(
                (turn): turn is Extract<Turn, { type: "tool" }> => turn.type === "tool",
              ).length + 1,
          },
        },
      ],
      // The block replaces the live view, so this tool's rows leave the window
      // with it — a stale tail under a number that already scrolled past reads
      // as if the tool were still running.
      runningTools:
        block.id === undefined
          ? state.runningTools
          : state.runningTools.filter((tool) => tool.id !== block.id),
    }));
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

  logSystem: (content, options) => {
    // A system line is a notice, not a turn boundary. Most of them are emitted
    // while a tool is mid-flight — every `[Auto-allowed]` confirmation, `/mode`,
    // `/expand-tool` — so it must not retire the running tools or report the
    // agent idle. The real boundaries (logAssistant, clearStream, clearHistory)
    // still reset both.
    clearPendingStream();
    streamController.reset();
    set((state) => ({
      history: [
        ...state.history,
        { id: `s_${turnIdCounter++}`, type: "system", content, oneLine: options?.oneLine },
      ],
      streamBuffer: "",
    }));
  },

  clearStream: () => {
    clearStreamState();
    set({ streamBuffer: "", runningTools: [], status: "Ready" });
  },
  clearHistory: () => {
    // turnIdCounter keeps counting: ids must stay unique across clearedStaticTurns + history.
    // Ordinals do restart: `/expand-tool #N` only searches the live history, which is now empty.
    toolOrdinalCounter = 0;
    clearStreamState();
    set((state) => ({
      clearedStaticTurns: [...state.clearedStaticTurns, ...state.history],
      history: [],
      streamBuffer: "",
      runningTools: [],
      status: "Ready",
    }));
  },
  hydrateHistory: (items) => {
    clearStreamState();
    set((state) => ({
      history: [...state.history, ...items.map(transcriptTurn)],
      streamBuffer: "",
      runningTools: [],
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
  toolOrdinalCounter = 0;
  clearStreamState();
  useOutputStore.setState({
    streamBuffer: "",
    runningTools: [],
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
