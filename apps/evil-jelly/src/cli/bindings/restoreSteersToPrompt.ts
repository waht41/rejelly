import type { LineInputValue, UserAttachment } from "../../shared/host/inputBindings";
import { useComposerSession } from "../message-composer/session/composerSession";
import { drainSteers } from "../runtime/steerControl";

function mergeAttachments(inputs: LineInputValue[]): UserAttachment[] {
  return inputs.flatMap((input) => input.attachments ?? []);
}

export function restoreSteersToPrompt(): number {
  const steers = drainSteers();
  if (steers.length === 0) {
    return 0;
  }
  const skills = steers.flatMap((input) => input.skills ?? []);
  useComposerSession.getState().seedDraft({
    text: steers
      .map((input) => input.text.trim())
      .filter(Boolean)
      .join("\n"),
    attachments: mergeAttachments(steers),
    ...(skills.length > 0 ? { skills } : {}),
  });
  return steers.length;
}
