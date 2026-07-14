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
