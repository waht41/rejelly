import type { UserReplySurface } from "../AgentShared";

export const TERMINAL_USER_REPLY_RULE_TITLE = "Terminal user reply format";

export const TERMINAL_USER_REPLY_RULE =
  "This rule applies only to user-visible chat replies, not to file contents, diffs, " +
  "or document drafts you create or edit. The host displays replies in a command-line " +
  "terminal with a lightweight Markdown viewer. Use concise Markdown only when it improves " +
  "scanability: short paragraphs, bullets, numbered lists, inline code for paths/commands/" +
  "symbols, fenced code blocks for actual code or command output, and tables for compact " +
  "comparisons. Avoid decorative Markdown: no gratuitous headings, horizontal rules, emoji " +
  "status marks, or format-only flourishes. Do not wrap the answer in JSON, a JSON code " +
  "fence, or schema labels.";

export function shouldUseTerminalUserReplyRule(replySurface?: UserReplySurface): boolean {
  return (replySurface ?? "terminal") === "terminal";
}
