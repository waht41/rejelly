/**
 * Slash-command palette for MessageComposer. Typing `/` at the start of an empty-ish line
 * opens a discovery panel (mirrors the `@` file picker). The commands themselves are handled
 * downstream by the interactive command or application router, depending on the command's
 * lifetime and data needs, so this module only describes and filters.
 */

export interface SlashCommand {
  /** Full command token, including the leading slash (e.g. "/resume"). */
  name: string;
  /** One-line description shown in the panel. */
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/resume", description: "Switch to a saved session" },
  { name: "/status", description: "Show workspace, token usage, and context window" },
  { name: "/mcp", description: "Open the MCP server manager" },
  { name: "/memory", description: "View and manage persistent memory" },
  { name: "/skills", description: "List and inspect local Skills" },
  { name: "/clear", description: "Start a new empty session" },
  { name: "/compress", description: "Compress the current session history" },
  { name: "/mode", description: "Toggle interaction mode (normal ⇄ auto)" },
  { name: "/copy-last", description: "Copy the last assistant message as raw markdown" },
  {
    name: "/expand-tool",
    description:
      "Open the tool result picker; add a number to print one directly, e.g. /expand-tool #5",
  },
  { name: "/stop", description: "Interrupt the running task" },
  { name: "/exit", description: "Quit evil-jelly" },
];

/**
 * Return the command query the caret currently sits at the end of, or null when no slash
 * trigger is active. Active only on a single command token: the line must start with `/`,
 * contain no whitespace up to the caret (whitespace means the user moved on to arguments),
 * and the caret must close the token (end of text or before whitespace).
 */
export function extractSlashQuery(text: string, cursor: number): string | null {
  if (!text.startsWith("/")) {
    return null;
  }
  const left = text.slice(0, cursor);
  if (/\s/.test(left)) {
    return null;
  }
  if (cursor < text.length && !/\s/.test(text[cursor]!)) {
    return null;
  }
  return left.slice(1);
}

/** Commands whose name contains the query (case-insensitive). Empty query lists all. */
export function filterSlashCommands(query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return SLASH_COMMANDS;
  }
  return SLASH_COMMANDS.filter((c) => c.name.slice(1).toLowerCase().includes(q));
}
