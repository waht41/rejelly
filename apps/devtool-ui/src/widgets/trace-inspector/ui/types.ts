import type { ChatMessage, ErrorInfo } from "src/entities/trace/types";

// Role type for message roles in execution conversation.
export type RoleType = "system" | "user" | "assistant" | "tool";

/**
 * Prompt assembly information.
 */
export interface PromptAssembly {
  /** System prompt */
  system?: string;
  /** Memory context */
  memory?: string;
  /** Instruction prompt */
  instruction?: string;
  /** Full assembled prompt */
  full?: string;
  /** Messages sent to LLM (for conversation view) */
  messages?: Array<{
    role: RoleType;
    content:
      | string
      | Array<{
          type: "text" | "image" | "video";
          text?: string;
          image?: { url: string };
          video?: { url: string };
        }>
      | null;
    tool_calls?: Array<{ id: string; name: string; arguments: string }>;
    tool_call_id?: string;
    name?: string;
  }>;
}

/**
 * Memory diff - represents changes in agent memory.
 */
export interface MemoryDiff {
  /** Previous memory state (JSON string) */
  prevMemory: string;
  /** Current memory state (JSON string) */
  currentMemory: string;
  /** Diff description (what changed) */
  description?: string;
}

/**
 * Output and validation result.
 */
export interface OutputValidation {
  /** Raw output text */
  raw: string;
  /** Parsed data (if successful) */
  data?: unknown;
  /** Whether validation passed */
  validated: boolean;
  /** Validation errors (if any) */
  errors?: Array<{
    name: string;
    message: string;
  }>;
}

export interface ExecutionHistory {
  id: string;
  status: "running" | "success" | "failed";
  // Core change: transform flat timeline into structured turns array
  turns: Turn[];
}

// Corresponds to "Turn 1", "Turn 2" cards in UI.
export interface Turn {
  id: number; // turnCount
  status: "running" | "success" | "failed";

  // Corresponds to input in PromptEnd, as a Turn's input is usually constant
  inputPayload: any;

  // Full conversation messages up to and including this turn.
  // New trace model emits turn-level messages instead of attempt-level events.
  messages: ChatMessage[];

  // Validation failures captured during this turn.
  validationErrors: string[];

  // Token usage captured from model:call:end for this turn.
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };

  // Error information if the turn failed
  error?: ErrorInfo;

  // Final result (if successful), corresponds to PromptEnd's result.
  // Note: may hit cache, causing no attempt/turn events to be received. In this case, a turn can be constructed from promptStart and promptEnd
  finalResult?: {
    output: string;
    // Corresponds to PromptEnd's cache
    isCached: boolean;
  };
}
