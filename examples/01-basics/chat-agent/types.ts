/**
 * Chatty Customer Service Agent Type Definitions
 */

import type { Message } from "@rejelly/core";

export interface ChattyAgentProps {
  userId?: string; // User ID (optional, for persisting conversation history)
}

export interface ChattyAgentResult {
  // Conversation history is stored as raw chat Messages: the user turns plus the
  // model's actual `delta` output. In schema mode the assistant content is the raw
  // JSON envelope, which keeps replayed history format-consistent with the schema.
  conversationHistory: Message[];
  turnCount: number; // Conversation turn count
  isSatisfied: boolean; // Whether user is satisfied (can end conversation)
}
