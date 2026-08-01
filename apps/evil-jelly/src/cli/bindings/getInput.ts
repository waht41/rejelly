import { requestExit } from "../../services/session/resumeControl";
import { drainSteers, enqueueSteer } from "../../services/steer/steerControl";
import { requestRunAbort } from "../../services/stop/runControl";
import { requestRuntimeStop } from "../../services/stop/runtimeControl";
import type { LineInputValue } from "../../shared/AgentShared";
import { useOutputStore } from "../store/useOutputStore";
import { usePromptStore } from "../store/usePromptStore";
import {
  dequeueLineInput,
  enqueueLineInput,
  isAwaitingMainInput,
  rejectPendingLineInput,
  setAwaitingMainInput,
} from "./promptQueue";
import { restoreSteersToPrompt } from "./restoreSteersToPrompt";

export type InkGetInputOptions = {
  /** First line returned without opening the line prompt (e.g. CLI --input after snapshot restore). */
  seedLine?: string;
};

function isExitCommand(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === "/exit" || normalized === "exit";
}

function isRuntimeSlashCommand(value: string): boolean {
  return value.startsWith("/");
}

export function createInkGetInput(options?: InkGetInputOptions): () => Promise<LineInputValue> {
  let pendingSeed = options?.seedLine !== undefined;
  usePromptStore.getState().setBackgroundLineHandler((rawValue) => {
    const value = rawValue.text.trim();
    if (value.length === 0) {
      return;
    }
    const normalized = value.toLowerCase();
    if (normalized === "/stop") {
      restoreSteersToPrompt();
      const message = requestRuntimeStop();
      useOutputStore.getState().logSystem(message);
      const abortError = new Error("Stopped by user (/stop or Esc)");
      abortError.name = "AbortError";
      rejectPendingLineInput(abortError);
      return;
    }
    if (isAwaitingMainInput()) {
      enqueueLineInput({ text: value, attachments: rawValue.attachments });
      return;
    }
    if (isExitCommand(value)) {
      requestExit();
      useOutputStore.getState().logSystem("Goodbye.");
      const reason = "Stopped by user (exit)";
      requestRunAbort(reason);
      const abortError = new Error(reason);
      abortError.name = "AbortError";
      rejectPendingLineInput(abortError);
      return;
    }
    if (isRuntimeSlashCommand(value)) {
      useOutputStore.getState().logSystem(`${value} is not available while the agent is running.`);
      return;
    }
    enqueueSteer({ text: value, attachments: rawValue.attachments });
  });
  return async () => {
    if (pendingSeed) {
      pendingSeed = false;
      const line = (options?.seedLine ?? "").trim();
      useOutputStore.getState().setPhase("working", "Running…");
      return { text: line };
    }
    const pendingSteers = drainSteers();
    if (pendingSteers.length > 0) {
      const [next, ...rest] = pendingSteers;
      for (const line of rest) {
        enqueueLineInput(line);
      }
      useOutputStore.getState().setPhase("working", "Running…");
      return next!;
    }
    useOutputStore.getState().setPhase("awaiting_user", "Waiting for input");
    setAwaitingMainInput(true);
    try {
      const line = await dequeueLineInput();
      useOutputStore.getState().setPhase("working", "Running…");
      return line;
    } finally {
      setAwaitingMainInput(false);
    }
  };
}
