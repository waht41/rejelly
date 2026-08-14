import { useApp, useInput } from "ink";
import { useRef } from "react";

/** Process-level Ctrl+C policy supplied by the interactive shell lifecycle. */
export type CtrlCAbortHandler = (event: {
  /** Ink app exit hook for hosts that need to unmount before process exit. */
  exit: () => void;
  /** True when Ctrl+C is pressed again after the graceful abort was already requested. */
  repeated: boolean;
}) => void;

export function useCtrlCAbort(onCtrlCAbort: CtrlCAbortHandler): void {
  // Ctrl+C ends the process (Esc never does; it only stops sub-agents). First press aborts the
  // run gracefully so the cancel signal reaches the agent tree and the trace closes; second exits.
  const { exit } = useApp();
  const ctrlCArmed = useRef(false);
  useInput((input, key) => {
    if (!key.ctrl || input !== "c") {
      return;
    }
    if (ctrlCArmed.current) {
      onCtrlCAbort({ exit, repeated: true });
      return;
    }
    ctrlCArmed.current = true;
    onCtrlCAbort({ exit, repeated: false });
  });
}
