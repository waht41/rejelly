/**
 * Zustand store: transient stream + `<Static>` history for the Ink CLI.
 */

import { create } from "zustand";
import type { TranscriptItem } from "../../shared/session/transcript";
import type {
  ToolCallHandle,
  ToolObservationDetail,
  ToolObservationStart,
} from "../../shared/tool-observation/model";
import type { RuntimePhase } from "../../shared/types";
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
  detail?: ToolObservationDetail;
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
  /**
   * Heads the tool blocks one model call issued together. Only written for two or more:
   * a single block is trivially its own batch, so a header on every call would be noise,
   * and the rule stays unambiguous — a block with no header above it is a batch of one.
   */
  | { id: string; type: "tool_round"; calls: number }
  | { id: string; type: "tool"; content: string; tool: ToolBlock }
  | { id: string; type: "diff"; diff: DiffBlockDetail }
  | { id: string; type: "banner"; banner: SessionBanner };

/** Reviewed diff committed to scrollback history (so the user can scroll back to it later). */
export type DiffBlockDetail = {
  text: string;
  caption?: string;
  captionTitle?: string;
};

/** The status-line slice: what the runtime is doing, its stall anchor, and the turn timer. */
interface RuntimeStatus {
  /** Free-text detail for the status line (e.g. `shell → workspace root`). Display only. */
  detail: string;
  /** What the runtime is doing; owns the idle/active decision and the status-line label. */
  phase: RuntimePhase;
  /** Epoch ms of the last actual phase change — the stall check counts from here. */
  phaseSince: number;
  /**
   * Epoch ms when the current turn's initial user input was recorded (anchored by beginTurn),
   * or null between turns. Counts the whole turn: it survives phase changes, mid-turn steers,
   * and the `awaiting_user` pauses of tool confirmations, and only a turn boundary
   * (logAssistant / clear / reset) returns it to null. This is the number the status line displays.
   */
  turnStartedAt: number | null;
  /**
   * Epoch ms of the last model output flushed to the stream, for the streaming-stall check.
   * The stream flush refreshes it; a long answer keeps it current, silence does not.
   */
  lastOutputAt: number;
}

interface OutputState {
  streamBuffer: string;
  runningTools: RunningTool[];
  runtime: RuntimeStatus;
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
  beginTool: (start: ToolObservationStart) => ToolCallHandle;
  appendToolOutput: (toolCallId: string, chunk: string) => void;
  setDetail: (detail: string) => void;
  /** Move to `phase`, optionally updating the detail in the same commit. */
  setPhase: (phase: RuntimePhase, detail?: string) => void;
  /** Anchor the turn timer at an initial user input; steers and maintenance commands never call it. */
  beginTurn: () => void;
  /** After a mid-turn user pause (confirmation), resume the phase that fits: tools running → "tool", else "working". */
  resumeWork: (detail?: string) => void;
  logUser: (content: string) => void;
  logAssistant: (content: string) => void;
  /** Head the batch a single model call issued; callers filter out single-call rounds. */
  logToolRound: (calls: number) => void;
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
    case "tool_round":
      return { id: `resume_${item.id}`, type: "tool_round", calls: item.calls };
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
    runtime: { ...state.runtime, lastOutputAt: Date.now() },
  }));
}

/**
 * Everything the stream still holds, ready to be committed: the batched deltas first (so their
 * stable part reaches history in order), then the source the markdown holdback has not released.
 * Leaves the controller reset, so text arriving after the interruption starts a fresh fragment.
 */
function takeStreamTail(): string {
  flushPendingStream();
  return streamController.drain();
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

/** The runtime slice every turn boundary returns to: nothing in flight, timer restarted. */
function idleRuntime(): RuntimeStatus {
  return {
    detail: "Ready",
    phase: "idle",
    phaseSince: Date.now(),
    turnStartedAt: null,
    lastOutputAt: Date.now(),
  };
}

/** `12345ms` → `12.3s`, `92345ms` → `1m 32s`. */
function formatTurnDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

/** Phases where the runtime is parked on the user: no turn in flight, nothing to time. */
function isInactivePhase(phase: RuntimePhase): boolean {
  return phase === "idle" || phase === "awaiting_user";
}

export const useOutputStore = create<OutputState>((set) => ({
  streamBuffer: "",
  runningTools: [],
  runtime: idleRuntime(),
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
    set((state) => {
      const patch: Partial<OutputState> = {
        runningTools: [
          ...state.runningTools,
          { id: handle.id, ordinal: handle.ordinal, summary, tail: [], partial: "", lineCount: 0 },
        ],
      };
      const runtimePatch: Partial<RuntimeStatus> = {};
      if (state.runtime.phase !== "tool") {
        // The first concurrent call owns the timer; later ones join the same phase,
        // so the counter measures the whole batch rather than restarting per tool.
        runtimePatch.phase = "tool";
        runtimePatch.phaseSince = Date.now();
      }
      if (Object.keys(runtimePatch).length > 0) {
        patch.runtime = { ...state.runtime, ...runtimePatch };
      }
      return patch;
    });
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

  setDetail: (detail) => set((state) => ({ runtime: { ...state.runtime, detail } })),

  /** Anchor the turn timer; idempotent until a turn boundary resets it. */
  beginTurn: () =>
    set((state) =>
      state.runtime.turnStartedAt === null
        ? { runtime: { ...state.runtime, turnStartedAt: Date.now() } }
        : {},
    ),

  /**
   * After a confirmation the agent goes back to work; the label must match the state — a tool
   * batch still draining is "Running tools", not a generic "Working" (the previous code always
   * said "working", so confirmed tools never showed their own phase).
   */
  resumeWork: (detail) =>
    set((state) => ({
      runtime: {
        ...state.runtime,
        phase: state.runningTools.length > 0 ? "tool" : "working",
        phaseSince: Date.now(),
        ...(detail === undefined ? {} : { detail }),
      },
    })),

  setPhase: (phase, detail) =>
    set((state) => {
      // Stream deltas arrive far faster than the phase changes, so a no-op must stay a no-op:
      // restarting phaseSince here would peg the per-phase stall check at 0s.
      if (phase === state.runtime.phase) {
        return detail === undefined || detail === state.runtime.detail
          ? {}
          : { runtime: { ...state.runtime, detail } };
      }
      const runtimePatch: Partial<RuntimeStatus> = { phase, phaseSince: Date.now() };
      if (detail !== undefined) {
        runtimePatch.detail = detail;
      }
      // The turn timer is anchored only by beginTurn (the shell's initial-input record point);
      // phase transitions never start or restart it — steers and maintenance commands must not
      // move the turn boundary.
      return { runtime: { ...state.runtime, ...runtimePatch } };
    }),

  logUser: (content) =>
    set((state) => ({
      history: [...state.history, { id: `u_${turnIdCounter++}`, type: "user", content }],
    })),

  logAssistant: (content) => {
    flushPendingStream();
    const { visualRemainder, shouldHideFinal } = streamController.finalize(content);
    set((state) => {
      const duration =
        state.runtime.turnStartedAt === null
          ? null
          : Math.max(0, Date.now() - state.runtime.turnStartedAt);
      // The reply's rows, in order: the streamed remainder (when the final text duplicated
      // it), the assistant turn itself, and the one-line timing notice.
      const turns: Turn[] = [];
      if (shouldHideFinal && visualRemainder.length > 0) {
        turns.push({
          id: `as_${turnIdCounter++}`,
          type: "assistant_stream",
          content: visualRemainder,
          final: true,
        });
      }
      turns.push({
        id: `a_${turnIdCounter++}`,
        type: "assistant",
        content,
        hidden: shouldHideFinal,
      });
      if (duration !== null) {
        // One dim line after the reply: how long the agent worked, so a slow run
        // leaves evidence in scrollback even after the status line resets. Skipped
        // when no turn actually ran (e.g. resumed/hydrated sessions).
        turns.push({
          id: `s_${turnIdCounter++}`,
          type: "system",
          content: `Worked for ${formatTurnDuration(duration)}`,
          oneLine: true,
        });
      }
      return {
        history: [...state.history, ...turns],
        streamBuffer: "",
        runningTools: [],
        runtime: idleRuntime(),
      };
    });
  },

  logToolRound: (calls) => {
    // Same commit-before-interrupting rule as logSystem: the text that introduced this batch
    // is still the transient tail, and it was written before the header.
    const tail = takeStreamTail();
    set((state) => ({
      history: [
        ...state.history,
        ...(tail.length > 0
          ? [{ id: `as_${turnIdCounter++}`, type: "assistant_stream" as const, content: tail }]
          : []),
        { id: `tr_${turnIdCounter++}`, type: "tool_round" as const, calls },
      ],
      streamBuffer: "",
    }));
  },

  logTool: (block: ToolBlock) => {
    flushPendingStream();
    if (block.id !== undefined) {
      pendingToolOutput.delete(block.id);
    }
    set((state) => {
      // The block replaces the live view, so this tool's rows leave the window
      // with it — a stale tail under a number that already scrolled past reads
      // as if the tool were still running.
      const runningTools =
        block.id === undefined
          ? state.runningTools
          : state.runningTools.filter((tool) => tool.id !== block.id);
      const patch: Partial<OutputState> = {
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
        runningTools,
      };
      if (state.runtime.phase === "tool" && runningTools.length === 0) {
        // With the batch drained the agent is on its way back to the model; holding
        // "Running tools" here would keep counting against a tool that already ended.
        patch.runtime = {
          ...state.runtime,
          phase: "working",
          phaseSince: Date.now(),
        };
      }
      return patch;
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

  logSystem: (content, options) => {
    // A system line is a notice, not a turn boundary. Most of them are emitted
    // while a tool is mid-flight — every `[Auto-allowed]` confirmation, `/mode`,
    // `/expand-tool` — so it must not retire the running tools or report the
    // agent idle. The real boundaries (logAssistant, clearStream, clearHistory)
    // still reset both.
    //
    // The stream it interrupts must be committed rather than dropped: text the model
    // wrote before calling a tool is on screen only as the transient tail, and the
    // markdown holdback keeps a whole trailing list or table there — which is the shape
    // "here is what I am about to do" output takes. Discarding it here erased that
    // reasoning from the transcript at every auto-allowed call.
    const tail = takeStreamTail();
    set((state) => ({
      history: [
        ...state.history,
        // Ahead of the notice: this text was written before whatever the notice reports.
        ...(tail.length > 0
          ? [
              {
                id: `as_${turnIdCounter++}`,
                type: "assistant_stream" as const,
                content: tail,
              },
            ]
          : []),
        { id: `s_${turnIdCounter++}`, type: "system" as const, content, oneLine: options?.oneLine },
      ],
      streamBuffer: "",
    }));
  },

  clearStream: () => {
    clearStreamState();
    set({ streamBuffer: "", runningTools: [], runtime: idleRuntime() });
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
      runtime: idleRuntime(),
    }));
  },
  hydrateHistory: (items) => {
    clearStreamState();
    set((state) => ({
      history: [...state.history, ...items.map(transcriptTurn)],
      streamBuffer: "",
      runningTools: [],
      runtime: idleRuntime(),
    }));
  },
}));

/**
 * Whether the runtime is mid-flight, i.e. whether the transient surface and the interrupt hint
 * belong on screen. Reads the phase, not the detail text: this used to sniff the status string for
 * a `"Waiting for "` prefix, which made every new status a chance to silently report the agent idle.
 */
export function isRuntimeActive(phase: RuntimePhase, streamBuffer: string): boolean {
  if (streamBuffer.length > 0) {
    return true;
  }
  return !isInactivePhase(phase);
}

/**
 * The epoch ms the status line counts from: the whole turn when one is running, otherwise the
 * current phase.
 *
 * `turnStartedAt` is anchored only by the shell's initial-input point, which maintenance commands
 * deliberately skip — but `/compress` still runs a model call the user sits and waits on, and with
 * no anchor the line read `Compacting context 0s` for the entire operation. A dead counter is worse
 * than a coarse one: the number exists precisely so a stalled round trip is visible. Falling back to
 * `phaseSince` times the phase instead, which is the honest unit when there is no turn to time, and
 * keeps this read-only — an anchor written here would leak into the next real turn, whose
 * `beginTurn` is idempotent and would not re-anchor.
 */
export function statusTimerAnchor(turnStartedAt: number | null, phaseSince: number): number {
  return turnStartedAt ?? phaseSince;
}

/** Clear history/stream for a new CLI session (singleton store). */
export function resetOutputSession(): void {
  turnIdCounter = 0;
  toolOrdinalCounter = 0;
  clearStreamState();
  useOutputStore.setState({
    streamBuffer: "",
    runningTools: [],
    runtime: idleRuntime(),
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
