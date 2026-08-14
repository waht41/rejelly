import { type Instance, render } from "ink";
import React from "react";
import { pruneClearedStaticTurns } from "../conversation-display/useOutputStore";
import { cleanupStaleClipboardImages } from "./clipboard/clipboardImage";
import { Dashboard } from "./Dashboard";
import type { CtrlCAbortHandler } from "./useCtrlCAbort";
import { installWindowsVirtualTerminalInputPatch } from "./windowsVtInput";

export interface InteractiveShellControl {
  requestRunAbort: (reason: string) => boolean;
  cancelSubmission: (reason: string) => boolean;
}

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

function createCtrlCAbortHandler(control: InteractiveShellControl): CtrlCAbortHandler {
  return ({ exit, repeated }) => {
    if (repeated) {
      process.exit(130);
    }
    const reason = "Stopped by user (Ctrl+C)";
    const dispatched = control.requestRunAbort(reason);
    control.cancelSubmission(reason);
    if (!dispatched) {
      // No run registered to unwind; exit directly.
      exit();
      process.exit(130);
    }
  };
}

function mountInkApp(control: InteractiveShellControl): Instance {
  installWindowsVirtualTerminalInputPatch();
  // A fresh <Static> starts its flushed count at 0, so the cleared-turns prefix (kept only to
  // pad the previous instance's count) must go, or it would be re-emitted on mount.
  pruneClearedStaticTurns();
  // exitOnCtrlC:false: Dashboard owns Ctrl+C so it can abort the run and close traces cleanly.
  return render(
    React.createElement(Dashboard, {
      onCtrlCAbort: createCtrlCAbortHandler(control),
    }),
    {
      exitOnCtrlC: false,
    },
  );
}

export function createInteractiveShell(control: InteractiveShellControl): {
  suspendForExternalProcess: <T>(fn: () => Promise<T>) => Promise<T>;
  clearScreen: () => void;
  dispose: () => void;
} {
  void cleanupStaleClipboardImages().catch((error) => {
    console.warn(
      `[evil-jelly] Clipboard temp cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  let ink: Instance = mountInkApp(control);

  /** Unmount Ink and drop raw mode before handing the TTY to vim / an external editor. */
  const suspendForExternalProcess = async <T>(fn: () => Promise<T>): Promise<T> => {
    ink.unmount();
    releaseStdinRawMode();
    try {
      return await fn();
    } finally {
      ink = mountInkApp(control);
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
