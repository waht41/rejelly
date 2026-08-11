import type { Message } from "@rejelly/core";
import { getUserInputDisplay } from "../../../shared/attachments/messageContent";
import {
  isCompactionBridgeMessage,
  unwrapPriorUserMessageText,
} from "../../../shared/lib/compactionMessages";
import { messageContentToText } from "../../../shared/lib/tokens";

const SESSION_TITLE_MAX_CHARS = 80;

/**
 * Derive the stable picker title from one real user message.
 *
 * Display metadata wins because attachment-bearing messages may contain large inline payloads.
 * Callers reading V1 snapshots may opt into unwrapping persisted `<prior_user_message>` projections.
 * V2 event callers leave that off so real user text is never heuristically rewritten.
 */
export function deriveSessionTitle(
  message: Message,
  options: { legacyCompactionProjection?: boolean } = {},
): string | undefined {
  if (message.role !== "user" || isCompactionBridgeMessage(message)) {
    return undefined;
  }
  const display = getUserInputDisplay(message);
  const fallback = messageContentToText(message.content);
  const raw = display
    ? display.text
    : options.legacyCompactionProjection
      ? unwrapPriorUserMessageText(fallback)
      : fallback;
  const oneLine = raw.replace(/\s+/g, " ").trim();
  if (!oneLine) {
    return undefined;
  }
  return oneLine.length > SESSION_TITLE_MAX_CHARS
    ? `${oneLine.slice(0, SESSION_TITLE_MAX_CHARS - 1)}…`
    : oneLine;
}

/** V1 snapshot compatibility: choose the first title-bearing message, or the shared fallback. */
export function deriveSessionTitleFromMessages(messages: readonly Message[]): string {
  for (const message of messages) {
    const title = deriveSessionTitle(message, { legacyCompactionProjection: true });
    if (title) {
      return title;
    }
  }
  return "(untitled)";
}
