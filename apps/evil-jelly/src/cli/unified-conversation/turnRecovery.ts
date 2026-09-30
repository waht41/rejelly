import type { Message } from "@rejelly/core";

export type TurnRecoveryStatus = "failed" | "interrupted";
export type TurnRecoveryStage = "preparation" | "agent";
export type TurnRecoveryReason = "user_abort" | "transient_model_failure";

/** One-shot recovery state for the latest failed or interrupted conversation turn. */
export interface TurnRecoveryState {
  status: TurnRecoveryStatus;
  reason: TurnRecoveryReason;
  stage: TurnRecoveryStage;
  message: string;
  toolActivity: "none" | "unknown";
  turnId?: string;
  userMessage: Message;
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
