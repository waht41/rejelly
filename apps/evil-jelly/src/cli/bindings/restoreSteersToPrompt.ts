import type { LineInputValue, UserAttachment } from "../../shared/AgentShared";
import { drainSteers } from "../../shared/runtime/steerControl";
import { usePromptStore } from "../store/usePromptStore";

function mergeAttachments(inputs: LineInputValue[]): UserAttachment[] {
  return inputs.flatMap((input) => input.attachments ?? []);
}

export function restoreSteersToPrompt(): number {
  const steers = drainSteers();
  if (steers.length === 0) {
    return 0;
  }
  const skills = steers.flatMap((input) => input.skills ?? []);
  usePromptStore.getState().seedDraft({
    text: steers
      .map((input) => input.text.trim())
      .filter(Boolean)
      .join("\n"),
    attachments: mergeAttachments(steers),
    ...(skills.length > 0 ? { skills } : {}),
  });
  return steers.length;
}
