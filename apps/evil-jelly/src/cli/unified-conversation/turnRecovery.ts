import type { Message } from "@rejelly/core";

export type TurnRecoveryStatus = "failed" | "interrupted";
export type TurnRecoveryStage = "preparation" | "agent";

/** One-shot recovery state for the latest failed or interrupted conversation turn. */
export interface TurnRecoveryState {
  status: TurnRecoveryStatus;
  stage: TurnRecoveryStage;
  message: string;
  toolActivity: "none" | "unknown";
  turnId?: string;
  userMessage: Message;
}

export type TurnExecutionResult =
  | { status: "completed" }
  | { status: "failed" | "interrupted"; recovery: TurnRecoveryState };

export const CONTINUE_PROMPT =
  "Continue the previous task using the available conversation and tool history. Verify the current state before repeating any action.";
