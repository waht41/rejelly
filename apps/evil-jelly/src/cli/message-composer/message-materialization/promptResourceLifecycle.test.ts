import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PromptInput } from "../../../shared/model/prompt/promptInput";
import { releaseConsumedPromptResources } from "./promptResourceLifecycle";

describe("submitted prompt resource lifecycle", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("deletes composer-owned images idempotently without touching borrowed paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "evil-prompt-resource-"));
    roots.push(root);
    const temporary = path.join(root, "clipboard.png");
    const borrowed = path.join(root, "user.png");
    await Promise.all([fs.writeFile(temporary, "temp"), fs.writeFile(borrowed, "user")]);
    const input: PromptInput = {
      document: [
        { type: "token", kind: "image", attachmentId: "temp" },
        { type: "token", kind: "image", attachmentId: "borrowed" },
      ],
      attachments: [
        {
          id: "temp",
          kind: "image",
          path: temporary,
          mimeType: "image/png",
          ownership: "composer_temp",
        },
        {
          id: "borrowed",
          kind: "image",
          path: borrowed,
          mimeType: "image/png",
          ownership: "borrowed",
        },
      ],
    };

    await releaseConsumedPromptResources(input);
    await releaseConsumedPromptResources(input);

    await expect(fs.access(temporary)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(borrowed, "utf8")).resolves.toBe("user");
  });
});
