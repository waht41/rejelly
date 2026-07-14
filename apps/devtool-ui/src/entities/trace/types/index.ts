/**
 * Type definitions for Rejelly DevTool
 *
 * Tree/node shapes live in {@link NormalizedTrace} (normalizedTrace.ts). This file keeps
 * shared cross-module trace types and re-exports the normalized trace module.
 */

import type { DraftViewModel, TraceEvent } from "@rejelly/core";
export type { DraftViewModel, TraceEvent };

export type ExecutionStatus = "running" | "success" | "error" | "pending" | "reborn";

export interface ErrorInfo {
  name: string;
  message: string;
  stack?: string;
  /** Recursively serialized cause chain */
  cause?: ErrorInfo;
  /** Structured extra properties from custom error classes */
  details?: Record<string, unknown>;
}

// Helper type
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Optional assistant reasoning content from model output */
  reasoning_content?: string;
  /** From assistant messages (model-requested tools); also mirrored into content for plain text view */
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  /** Tool result message: links to assistant tool_call */
  toolCallId?: string;
  name?: string;
}

import * as NormalizedTrace from "./normalizedTrace.ts";

export { NormalizedTrace };
