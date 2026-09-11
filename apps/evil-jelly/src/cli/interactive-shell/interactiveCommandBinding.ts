import { buildToolTranscriptEntries } from "../conversation-display/tool-transcript/projection";
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
  listTools: () => {
    const { runningTools, toolHistory } = useOutputStore.getState();
    return buildToolTranscriptEntries(toolHistory, runningTools);
  },
  getLastAssistantMessage: () =>
    [...useOutputStore.getState().history].reverse().find((turn) => turn.type === "assistant")
      ?.content,
  openTranscript: () => useToolTranscriptViewStore.getState().openTranscript(),
  copyText: copyTextToClipboard,
  logSystem: (message) => useOutputStore.getState().logSystem(message),
});
