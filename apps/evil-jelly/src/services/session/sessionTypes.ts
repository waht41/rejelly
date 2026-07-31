import type { Message } from "@rejelly/core";
import type { LegacySessionMeta, SessionBudgetData } from "./sessionEvents";
import type { TranscriptItem } from "./sessionHistoryProjection";

/**
 * Cumulative resource usage for a session across multiple resume segments.
 *
 * Token and cost fields are running totals. `lastContextTokens` and
 * `lastCacheReadTokens` describe the latest model call rather than another cumulative sum.
 * The persisted V2 Zod schema remains the source of truth for this compatibility alias.
 */
export type SessionBudget = SessionBudgetData;

/** Legacy snapshot metadata is the common picker/resume projection shared by V1 and V2. */
export type SessionMeta = LegacySessionMeta;

export interface SessionRecord {
  /** Storage-version-independent metadata consumed by picker and resume flows. */
  meta: SessionMeta;
  /** Active model context. For V1 this is the stored snapshot; for V2 it is a projection. */
  messages: Message[];
  /** Prepared display projection. V1 callers may still build this lazily from messages. */
  transcript?: TranscriptItem[];
  /** Non-blocking compatibility notices to show when hydrating a resumed session. */
  warnings?: string[];
}
