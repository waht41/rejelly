import type { Message } from "@rejelly/core";

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

export const ABORT_CONTINUE_PROMPT =
  "The previous task was interrupted by the user. Continue from the available conversation and tool history. Verify the current state before repeating any action.";

export const TRANSIENT_CONTINUE_PROMPT =
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

export function continuationPromptForRecovery(recovery: TurnRecoveryState): string {
  const base = recovery.reason === "user_abort" ? ABORT_CONTINUE_PROMPT : TRANSIENT_CONTINUE_PROMPT;
  switch (recovery.toolActivity) {
    case "none":
      return base;
    case "requested":
      return `${base} A tool was requested but may not have started.`;
    case "running":
      return `${base} A tool execution was interrupted, so partial side effects may have occurred.`;
    case "completed":
      return `${base} Completed tool results are already present in the conversation history.`;
    case "unknown":
      return `${base} A tool outcome may be unknown; inspect current state before retrying it.`;
  }
}
