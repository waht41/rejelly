import type { TranscriptItem } from "../session/transcript";
import type {
  ToolCallHandle,
  ToolObservationBlock,
  ToolObservationStart,
} from "../tool-observation/model";

/** Coarse runtime phase exposed to the conversation presentation. */
export type RuntimePhase =
  | "idle"
  | "connecting"
  | "reconnecting"
  | "thinking"
  | "streaming"
  | "preparing_tool"
  | "compacting"
  | "tool"
  | "working"
  | "awaiting_user";

export interface ToolCallGenerationProgress {
  calls: Array<{
    index: number;
    name?: string;
    argumentChars: number;
  }>;
  totalArgumentChars: number;
}

/** Complete host-facing presentation port for a conversation, including its tool activity. */
export interface ConversationPresentationBindings {
  /** Stream assistant text for the current turn into the transient surface. */
  printOut: (message: string) => void;
  logUserMessage: (message: string) => void;
  logAssistantMessage: (message: string) => void;
  logSystemEvent: (message: string) => void;
  logToolRound?: (calls: number) => void;
  logToolStart?: (start: ToolObservationStart) => ToolCallHandle;
  appendToolOutput?: (toolCallId: string, chunk: string) => void;
  logToolBlock: (block: ToolObservationBlock) => void;
  hydrateHistory?: (items: TranscriptItem[]) => void;
  clearHistory?: () => void;
  clearScreen?: () => void;
  showSessionBanner?: () => void;
  onDetailUpdate?: (detail: string) => void;
  onPhaseUpdate?: (phase: RuntimePhase, detail?: string) => void;
  /** Live model-side progress while one or more tool calls are still being serialized. */
  onToolCallGenerationUpdate?: (progress: ToolCallGenerationProgress | null) => void;
  /**
   * Run presentation-only work after the current assistant stream segment or tool batch ends.
   * Returns a cancellation function. Headless hosts may omit this and let the router use its
   * turn-end fallback.
   */
  runAtSafeOutputBoundary?: (operation: () => void) => () => void;
  onTurnStart?: () => void;
}
