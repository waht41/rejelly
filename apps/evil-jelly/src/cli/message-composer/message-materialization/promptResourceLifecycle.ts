import fs from "node:fs/promises";
import { getErrnoCode } from "../../../shared/foundation/errno";
import type { PromptInput } from "../../../shared/model/prompt/promptInput";

/** Release only files explicitly owned by the submitted composer input. Safe to call repeatedly. */
export async function releaseConsumedPromptResources(input: PromptInput): Promise<void> {
  const paths = new Set(
    input.attachments.flatMap((attachment) =>
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
