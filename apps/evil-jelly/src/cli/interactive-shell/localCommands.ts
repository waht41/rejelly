const EXPAND_TOOL_RE = /^\/expand-tool\s+#?(\d+)\s*$/;

export interface InteractiveToolEntry {
  ordinal: number;
  toolName: string;
  summary: string;
  args?: string;
  detail?: { type: string; text: string };
  fullResult: string;
}

export interface InteractiveCommandPorts {
  applyMode: (text: string) => { label: string; hint: string } | null;
  listTools: () => InteractiveToolEntry[];
  getLastAssistantMessage: () => string | undefined;
  openTranscript: () => void;
  copyText: (text: string) => Promise<void>;
  logSystem: (message: string) => void;
}

function handleExpandTool(text: string, ports: InteractiveCommandPorts): boolean {
  if (text === "/expand-tool") {
    ports.openTranscript();
    return true;
  }
  const match = text.match(EXPAND_TOOL_RE);
  if (!match) {
    if (text.startsWith("/expand-tool ")) {
      ports.logSystem("Usage: /expand-tool #N");
      return true;
    }
    return false;
  }

  const ordinal = Number(match[1]);
  const tool = ports.listTools().find((entry) => entry.ordinal === ordinal);
  if (!tool) {
    ports.logSystem(`No tool call #${ordinal}.`);
    return true;
  }

  const border = "".padEnd(40, "─");
  const detailBlock =
    tool.detail?.type === "diff" && tool.detail.text.trim().length > 0
      ? `\nDiff\n${tool.detail.text}\n`
      : tool.args !== undefined && tool.args.trim().length > 0
        ? `\nArguments\n${tool.args}\n`
        : "\n";
  ports.logSystem(
    `#${ordinal} ${tool.toolName}\n${tool.summary}${detailBlock}${border}\n${tool.fullResult}`,
  );
  return true;
}

export function createInteractiveCommandHandler(
  ports: InteractiveCommandPorts,
): (text: string) => boolean {
  return (text) => {
    const mode = ports.applyMode(text);
    if (mode) {
      ports.logSystem(`Mode → ${mode.label} (${mode.hint})`);
      return true;
    }
    if (handleExpandTool(text, ports)) {
      return true;
    }
    if (text !== "/copy-last") {
      return false;
    }

    const lastAssistant = ports.getLastAssistantMessage();
    if (!lastAssistant) {
      ports.logSystem("No assistant message to copy.");
      return true;
    }
    ports.logSystem("Copying last assistant message...");
    void ports
      .copyText(lastAssistant)
      .then(() => {
        ports.logSystem("Copied last assistant message to clipboard.");
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        ports.logSystem(`Copy failed: ${message}`);
      });
    return true;
  };
}
