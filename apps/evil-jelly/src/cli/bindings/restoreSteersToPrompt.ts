import { drainSteers } from "../../services/steer/steerControl";
import type { LineInputValue, UserAttachment } from "../../shared/AgentShared";
import { usePromptStore } from "../store/usePromptStore";

function mergeAttachments(inputs: LineInputValue[]): UserAttachment[] {
  return inputs.flatMap((input) => input.attachments ?? []);
}

export function restoreSteersToPrompt(): number {
  const steers = drainSteers();
  if (steers.length === 0) {
    return 0;
  }
  usePromptStore.getState().seedDraft({
    text: steers
      .map((input) => input.text.trim())
      .filter(Boolean)
      .join("\n"),
    attachments: mergeAttachments(steers),
  });
  return steers.length;
}
