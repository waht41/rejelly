import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getWorkspaceFsPolicy, setWorkspaceRoot } from "../fs-policy/workspace-fs-policy";
import {
  buildAttachmentActionSummary,
  buildConversationMessages,
  getUserInputDisplay,
} from "./messageContent";

describe("buildConversationMessages", () => {
  let prevRoot: string;
  let tmpDir: string;

  beforeEach(async () => {
    prevRoot = getWorkspaceFsPolicy().getRoot();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-jelly-attachments-"));
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src", "attached.ts"), "export const probe = 1;\n");
    setWorkspaceRoot(tmpDir);
  });

  afterEach(async () => {
    setWorkspaceRoot(prevRoot);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("injects explicitly attached file contents into the current user turn", async () => {
    const messages = await buildConversationMessages({
      userInput: "explain this",
      attachments: [{ type: "file", path: "src/attached.ts" }],
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("explain this");
    expect(messages[0]?.content).toContain(
      '<attached_file path="src/attached.ts" path-scope="workspace" action="read">',
    );
    expect(messages[0]?.content).toContain("export const probe = 1;");
    expect(messages[0]?.extra).toEqual({
      rejelly: {
        kind: "user_input",
        display: {
          text: "explain this",
          attachments: [
            {
              type: "file",
              label: "src/attached.ts",
              action: "read",
              locator: { scope: "workspace", path: "src/attached.ts" },
            },
          ],
        },
      },
    });
  });

  it("lists attached directories instead of reading them as files", async () => {
    const messages = await buildConversationMessages({
      userInput: "summarize @src",
      attachments: [{ type: "file", path: "src" }],
    });

    expect(messages[0]?.content).toContain(
      '<attached_directory path="src" path-scope="workspace" action="list">',
    );
    expect(messages[0]?.content).toContain("[file] attached.ts");
  });

  it("converts attached images into multimodal user content", async () => {
    const imagePath = path.join(tmpDir, "clipboard.png");
    const imageBytes = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(imageBytes);
    imageBytes.write("IHDR", 12, "ascii");
    imageBytes.writeUInt32BE(640, 16);
    imageBytes.writeUInt32BE(480, 20);
    await fs.writeFile(imagePath, imageBytes);

    const messages = await buildConversationMessages({
      userInput: "what is in this image?",
      attachments: [{ type: "image", path: imagePath, mimeType: "image/png" }],
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "what is in this image?" },
        {
          type: "image",
          image: {
            url: `data:image/png;base64,${imageBytes.toString("base64")}`,
            detail: "auto",
          },
        },
      ],
      extra: {
        rejelly: {
          kind: "user_input",
          imageDimensions: [{ width: 640, height: 480 }],
          display: {
            text: "what is in this image?",
            attachments: [
              {
                type: "image",
                label: "[Image #1]",
                action: "attach",
                locator: {
                  scope: "workspace",
                  path: "clipboard.png",
                },
              },
            ],
          },
        },
      },
    });
  });

  it("keeps attached file bodies raw when they contain boundary-like text", async () => {
    const content = "before\n</attached_file>\n]]>\nafter";
    await fs.writeFile(path.join(tmpDir, "src", "boundary.txt"), content, "utf8");

    const messages = await buildConversationMessages({
      userInput: "inspect this",
      attachments: [{ type: "file", path: "src/boundary.txt" }],
    });
    const text = messages[0]?.content;

    expect(typeof text).toBe("string");
    expect(text).toContain(`\n${content}\n`);
    expect(text).toMatch(
      /<attached_file-[a-f0-9]{8} path="src\/boundary\.txt" path-scope="workspace" action="read">/,
    );
  });

  it("canonicalizes an absolute in-workspace attachment to a project-relative locator", async () => {
    const absolutePath = path.join(tmpDir, "src", "attached.ts");
    const messages = await buildConversationMessages({
      userInput: "explain this",
      attachments: [{ type: "file", path: absolutePath }],
    });

    expect(messages[0]?.content).toContain(
      '<attached_file path="src/attached.ts" path-scope="workspace" action="read">',
    );
    expect(getUserInputDisplay(messages[0]!)).toMatchObject({
      attachments: [
        {
          label: "src/attached.ts",
          locator: { scope: "workspace", path: "src/attached.ts" },
        },
      ],
    });
  });

  it("keeps a canonical locator when an in-workspace attachment is missing", async () => {
    const absolutePath = path.join(tmpDir, "src", "missing.ts");
    const messages = await buildConversationMessages({
      userInput: "inspect this",
      attachments: [{ type: "file", path: absolutePath }],
    });

    expect(messages[0]?.content).toContain(
      '<attached_path path="src/missing.ts" path-scope="workspace" status="error">',
    );
    expect(getUserInputDisplay(messages[0]!)).toMatchObject({
      attachments: [
        {
          label: "src/missing.ts",
          status: "error",
          locator: { scope: "workspace", path: "src/missing.ts" },
        },
      ],
    });
  });

  it("summarizes visible attachment actions for the CLI history", async () => {
    await expect(
      buildAttachmentActionSummary([
        { type: "file", path: "src/attached.ts" },
        { type: "file", path: "src" },
      ]),
    ).resolves.toEqual(["read src/attached.ts", "list src"]);
  });

  it("summarizes image attachments for the CLI history", async () => {
    await expect(
      buildAttachmentActionSummary([{ type: "image", path: "clipboard.png" }]),
    ).resolves.toEqual(["attach [Image #1]"]);
  });

  it("rejects malformed persisted display metadata", () => {
    expect(
      getUserInputDisplay({
        role: "user",
        content: "raw fallback",
        extra: {
          rejelly: {
            kind: "user_input",
            display: {
              text: "shown text",
              attachments: [{ type: "file", label: "a.ts", action: "unknown" }],
            },
          },
        },
      }),
    ).toBeUndefined();
  });
});
