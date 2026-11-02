import type { UserInputAttachmentDisplay } from "../model/prompt/frozenUserInput";
import type { TranscriptItem, TranscriptTurnUpdate } from "../session/transcript";
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

/** Structured progress for a model retry, kept separate from free-form phase detail. */
export interface ReconnectProgress {
  stage: "backoff" | "attempt";
  kind: "connection" | "transient";
  attempt: number;
  maxAttempts?: number;
  errorCode: string;
  stageStartedAt: number;
  retryAt?: number;
}

/** Compact authored input and attachment outcomes, never a replacement for the full message. */
export interface UserMessagePresentation {
  summary: string;
  attachments: readonly UserInputAttachmentDisplay[];
}

/** Complete host-facing presentation port for a conversation, including its tool activity. */
export interface ConversationPresentationBindings {
  /** Stream assistant text for the current turn into the transient surface. */
  printOut: (message: string) => void;
  /** Full text stays available to text-only hosts; structured metadata is presentation-only. */
  logUserMessage: (message: string, presentation?: UserMessagePresentation) => void;
  logAssistantMessage: (message: string) => void;
  logSystemEvent: (message: string) => void;
  logToolRound?: (calls: number) => void;
  logToolStart?: (start: ToolObservationStart) => ToolCallHandle;
  appendToolOutput?: (toolCallId: string, chunk: string) => void;
  logToolBlock: (block: ToolObservationBlock) => void;
  hydrateHistory?: (items: TranscriptItem[]) => void;
  /**
   * Turn lifecycle for the answer browser and withdrawable live scrollback. The initial
   * running update with a prompt precedes logUserMessage; visible streamed text starts progress.
   */
  onTranscriptTurn?: (update: TranscriptTurnUpdate) => void;
  clearHistory?: () => void;
  clearScreen?: () => void;
  showSessionBanner?: () => void;
  onDetailUpdate?: (detail: string) => void;
  onPhaseUpdate?: (phase: RuntimePhase, detail?: string) => void;
  /** Retry backoff/attempt lifecycle for the persistent runtime status line. */
  onReconnectUpdate?: (progress: ReconnectProgress) => void;
  /** Live model-side progress while one or more tool calls are still being serialized. */
  onToolCallGenerationUpdate?: (progress: ToolCallGenerationProgress | null) => void;
  /**
   * Run presentation-only work after the current assistant stream segment or tool batch ends.
   * Returns a cancellation function. Headless hosts may omit this and let the router use its
   * turn-end fallback.
   */
  runAtSafeOutputBoundary?: (operation: () => void) => () => void;
  onTurnStart?: () => void;
  /** Release a transient submission acknowledgement after preparation succeeds or fails. */
  onInputPreparationEnd?: () => void;
}
