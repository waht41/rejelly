import type { Message } from "@rejelly/core";
import type { McpDispatchBindingFactory } from "../../domains/mcp/gateway/dispatch";
import type { SessionMessageSink } from "../../shared/session/recorderPort";
import type { UserReplySurface } from "./outputSurface";

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
  /** Captures one immutable MCP route/catalog view at each model dispatch boundary. */
  mcpBindingFactory?: McpDispatchBindingFactory;
}

export type ConversationAgentProps =
  | (ConversationAgentBaseProps & {
      /** Normal chat consumes the exact Message already prepared at the host boundary. */
      operation?: "chat";
      message: Message;
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
