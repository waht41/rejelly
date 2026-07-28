import type { Message } from "@rejelly/core";
import { unwrapPseudoXmlElement } from "./pseudoXml";
import { messageContentToText } from "./tokens";

export const PRIOR_USER_MESSAGE_TAG = "prior_user_message";
export const PRIOR_USER_MESSAGE_OPEN = `<${PRIOR_USER_MESSAGE_TAG}>`;
export const PRIOR_USER_MESSAGE_CLOSE = `</${PRIOR_USER_MESSAGE_TAG}>`;
export const COMPACTION_SUMMARY_TAG = "compaction_summary";
export const COMPACTION_NOTICE_PREFIX = "[Context was automatically compacted";
export const COMPACTION_BRIDGE_MESSAGE_KIND = "compaction_bridge";

/** Internal model-context bridge written by compaction, not a real user turn. */
export function isCompactionBridgeMessage(message: Message): boolean {
  if (isStructuredCompactionBridge(message)) {
    return true;
  }
  return (
    message.role === "user" &&
    messageContentToText(message.content).trimStart().startsWith(COMPACTION_NOTICE_PREFIX)
  );
}

function isStructuredCompactionBridge(message: Message): boolean {
  const rejelly = message.extra?.rejelly;
  return (
    typeof rejelly === "object" &&
    rejelly !== null &&
    "kind" in rejelly &&
    rejelly.kind === COMPACTION_BRIDGE_MESSAGE_KIND
  );
}

/** Remove the model-only boundary around a retained historical user message for UI replay. */
export function unwrapPriorUserMessageText(text: string): string {
  return unwrapPseudoXmlElement(text, PRIOR_USER_MESSAGE_TAG)?.trim() ?? text.trim();
}

/** Count real persisted user turns without treating the compaction bridge as user input. */
export function countConversationTurns(messages: Message[]): number {
  return messages.filter(
    (message) => message.role === "user" && !isCompactionBridgeMessage(message),
  ).length;
}
