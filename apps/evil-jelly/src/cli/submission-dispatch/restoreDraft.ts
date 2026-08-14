import type { LineInputValue, UserAttachment } from "../../shared/host/inputBindings";

function mergeAttachments(inputs: readonly LineInputValue[]): UserAttachment[] {
  return inputs.flatMap((input) => input.attachments ?? []);
}

/** Collapse buffered steers into the single draft restored after cancellation. */
export function mergeSteersIntoDraft(
  steers: readonly LineInputValue[],
): LineInputValue | undefined {
  if (steers.length === 0) {
    return undefined;
  }
  const skills = steers.flatMap((input) => input.skills ?? []);
  return {
    text: steers
      .map((input) => input.text.trim())
      .filter(Boolean)
      .join("\n"),
    attachments: mergeAttachments(steers),
    ...(skills.length > 0 ? { skills } : {}),
  };
}
