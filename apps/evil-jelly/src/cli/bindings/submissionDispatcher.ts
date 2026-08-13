import type { LineInputValue } from "../../shared/host/inputBindings";
import {
  interruptActiveTask,
  type TaskInterruptionResult,
} from "../../shared/task-interruption/taskStack";
import { useOutputStore } from "../conversation-display/useOutputStore";
import type { InteractiveRunControl } from "../entry/unified-run/interactive/runControl";
import { useComposerSession } from "../message-composer/session/composerSession";
import {
  createSubmissionDispatcher,
  type SubmissionDispatcher,
  type SubmissionDispatcherOptions,
} from "../submission-dispatch/dispatcher";

let activeDispatcher: SubmissionDispatcher | undefined;

function formatTaskInterruption(result: TaskInterruptionResult): string {
  if (!result.interrupted) return "[System] Nothing to stop right now.";
  return `[System] Interrupted active task [${result.task.type}] ${result.task.name}.`;
}

export function createCliSubmissionDispatcher(
  runControl: InteractiveRunControl,
  options?: SubmissionDispatcherOptions,
) {
  const dispatcher = createSubmissionDispatcher(
    {
      interruptTask: (reason) => formatTaskInterruption(interruptActiveTask(reason)),
      requestExit: () => runControl.loop.request({ type: "exit" }),
      requestRunAbort: runControl.segment.requestAbort,
      restoreDraft: (draft: LineInputValue) => useComposerSession.getState().seedDraft(draft),
      logSystem: (message) => useOutputStore.getState().logSystem(message),
      setInputPhase: (phase) =>
        phase === "awaiting"
          ? useOutputStore.getState().setPhase("awaiting_user", "Waiting for input")
          : useOutputStore.getState().setPhase("working", "Running…"),
    },
    options,
  );
  useComposerSession.getState().setBackgroundLineHandler(dispatcher.submit);
  activeDispatcher = dispatcher;
  return dispatcher;
}

export function cancelCliSubmission(reason: string): boolean {
  return activeDispatcher?.cancel(reason) ?? false;
}
