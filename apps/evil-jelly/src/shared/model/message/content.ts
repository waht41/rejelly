import type { MessageContent } from "@rejelly/core";

export function appendMessageContentSuffix(
  content: MessageContent | null,
  suffix: string,
): MessageContent {
  if (content === null) {
    return suffix;
  }
  if (typeof content === "string") {
    return `${content}\n\n${suffix}`;
  }
  return [...content, { type: "text", text: `\n\n${suffix}` }];
}

/** Flatten message content to its text; non-text parts such as images contribute no text. */
export function messageContentToText(content: MessageContent | null): string {
  if (content == null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  return content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}
