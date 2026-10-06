import type { Message } from "@rejelly/core";
import type { McpDispatchBindingFactory } from "../../domains/mcp/gateway/dispatch";
import type { SessionMessageSink } from "../../shared/session/recorderPort";
import type { UserReplySurface } from "./outputSurface";

export type TurnProgressEvent =
  | "model_output"
  | "tool_requested"
  | "tool_execution_started"
  | "tool_result_committed";

interface ConversationAgentBaseProps {
  /** Prior conversation as model messages. */
  history?: Message[];
  /** Session image store used to materialize durable locators only at the model policy boundary. */
  sessionBlobRoot?: string;
  /** Where the final user-visible reply will be consumed. Defaults to terminal. */
  replySurface?: UserReplySurface;
  /** Awaited durable message sink for the current top-level turn. */
  sessionRecorder?: SessionMessageSink;
  /** Durable session id shared by all turns in the current conversation. */
  sessionId?: string;
  /** Stable id shared by the initial input, steers, model rounds, and tool results. */
  turnId?: string;
  /** Resume-validated provider usage for a prefix of the supplied history. */
  initialTokenAnchor?: { promptTokens: number; messageCount: number };
  /** Captures one immutable MCP route/catalog view at each model dispatch boundary. */
  mcpBindingFactory?: McpDispatchBindingFactory;
  /** Cancels this chat/compression operation without aborting the owning agent run. */
  operationSignal?: AbortSignal;
  /** Host-owned progress observer used to choose a safe recovery strategy. */
  onTurnProgress?: (event: TurnProgressEvent) => void;
  /** Active history at a model request that failed before emitting output, without equipped rules. */
  onModelRetryCheckpoint?: (history: Message[]) => void;
}

export type ConversationAgentProps =
  | (ConversationAgentBaseProps & {
      /** Normal chat consumes the exact Message already prepared at the host boundary. */
      operation?: "chat";
      message: Message;
      /** Retry a failed model dispatch with its full context instead of appending the input again. */
      retryHistory?: Message[];
      /** Steers are likewise prepared before they cross into the model policy. */
      pendingUserMessages?: () => Message[] | Promise<Message[]>;
    })
  | (ConversationAgentBaseProps & {
      /** Compression operates only on history and has no synthetic current user turn. */
      operation: "compress";
    });

export interface ConversationAgentResult {
  /** User-visible assistant reply. */
  reply: string;
  /** Current active-context delta that has not been cleared by compaction. */
  delta?: Message[];
  /** Active-context checkpoint produced by manual or mid-loop compaction. */
  compactHistory?: Message[];
  /** True when the tool loop returned through its user-abort path. */
  interrupted?: boolean;
}
