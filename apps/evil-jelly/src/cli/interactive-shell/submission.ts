import type { PromptInput } from "../../shared/model/prompt/promptInput";
import {
  interruptActiveTask,
  type TaskInterruptionResult,
} from "../../shared/task-interruption/taskStack";
import { useOutputStore } from "../conversation-display/useOutputStore";
import { useComposerSession } from "../message-composer/session/composerSession";
import {
  createSubmissionDispatcher,
  type SubmissionDispatcherOptions,
} from "../submission-dispatch/dispatcher";

export interface InteractiveSubmissionControl {
  requestExit: () => void;
  requestRunAbort: (reason: string) => boolean;
}

function formatTaskInterruption(result: TaskInterruptionResult): string {
  if (!result.interrupted) return "[System] Nothing to stop right now.";
  return `[System] Interrupted active task [${result.task.type}] ${result.task.name}.`;
}

export function createInteractiveSubmission(
  control: InteractiveSubmissionControl,
  options?: SubmissionDispatcherOptions,
) {
  const dispatcher = createSubmissionDispatcher(
    {
      interruptTask: (reason) => formatTaskInterruption(interruptActiveTask(reason)),
      requestExit: control.requestExit,
      requestRunAbort: control.requestRunAbort,
      restoreDraft: (draft: PromptInput) => useComposerSession.getState().seedDraft(draft),
      logSystem: (message) => useOutputStore.getState().logSystem(message),
      setInputPhase: (phase) =>
        phase === "awaiting"
          ? useOutputStore.getState().setPhase("awaiting_user", "Waiting for input")
          : useOutputStore.getState().setPhase("working", "Running…"),
    },
    options,
  );
  useComposerSession.getState().setBackgroundLineHandler(dispatcher.submit);
  return dispatcher;
}
