import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freezeResolvedUserInput } from "../../../domains/session/journal/userInputStorage";
import { getWorkspaceRoot, setWorkspaceRoot } from "../../../shared/fs-policy/workspace-context";
import {
  frozenUserInputImageDimensions,
  projectFrozenUserInputDisplay,
  projectFrozenUserInputMessage,
} from "../../../shared/model/prompt/frozenUserInput";
import type { PromptInput } from "../../../shared/model/prompt/promptInput";
import { materializeUserInput as resolveUserInput } from "./userMessage";

let blobRoot = "";

async function materializeUserInput(input: PromptInput) {
  const frozen = await freezeResolvedUserInput(await resolveUserInput(input), { blobRoot });
  return {
    frozen,
    message: projectFrozenUserInputMessage(frozen),
    display: projectFrozenUserInputDisplay(frozen),
  };
}

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
    prevRoot = getWorkspaceRoot();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-jelly-attachments-"));
    blobRoot = path.join(tmpDir, "blobs");
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
            url: expect.stringMatching(/^rejelly-blob:\/\//),
            detail: "auto",
          },
        },
      ],
    });
    expect(message.extra).toBeUndefined();
    const frozen = await freezeResolvedUserInput(
      await resolveUserInput(imageInput("x", imagePath)),
      {
        blobRoot,
      },
    );
    expect(frozenUserInputImageDimensions(frozen)).toEqual([{ width: 640, height: 480 }]);
    expect(display).toEqual({
      text: "what is in this image? [Image #1]",
      attachments: [
        {
          type: "image",
          label: "[Image #1]",
          action: "attach",
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

  it("freezes MCP identity and non-secret resolution without parsing display text", async () => {
    const resolved = await resolveUserInput(
      {
        document: [
          { type: "text", text: "plain $mcp:fake " },
          { type: "token", kind: "mcp", serverId: "docs" },
        ],
        attachments: [],
      },
      {
        mcpResolution: () => ({
          status: "selected",
          configFingerprint: "config-1",
          referenceName: "docs",
        }),
      },
    );
    const frozen = await freezeResolvedUserInput(resolved, { blobRoot });

    expect(frozen.nodes).toEqual([
      { kind: "text", text: "plain $mcp:fake " },
      {
        kind: "mcp",
        serverId: "docs",
        referenceName: "docs",
        status: "selected",
        configFingerprint: "config-1",
      },
    ]);
    expect(projectFrozenUserInputMessage(frozen).content).toContain(
      '<selected_mcp server="docs" status="selected" />',
    );
    expect(projectFrozenUserInputDisplay(frozen).text).toBe("plain $mcp:fake $mcp:docs");
  });

  it("resolves an explicitly selected Memory detail once and freezes it into the user turn", async () => {
    const memoryId = "mem_afe761ca-6383-43e6-8429-445362848d0c";
    let reads = 0;
    const resolved = await resolveUserInput(
      {
        document: [
          { type: "text", text: "apply " },
          { type: "token", kind: "memory", memoryId },
          { type: "text", text: " and " },
          { type: "token", kind: "memory", memoryId },
        ],
        attachments: [],
      },
      {
        memoryResolution: async () => {
          reads += 1;
          return {
            status: "resolved",
            scope: "project",
            revision: 2,
            title: "Squash message",
            summary: "Use the PR description as the squash message.",
            detail: "Keep it suitable for a final commit message.",
            referenceName: "Squash message",
          };
        },
      },
    );
    const frozen = await freezeResolvedUserInput(resolved, { blobRoot });
    const message = projectFrozenUserInputMessage(frozen);

    expect(reads).toBe(1);
    expect(projectFrozenUserInputDisplay(frozen).text).toBe(
      "apply $memory:Squash message and $memory:Squash message",
    );
    expect(message.content).toContain('<explicit_memories count="1">');
    expect(message.content).toContain("Keep it suitable for a final commit message.");
    expect(message.content).not.toContain("provenance");
  });

  it("freezes an unavailable selected Memory without stale detail", async () => {
    const memoryId = "mem_afe761ca-6383-43e6-8429-445362848d0c";
    const resolved = await resolveUserInput(
      {
        document: [{ type: "token", kind: "memory", memoryId }],
        attachments: [],
      },
      { memoryResolution: () => ({ status: "unavailable" }) },
    );
    const frozen = await freezeResolvedUserInput(resolved, { blobRoot });

    expect(projectFrozenUserInputMessage(frozen).content).toContain(
      `<memory_reference id="${memoryId}" status="unavailable" />`,
    );
  });
});
