import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetComposerSession, useComposerSession } from "./composerSession";

describe("composer session bridge", () => {
  const roots: string[] = [];
  beforeEach(resetComposerSession);
  afterEach(async () => {
    resetComposerSession();
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("forwards a materialized draft without owning its state", () => {
    const received: unknown[] = [];
    useComposerSession.getState().setBackgroundLineHandler((value) => received.push(value));
    const input = {
      document: [
        { type: "token" as const, kind: "skill" as const, qualifiedName: "project:review" },
        { type: "text" as const, text: " inspect " },
        { type: "token" as const, kind: "file" as const, attachmentId: "file-1" },
      ],
      attachments: [{ id: "file-1", kind: "file" as const, path: "src/a.ts" }],
    };

    useComposerSession.getState().submitLine(input);

    expect(received).toEqual([input]);
  });

  it("sorts available skills for the composer", () => {
    useComposerSession.getState().setAvailableSkills([
      { qualifiedName: "project:z", name: "z", scope: "project", description: "z" },
      { qualifiedName: "project:a", name: "a", scope: "project", description: "a" },
    ]);

    expect(
      useComposerSession.getState().availableSkills.map((skill) => skill.qualifiedName),
    ).toEqual(["project:a", "project:z"]);
  });

  it("sorts available MCP servers for the shared reference picker", () => {
    useComposerSession
      .getState()
      .setAvailableMcpServers([{ serverId: "zeta" }, { serverId: "docs" }]);

    expect(
      useComposerSession.getState().availableMcpServers.map((server) => server.serverId),
    ).toEqual(["docs", "zeta"]);
  });

  it("sorts user Memories before project Memories for the shared reference picker", () => {
    useComposerSession.getState().setAvailableMemories([
      { id: "mem_project", scope: "project", title: "A", summary: "Project" },
      { id: "mem_user", scope: "user", title: "Z", summary: "User" },
    ]);

    expect(useComposerSession.getState().availableMemories.map((memory) => memory.id)).toEqual([
      "mem_user",
      "mem_project",
    ]);
  });

  it("releases a pending composer-owned draft when a newer seed replaces it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "evil-draft-seed-cleanup-"));
    roots.push(root);
    const imagePath = path.join(root, "clipboard.png");
    await fs.writeFile(imagePath, "image");
    useComposerSession.getState().seedDraft({
      document: [{ type: "token", kind: "image", attachmentId: "image-1" }],
      attachments: [
        {
          id: "image-1",
          kind: "image",
          path: imagePath,
          mimeType: "image/png",
          ownership: "composer_temp",
        },
      ],
    });

    useComposerSession
      .getState()
      .seedDraft({ document: [{ type: "text", text: "new" }], attachments: [] });

    await vi.waitFor(async () => {
      await expect(fs.access(imagePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
