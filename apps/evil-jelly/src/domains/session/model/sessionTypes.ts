import type { Message } from "@rejelly/core";
import type { SessionMcpState } from "../../../shared/model/mcp/sessionMcpState";
import type { TranscriptItem } from "../../../shared/session/transcript";
import type { LegacySessionMeta, SessionBudgetData } from "./sessionEvents";

/**
 * Cumulative resource usage for a session across multiple resume segments.
 *
 * Token and cost fields are running totals. `lastContextTokens` and
 * `lastCacheReadTokens` describe the latest model call rather than another cumulative sum.
 * The versioned Session event schema remains the source of truth for this public projection.
 */
export type SessionBudget = SessionBudgetData;

/**
 * Resume-only association between the latest provider prompt usage and the active-context prefix
 * that produced it. Derived from event ordering; never persisted as another session fact.
 */
export interface SessionContextTokenAnchor {
  promptTokens: number;
  messageCount: number;
  modelId: string;
  provider?: string;
}

/** Storage-version-independent picker/resume metadata projected from V1, V2, or V3. */
export type SessionMeta = LegacySessionMeta;

export interface SessionRecord {
  /** Storage-version-independent metadata consumed by picker and resume flows. */
  meta: SessionMeta;
  /** Active model context projected from the selected storage version. */
  messages: Message[];
  /** Validated provider-token anchor for a prefix of `messages`, when replay can prove one. */
  contextTokenAnchor?: SessionContextTokenAnchor;
  /** Prepared display projection. V1 callers may still build this lazily from messages. */
  transcript?: TranscriptItem[];
  /** Canonical Session MCP projection; V1/V2 sources project an empty state. */
  mcp: SessionMcpState;
  /** Non-blocking compatibility notices to show when hydrating a resumed session. */
  warnings?: string[];
}
