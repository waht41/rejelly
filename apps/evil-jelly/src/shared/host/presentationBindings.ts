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
  | "thinking"
  | "streaming"
  | "compacting"
  | "tool"
  | "working"
  | "awaiting_user";

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
  onPhaseUpdate?: (phase: RuntimePhase) => void;
  onTurnStart?: () => void;
}
