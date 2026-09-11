const EXPAND_TOOL_RE = /^\/expand-tool\s+#?(\d+)\s*$/;

export interface InteractiveToolEntry {
  ordinal: number;
  status?: "running" | "completed";
  toolName: string;
  summary: string;
  args?: string;
  detail?: { type: string; text: string; phase?: "proposed" | "applied" };
  fullResult: string;
  lineCount?: number;
  retainedLineCount?: number;
  droppedLineCount?: number;
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
  const running = tool.status === "running";
  const diffTitle =
    tool.detail?.phase === "proposed" ? "Proposed diff (not applied)" : "Applied changes";
  const detailBlock =
    tool.detail?.type === "diff" && tool.detail.text.trim().length > 0
      ? `\n${diffTitle}\n${tool.detail.text}\n`
      : tool.args !== undefined && tool.args.trim().length > 0
        ? `\nArguments\n${tool.args}\n`
        : "\n";
  const liveOutput = running
    ? `Live output · ${tool.lineCount ?? 0} lines seen${
        (tool.retainedLineCount ?? 0) < (tool.lineCount ?? 0)
          ? ` · retaining latest ${tool.retainedLineCount ?? 0}`
          : ""
      }\n`
    : "";
  const omitted =
    running && (tool.droppedLineCount ?? 0) > 0
      ? `… ${tool.droppedLineCount} earlier lines omitted\n`
      : "";
  const result = running && tool.fullResult.length === 0 ? "Waiting for output…" : tool.fullResult;
  ports.logSystem(
    `#${ordinal} ${tool.toolName}${running ? " (running)" : ""}\n${tool.summary}${detailBlock}${liveOutput}${border}\n${omitted}${result}`,
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
