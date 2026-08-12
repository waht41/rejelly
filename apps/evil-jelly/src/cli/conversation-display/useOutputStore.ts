/** Conversation display projection: transient stream + `<Static>` history for the Ink CLI. */

import { create } from "zustand";
import type { RuntimePhase } from "../../shared/host/presentationBindings";
import type { TranscriptItem } from "../../shared/session/transcript";
import type { ToolCallHandle, ToolObservationStart } from "../../shared/tool-observation/model";
import { AssistantStreamBuffer } from "./assistant-stream/buffer";
import {
  assistantCompletionTurns,
  assistantStreamTurn,
  bannerTurn,
  diffTurn,
  systemTurn,
  toolRoundTurn,
  toolTurn,
  userTurn,
} from "./history/entries";
import type { DiffBlockDetail, SessionBanner, ToolBlock, Turn } from "./history/model";
import { projectTranscriptHistory } from "./history/projection";
import { HistorySequence } from "./history/sequence";
import { RunningToolOutputBuffer } from "./running-tools/outputBuffer";
import {
  applyRunningToolOutput,
  finishRunningTool,
  type RunningToolsState,
  startRunningTool,
} from "./running-tools/state";
import {
  beginRuntimeTurn,
  finishRuntimeToolBatch,
  idleRuntime,
  type RuntimeStatusState,
  recordRuntimeOutput,
  resumeRuntimeWork,
  transitionRuntimePhase,
  withRuntimeDetail,
} from "./runtime-status/state";

export const TOOL_FULL_CAP = 96_000;

const historySequence = new HistorySequence();
const assistantStream = new AssistantStreamBuffer(({ stableText, tailText }) => {
  useOutputStore.setState((state) => ({
    history:
      stableText.length === 0
        ? state.history
        : [...state.history, assistantStreamTurn(historySequence, stableText)],
    streamBuffer: tailText,
    runtime: recordRuntimeOutput(state.runtime),
  }));
});

interface OutputState extends RunningToolsState, RuntimeStatusState {
  streamBuffer: string;
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
const runningToolOutput = new RunningToolOutputBuffer((drained) => {
  useOutputStore.setState((state) => ({
    runningTools: applyRunningToolOutput(state.runningTools, drained),
  }));
});

function clearStreamState(): void {
  assistantStream.reset();
  runningToolOutput.reset();
}

export const useOutputStore = create<OutputState>((set) => ({
  streamBuffer: "",
  runningTools: [],
  runtime: idleRuntime(),
  history: [],
  clearedStaticTurns: [],

  appendStream: (text) => {
    assistantStream.append(text);
  },

  beginTool: ({ toolName, summary }) => {
    // Numbered here, when the call starts, so parallel tools read in the order
    // the model issued them rather than the order they happen to finish in.
    const ordinal = historySequence.nextToolOrdinal();
    const handle: ToolCallHandle = {
      id: `tc_${toolName}_${ordinal}`,
      ordinal,
    };
    set((state) => {
      const patch: Partial<OutputState> = {
        runningTools: startRunningTool(state.runningTools, handle, summary),
      };
      if (state.runtime.phase !== "tool") {
        // The first concurrent call owns the timer; later ones join the same phase,
        // so the counter measures the whole batch rather than restarting per tool.
        patch.runtime = transitionRuntimePhase(state.runtime, "tool");
      }
      return patch;
    });
    return handle;
  },

  appendToolOutput: (toolCallId, chunk) => {
    runningToolOutput.append(toolCallId, chunk);
  },

  setDetail: (detail) => set((state) => ({ runtime: withRuntimeDetail(state.runtime, detail) })),

  /** Anchor the turn timer; idempotent until a turn boundary resets it. */
  beginTurn: () =>
    set((state) => {
      const runtime = beginRuntimeTurn(state.runtime);
      return runtime === state.runtime ? {} : { runtime };
    }),

  /**
   * After a confirmation the agent goes back to work; the label must match the state — a tool
   * batch still draining is "Running tools", not a generic "Working" (the previous code always
   * said "working", so confirmed tools never showed their own phase).
   */
  resumeWork: (detail) =>
    set((state) => ({
      runtime: resumeRuntimeWork(state.runtime, state.runningTools.length > 0, detail),
    })),

  setPhase: (phase, detail) =>
    set((state) => {
      // Stream deltas arrive far faster than the phase changes, so a no-op must stay a no-op:
      // restarting phaseSince here would peg the per-phase stall check at 0s.
      // The turn timer is anchored only by beginTurn (the shell's initial-input record point);
      // phase transitions never start or restart it — steers and maintenance commands must not
      // move the turn boundary.
      const runtime = transitionRuntimePhase(state.runtime, phase, detail);
      return runtime === state.runtime ? {} : { runtime };
    }),

  logUser: (content) =>
    set((state) => ({
      history: [...state.history, userTurn(historySequence, content)],
    })),

  logAssistant: (content) => {
    const { visualRemainder, shouldHideFinal } = assistantStream.finalize(content);
    set((state) => {
      const duration =
        state.runtime.turnStartedAt === null
          ? null
          : Math.max(0, Date.now() - state.runtime.turnStartedAt);
      const turns = assistantCompletionTurns(historySequence, {
        content,
        visualRemainder,
        shouldHideFinal,
        durationMs: duration,
      });
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
    const tail = assistantStream.drain();
    set((state) => ({
      history: [
        ...state.history,
        ...(tail.length > 0 ? [assistantStreamTurn(historySequence, tail)] : []),
        toolRoundTurn(historySequence, calls),
      ],
      streamBuffer: "",
    }));
  },

  logTool: (block: ToolBlock) => {
    assistantStream.flush();
    if (block.id !== undefined) {
      runningToolOutput.discard(block.id);
    }
    set((state) => {
      // The block replaces the live view, so this tool's rows leave the window
      // with it — a stale tail under a number that already scrolled past reads
      // as if the tool were still running.
      const runningTools = finishRunningTool(state.runningTools, block.id);
      const patch: Partial<OutputState> = {
        history: [
          ...state.history,
          toolTurn(
            historySequence,
            block,
            // Without a handle the host never numbered this call, so fall back to
            // the order blocks land in.
            state.history.filter((turn) => turn.type === "tool").length + 1,
          ),
        ],
        runningTools,
      };
      const runtime = finishRuntimeToolBatch(state.runtime, runningTools.length > 0);
      if (runtime !== state.runtime) {
        // With the batch drained the agent is on its way back to the model; holding
        // "Running tools" here would keep counting against a tool that already ended.
        patch.runtime = runtime;
      }
      return patch;
    });
  },

  logDiff: (diff) => {
    assistantStream.flush();
    set((state) => ({
      history: [...state.history, diffTurn(historySequence, diff)],
    }));
  },

  logBanner: (banner) =>
    set((state) => ({
      history: [...state.history, bannerTurn(historySequence, banner)],
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
    const tail = assistantStream.drain();
    set((state) => ({
      history: [
        ...state.history,
        // Ahead of the notice: this text was written before whatever the notice reports.
        ...(tail.length > 0 ? [assistantStreamTurn(historySequence, tail)] : []),
        systemTurn(historySequence, content, options?.oneLine),
      ],
      streamBuffer: "",
    }));
  },

  clearStream: () => {
    clearStreamState();
    set({ streamBuffer: "", runningTools: [], runtime: idleRuntime() });
  },
  clearHistory: () => {
    // Turn ids keep counting: they must stay unique across clearedStaticTurns + history.
    // Ordinals do restart: `/expand-tool #N` only searches the live history, which is now empty.
    historySequence.resetToolOrdinals();
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
      history: [...state.history, ...projectTranscriptHistory(items)],
      streamBuffer: "",
      runningTools: [],
      runtime: idleRuntime(),
    }));
  },
}));

/** Clear history/stream for a new CLI session (singleton store). */
export function resetOutputSession(): void {
  historySequence.reset();
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
