import type { TranscriptItem } from "../session/transcript";

/** Coarse runtime phase exposed to the conversation view. */
export type RuntimePhase =
  | "idle"
  | "connecting"
  | "thinking"
  | "streaming"
  | "compacting"
  | "tool"
  | "working"
  | "awaiting_user";

/** Streaming, committed history, and runtime status projected to a conversation view. */
export interface ConversationViewBindings {
  /** Stream assistant text for the current turn into the transient surface. */
  printOut: (message: string) => void;
  logUserMessage: (message: string) => void;
  logAssistantMessage: (message: string) => void;
  logSystemEvent: (message: string) => void;
  hydrateHistory?: (items: TranscriptItem[]) => void;
  clearHistory?: () => void;
  clearScreen?: () => void;
  showSessionBanner?: () => void;
  onDetailUpdate?: (detail: string) => void;
  onPhaseUpdate?: (phase: RuntimePhase) => void;
  onTurnStart?: () => void;
}
