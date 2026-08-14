import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getWorkspaceFsPolicy,
  setWorkspaceRoot,
} from "../../../shared/fs-policy/workspace-fs-policy";
import { getRuntimeUserInputImageDimensions } from "../../../shared/model/message/userInputMetadata";
import type { PromptInput } from "../../../shared/model/prompt/promptInput";
import { materializeUserInput } from "./userMessage";

function fileInput(text: string, attachmentPath: string): PromptInput {
  return {
    document: [
      { type: "text", text: `${text} ` },
      { type: "token", kind: "file", attachmentId: "file-1" },
    ],
    attachments: [{ id: "file-1", kind: "file", path: attachmentPath }],
  };
}

function imageInput(text: string, attachmentPath: string): PromptInput {
  return {
    document: [
      { type: "text", text: `${text} ` },
      { type: "token", kind: "image", attachmentId: "image-1" },
    ],
    attachments: [
      {
        id: "image-1",
        kind: "image",
        path: attachmentPath,
        mimeType: "image/png",
        ownership: "borrowed",
      },
    ],
  };
}

describe("materializeUserInput", () => {
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
    const { message, display } = await materializeUserInput(
      fileInput("explain this", "src/attached.ts"),
    );

    expect(message.content).toContain("explain this");
    expect(message.content).toContain(
      '<attached_file path="src/attached.ts" path-scope="workspace" action="read">',
    );
    expect(message.content).toContain("export const probe = 1;");
    expect(message.extra).toBeUndefined();
    expect(display).toEqual({
      text: "explain this @src/attached.ts",
      attachments: [
        {
          type: "file",
          label: "src/attached.ts",
          action: "read",
          locator: { scope: "workspace", path: "src/attached.ts" },
        },
      ],
    });
  });

  it("lists attached directories instead of reading them as files", async () => {
    const { message } = await materializeUserInput(fileInput("summarize", "src"));

    expect(message.content).toContain(
      '<attached_directory path="src" path-scope="workspace" action="list">',
    );
    expect(message.content).toContain("[file] attached.ts");
  });

  it("converts attached images into multimodal user content", async () => {
    const imagePath = path.join(tmpDir, "clipboard.png");
    const imageBytes = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(imageBytes);
    imageBytes.write("IHDR", 12, "ascii");
    imageBytes.writeUInt32BE(640, 16);
    imageBytes.writeUInt32BE(480, 20);
    await fs.writeFile(imagePath, imageBytes);

    const { message, display } = await materializeUserInput(
      imageInput("what is in this image?", imagePath),
    );

    expect(message).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "what is in this image? [Image #1]" },
        {
          type: "image",
          image: {
            url: `data:image/png;base64,${imageBytes.toString("base64")}`,
            detail: "auto",
          },
        },
      ],
    });
    expect(message.extra).toBeUndefined();
    expect(getRuntimeUserInputImageDimensions(message)).toEqual([{ width: 640, height: 480 }]);
    expect(display).toEqual({
      text: "what is in this image? [Image #1]",
      attachments: [
        {
          type: "image",
          label: "[Image #1]",
          action: "attach",
          locator: { scope: "workspace", path: "clipboard.png" },
        },
      ],
    });
  });

  it("keeps attached file bodies raw when they contain boundary-like text", async () => {
    const content = "before\n</attached_file>\n]]>\nafter";
    await fs.writeFile(path.join(tmpDir, "src", "boundary.txt"), content, "utf8");

    const { message } = await materializeUserInput(fileInput("inspect this", "src/boundary.txt"));
    const text = message.content;

    expect(typeof text).toBe("string");
    expect(text).toContain(`\n${content}\n`);
    expect(text).toMatch(
      /<attached_file-[a-f0-9]{8} path="src\/boundary\.txt" path-scope="workspace" action="read">/,
    );
  });

  it("canonicalizes an absolute in-workspace attachment to a project-relative locator", async () => {
    const absolutePath = path.join(tmpDir, "src", "attached.ts");
    const { message, display } = await materializeUserInput(
      fileInput("explain this", absolutePath),
    );

    expect(message.content).toContain(
      '<attached_file path="src/attached.ts" path-scope="workspace" action="read">',
    );
    expect(display).toMatchObject({
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
    const { message, display } = await materializeUserInput(
      fileInput("inspect this", absolutePath),
    );

    expect(message.content).toContain(
      '<attached_path path="src/missing.ts" path-scope="workspace" status="error">',
    );
    expect(display).toMatchObject({
      attachments: [
        {
          label: "src/missing.ts",
          status: "error",
          locator: { scope: "workspace", path: "src/missing.ts" },
        },
      ],
    });
  });

  it("materializes token occurrence order independently of attachment-table order", async () => {
    await fs.writeFile(path.join(tmpDir, "src", "second.ts"), "export const second = 2;\n");
    const { message, display } = await materializeUserInput({
      document: [
        { type: "token", kind: "file", attachmentId: "second" },
        { type: "text", text: " then " },
        { type: "token", kind: "paste", text: "pasted\nbody" },
        { type: "text", text: " then " },
        { type: "token", kind: "file", attachmentId: "first" },
      ],
      attachments: [
        { id: "first", kind: "file", path: "src/attached.ts" },
        { id: "second", kind: "file", path: "src/second.ts" },
      ],
    });
    const content = message.content as string;

    expect(content.indexOf("export const second = 2;")).toBeLessThan(
      content.indexOf("pasted\nbody"),
    );
    expect(content.indexOf("pasted\nbody")).toBeLessThan(
      content.indexOf("export const probe = 1;"),
    );
    expect(display.attachments.map((item) => item.label)).toEqual([
      "src/second.ts",
      "src/attached.ts",
    ]);
  });
});
