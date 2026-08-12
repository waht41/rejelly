import { type Instance, render } from "ink";
import React from "react";
import { hasActiveInterruptibleTask } from "../../shared/task-interruption/taskStack";
import { createInteractiveCommandHandler } from "../app/orchestration/interactiveCommands";
import { usePromptStore } from "../message-composer/session/composerStore";
import { requestRunAbort } from "../runtime/runControl";
import { pruneClearedStaticTurns, useOutputStore } from "../store/useOutputStore";
import { useViewStore } from "../store/useViewStore";
import { applyModeCommand, MODE_META, useModeStore } from "../tool-approval/approvalModeStore";
import { Dashboard } from "../ui/Dashboard";
import type { CtrlCAbortHandler } from "../ui/useCtrlCAbort";
import { saveClipboardImage } from "./clipboard/clipboardImage";
import { copyTextToClipboard } from "./clipboard/clipboardText";
import { failPendingLineInput } from "./lineInputQueue";
import { restoreSteersToPrompt } from "./restoreSteersToPrompt";
import { installWindowsVirtualTerminalInputPatch } from "./windowsVtInput";

/** Exit Ink raw mode so an external TUI (vim, etc.) can own the terminal. Best-effort. */
function releaseStdinRawMode(): void {
  const s = process.stdin;
  if (!s.isTTY || typeof (s as NodeJS.ReadStream).setRawMode !== "function") {
    return;
  }
  const rs = s as NodeJS.ReadStream;
  if (rs.isRaw) {
    try {
      rs.setRawMode(false);
    } catch {
      // ignore
    }
  }
}

const handleCtrlCAbort: CtrlCAbortHandler = ({ exit, repeated }) => {
  if (repeated) {
    process.exit(130);
  }
  const reason = "Stopped by user (Ctrl+C)";
  const abortError = new Error(reason);
  abortError.name = "AbortError";
  restoreSteersToPrompt();
  const dispatched = requestRunAbort(reason);
  failPendingLineInput(abortError);
  if (!dispatched) {
    // No run registered to unwind; exit directly.
    exit();
    process.exit(130);
  }
};

const handleLocalCommand = createInteractiveCommandHandler({
  applyMode: (text) => {
    const mode = applyModeCommand(text);
    return mode ? MODE_META[mode] : null;
  },
  listTools: () =>
    useOutputStore
      .getState()
      .history.filter((turn) => turn.type === "tool")
      .map((turn, index) => ({
        ordinal: turn.tool.ordinal ?? index + 1,
        toolName: turn.tool.toolName,
        summary: turn.tool.summary,
        args: turn.tool.args,
        detail: turn.tool.detail,
        fullResult: turn.tool.fullResult,
      })),
  getLastAssistantMessage: () =>
    [...useOutputStore.getState().history].reverse().find((turn) => turn.type === "assistant")
      ?.content,
  openTranscript: () => useViewStore.getState().openTranscript(),
  copyText: copyTextToClipboard,
  logSystem: (message) => useOutputStore.getState().logSystem(message),
});

export function mountInkApp(): Instance {
  installWindowsVirtualTerminalInputPatch();
  // A fresh <Static> starts its flushed count at 0, so the cleared-turns prefix (kept only to
  // pad the previous instance's count) must go, or it would be re-emitted on mount.
  pruneClearedStaticTurns();
  // exitOnCtrlC:false: Dashboard owns Ctrl+C so it can abort the run and close traces cleanly.
  return render(
    React.createElement(Dashboard, {
      onCtrlCAbort: handleCtrlCAbort,
      hasInterruptibleTask: hasActiveInterruptibleTask,
      onInterrupt: () => usePromptStore.getState().submitLine("/stop"),
      onCycleMode: () => {
        useModeStore.getState().cycleMode();
      },
      onLocalCommand: handleLocalCommand,
      readClipboardImage: saveClipboardImage,
    }),
    {
      exitOnCtrlC: false,
    },
  );
}

export function createInkLifecycle(): {
  suspendForExternalProcess: <T>(fn: () => Promise<T>) => Promise<T>;
  clearScreen: () => void;
  dispose: () => void;
} {
  let ink: Instance = mountInkApp();

  /** Unmount Ink and drop raw mode before handing the TTY to vim / an external editor. */
  const suspendForExternalProcess = async <T>(fn: () => Promise<T>): Promise<T> => {
    ink.unmount();
    releaseStdinRawMode();
    try {
      return await fn();
    } finally {
      ink = mountInkApp();
    }
  };

  return {
    suspendForExternalProcess,
    // Drop Ink's tracked live frame, then wipe screen + scrollback (2J/3J) and home the cursor.
    // Ink repaints a fresh frame on the next render (triggered by the accompanying store change),
    // so the committed <Static> backlog is gone rather than left in scrollback.
    clearScreen: () => {
      ink.clear();
      process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    },
    dispose: () => {
      ink.clear();
      ink.unmount();
      process.stdout.write("\x1b[?25h");
      releaseStdinRawMode();
    },
  };
}
