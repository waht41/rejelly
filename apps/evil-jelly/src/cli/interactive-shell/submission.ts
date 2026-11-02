import {
  isPromptInputSemanticallyEmpty,
  type PromptInput,
  promptInputCommandText,
} from "../../shared/model/prompt/promptInput";
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
  if (result.status === "idle") return "[System] Nothing to stop right now.";
  if (result.status === "already_interrupted") {
    return `[System] Active task [${result.task.type}] ${result.task.name} is already stopping.`;
  }
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
      restoreDraft: (draft: PromptInput) => {
        useOutputStore.getState().setPreparingInput(null);
        useComposerSession.getState().seedDraft(draft);
      },
      logSystem: (message) => useOutputStore.getState().logSystem(message),
      onMainInput: (input) => {
        if (isPromptInputSemanticallyEmpty(input)) return;
        // Leave router-owned commands alone. Slash-looking ordinary text will still get
        // its normal pending display once committed; acknowledgement never changes routing.
        const command = promptInputCommandText(input)?.trim();
        if (command?.startsWith("/") || command?.toLowerCase() === "exit") return;
        const output = useOutputStore.getState();
        // A second startup submission must not overwrite the first input's acknowledgement.
        if (!output.preparingInput && !output.pendingInput) output.setPreparingInput(input);
      },
      setInputPhase: (phase) => {
        const output = useOutputStore.getState();
        if (phase === "awaiting") {
          output.setPreparingInput(null);
          output.setPhase("awaiting_user", "Waiting for input");
        } else {
          output.setPhase("working", "Running…");
        }
      },
    },
    { ...options, initiallyAwaitingInput: true },
  );
  useComposerSession.getState().setBackgroundLineHandler(dispatcher.submit);
  return {
    ...dispatcher,
    cancel: (reason: string) => {
      useOutputStore.getState().setPreparingInput(null);
      return dispatcher.cancel(reason);
    },
  };
}
