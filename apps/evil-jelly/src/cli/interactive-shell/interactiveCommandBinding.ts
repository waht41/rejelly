import { useToolTranscriptViewStore } from "../conversation-display/tool-transcript/viewStore";
import { useOutputStore } from "../conversation-display/useOutputStore";
import { applyModeCommand, MODE_META } from "../tool-approval/approvalModeStore";
import { copyTextToClipboard } from "./clipboard/clipboardText";
import { createInteractiveCommandHandler } from "./localCommands";

export const handleLocalCommand = createInteractiveCommandHandler({
  applyMode: (text) => {
    const mode = applyModeCommand(text);
    return mode ? MODE_META[mode] : null;
  },
  listTools: () =>
    useOutputStore
      .getState()
      .history.filter((turn) => turn.type === "tool")
      .map((turn, index) => ({
        ordinal: turn.tool.ordinal ?? index + 1,
        toolName: turn.tool.toolName,
        summary: turn.tool.summary,
        args: turn.tool.args,
        detail: turn.tool.detail,
        fullResult: turn.tool.fullResult,
      })),
  getLastAssistantMessage: () =>
    [...useOutputStore.getState().history].reverse().find((turn) => turn.type === "assistant")
      ?.content,
  openTranscript: () => useToolTranscriptViewStore.getState().openTranscript(),
  copyText: copyTextToClipboard,
  logSystem: (message) => useOutputStore.getState().logSystem(message),
});
