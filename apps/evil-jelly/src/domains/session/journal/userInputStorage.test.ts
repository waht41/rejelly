import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { materializeUserInput } from "../../../cli/message-composer/message-materialization/userMessage";
import {
  getWorkspaceFsPolicy,
  setWorkspaceRoot,
} from "../../../shared/fs-policy/workspace-fs-policy";
import { projectFrozenUserInputMessage } from "../../../shared/model/prompt/frozenUserInput";
import type { PromptInput } from "../../../shared/model/prompt/promptInput";
import { freezeResolvedUserInput } from "./userInputStorage";

describe("V3 user-input storage preparation", () => {
  let previousRoot: string;
  let tmpDir: string;

  beforeEach(async () => {
    previousRoot = getWorkspaceFsPolicy().getRoot();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-v3-user-input-"));
    setWorkspaceRoot(tmpDir);
  });

  afterEach(async () => {
    setWorkspaceRoot(previousRoot);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("persists image bytes before returning a clean stored materialization", async () => {
    const imagePath = path.join(tmpDir, "image.png");
    const bytes = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
    bytes.write("IHDR", 12, "ascii");
    bytes.writeUInt32BE(2, 16);
    bytes.writeUInt32BE(3, 20);
    await fs.writeFile(imagePath, bytes);
    const input: PromptInput = {
      document: [{ type: "token", kind: "image", attachmentId: "image-1" }],
      attachments: [
        {
          id: "image-1",
          kind: "image",
          path: imagePath,
          mimeType: "image/png",
          ownership: "borrowed",
        },
      ],
    };
    const resolved = await materializeUserInput(input);
    const frozen = await freezeResolvedUserInput(resolved, {
      blobRoot: path.join(tmpDir, "blobs"),
    });

    expect(projectFrozenUserInputMessage(frozen).content).toEqual([
      { type: "text", text: "[Image #1]" },
      expect.objectContaining({
        type: "image",
        image: expect.objectContaining({ url: expect.stringMatching(/^rejelly-blob:\/\//) }),
      }),
    ]);
    expect(frozen).toMatchObject({
      kind: "resolved",
      nodes: [{ kind: "image", blob: { blobRef: expect.stringMatching(/^rejelly-blob:\/\//) } }],
    });
  });

  it("keeps authored text directly in the frozen canonical record", async () => {
    const resolved = await materializeUserInput({
      document: [{ type: "text", text: "one" }],
      attachments: [],
    });
    await expect(freezeResolvedUserInput(resolved)).resolves.toEqual({
      version: 1,
      kind: "resolved",
      nodes: [{ kind: "text", text: "one" }],
    });
  });
});
