import fs from "node:fs/promises";
import { getErrnoCode } from "../foundation/errno";
import type { PromptAttachment, PromptInput } from "../model/prompt/promptInput";

/** Release only files explicitly owned by these attachment records. Safe to call repeatedly. */
export async function releasePromptAttachments(
  attachments: readonly PromptAttachment[],
): Promise<void> {
  const paths = new Set(
    attachments.flatMap((attachment) =>
      attachment.kind === "image" && attachment.ownership === "composer_temp"
        ? [attachment.path]
        : [],
    ),
  );
  const failures: unknown[] = [];
  for (const filePath of paths) {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (getErrnoCode(error) !== "ENOENT") failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Failed to release composer temporary attachments");
  }
}

export function releasePromptResources(input: PromptInput): Promise<void> {
  return releasePromptAttachments(input.attachments);
}
