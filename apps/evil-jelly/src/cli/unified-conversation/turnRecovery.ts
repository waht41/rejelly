import type { Message } from "@rejelly/core";
import { UNKNOWN_TOOL_OUTCOME_CONTENT } from "../../domains/session/projection/sessionRecovery";
import { INTERRUPTED_TOOL_OUTPUT_CONTENT } from "../../features/unified/context-management/interruptedDelta";
import { messageContentToText } from "../../shared/model/message/content";

export type TurnRecoveryStatus = "failed" | "interrupted";
export type TurnRecoveryStage = "preparation" | "agent";
export type TurnRecoveryReason =
  | "user_abort"
  | "transient_model_failure"
  | "unknown_model_failure"
  | "session_recovery";
/** Explicit /continue behavior, independent of model middleware automatic retry eligibility. */
export type TurnRecoveryStrategy = "retry_same_turn" | "resume_with_context";
export type TurnToolActivity = "none" | "requested" | "running" | "completed" | "unknown";

/** One-shot recovery state for the latest failed or interrupted conversation turn. */
export interface TurnRecoveryState {
  status: TurnRecoveryStatus;
  reason: TurnRecoveryReason;
  strategy: TurnRecoveryStrategy;
  stage: TurnRecoveryStage;
  message: string;
  toolActivity: TurnToolActivity;
  turnId?: string;
  userMessage: Message;
  /** Full active context for a safe pre-output model retry, including completed tool results. */
  retryHistory?: Message[];
  mcpServerIds: readonly string[];
}

export type TurnExecutionResult =
  | { status: "completed" }
  | { status: "recoverable" | "interrupted"; recovery: TurnRecoveryState }
  | {
      status: "blocked";
      message: string;
      suggestedCommand?: string;
      suggestedAction?: string;
    };

const TRANSIENT_CONTINUE_PROMPT =
  "Continue the previous task using the available conversation and tool history. Verify the current state before repeating any action.";

export function recoveryActivityWarning(activity: TurnToolActivity): string {
  switch (activity) {
    case "none":
      return "";
    case "requested":
      return " A tool was requested but may not have started.";
    case "running":
      return " A tool execution was interrupted; partial side effects may have occurred.";
    case "completed":
      return " A tool completed before the failure; continue from its recorded result.";
    case "unknown":
      return " A tool outcome may be unknown; verify current state before repeating actions.";
  }
}

/** Only add an instruction when the committed history does not already express how to continue. */
export function continuationPromptForHistory(history: readonly Message[]): string | undefined {
  const last = history.at(-1);
  if (!last || last.role === "user") return undefined;

  if (last.role === "assistant" && !last.tool_calls?.length) {
    return TRANSIENT_CONTINUE_PROMPT;
  }

  // Inspect the whole trailing tool batch: a later successful result must not hide an
  // earlier interrupted execution. Stop at any new user/model message, including a
  // previously inserted continuation, so retries without progress remain unchanged.
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message.role !== "tool") break;
    const content = messageContentToText(message.content);
    if (
      content === INTERRUPTED_TOOL_OUTPUT_CONTENT ||
      content === UNKNOWN_TOOL_OUTCOME_CONTENT ||
      (content.startsWith("exitCode=null status=aborted\n") &&
        content.endsWith("Command aborted by user (/stop or Esc).")) ||
      /^Tool "[^"]+" execution failed: AbortError:/.test(content)
    ) {
      return `${TRANSIENT_CONTINUE_PROMPT} A tool execution was interrupted or its outcome is unknown; partial side effects may have occurred.`;
    }
  }
  return undefined;
}
