import { describe, expect, it } from "vitest";
import type { PromptInput } from "../../shared/model/prompt/promptInput";
import { hydrateLegacyAttachments, materializeLegacyPromptInput } from "./legacyPromptInput";

describe("legacy PromptInput compatibility", () => {
  it("hydrates legacy file and image markers into semantic tokens", () => {
    let nextId = 1;
    const result = hydrateLegacyAttachments(
      [
        { type: "text", text: "review @src/main.ts with " },
        { type: "token", kind: "skill", qualifiedName: "project:review" },
        { type: "text", text: " and [Image #1]" },
      ],
      [
        { type: "file", path: "src/main.ts" },
        { type: "image", path: "C:/tmp/paste.png", mimeType: "image/png", detail: "high" },
      ],
      () => `attachment-${nextId++}`,
    );

    expect(result.document).toEqual([
      { type: "text", text: "review " },
      { type: "token", kind: "file", attachmentId: "attachment-1" },
      { type: "text", text: " with " },
      { type: "token", kind: "skill", qualifiedName: "project:review" },
      { type: "text", text: " and " },
      { type: "token", kind: "image", attachmentId: "attachment-2" },
    ]);
    expect(result.attachments).toEqual([
      { id: "attachment-1", kind: "file", path: "src/main.ts" },
      {
        id: "attachment-2",
        kind: "image",
        path: "C:/tmp/paste.png",
        mimeType: "image/png",
        detail: "high",
        ownership: "borrowed",
      },
    ]);
  });

  it("appends structured legacy attachments whose display marker is missing", () => {
    const result = hydrateLegacyAttachments(
      [{ type: "text", text: "review this" }],
      [{ type: "file", path: "src/unmarked.ts" }],
      () => "file-1",
    );

    expect(result.document).toEqual([
      { type: "text", text: "review this " },
      { type: "token", kind: "file", attachmentId: "file-1" },
    ]);
    expect(result.attachments).toEqual([{ id: "file-1", kind: "file", path: "src/unmarked.ts" }]);
  });

  it("prefers the longest file marker when paths share a prefix", () => {
    let nextId = 1;
    const result = hydrateLegacyAttachments(
      [{ type: "text", text: "@src/main.ts" }],
      [
        { type: "file", path: "src/main" },
        { type: "file", path: "src/main.ts" },
      ],
      () => `file-${nextId++}`,
    );

    expect(result.document[0]).toEqual({ type: "token", kind: "file", attachmentId: "file-1" });
    expect(result.attachments[0]).toMatchObject({ kind: "file", path: "src/main.ts" });
  });

  it("expands paste bodies and orders legacy attachments by token occurrence", () => {
    const input: PromptInput = {
      document: [
        { type: "text", text: "check " },
        { type: "token", kind: "paste", text: "line 1\nline 2" },
        { type: "text", text: " against " },
        { type: "token", kind: "file", attachmentId: "file-1" },
        { type: "text", text: " and " },
        { type: "token", kind: "image", attachmentId: "image-1" },
      ],
      attachments: [
        {
          id: "image-1",
          kind: "image",
          path: "C:/tmp/paste.png",
          mimeType: "image/png",
          ownership: "composer_temp",
        },
        { id: "file-1", kind: "file", path: "src/main.ts" },
      ],
    };

    expect(
      materializeLegacyPromptInput(input, (token) =>
        token.kind === "file" ? "@src/main.ts" : "[Image #1]",
      ),
    ).toEqual({
      text: "check line 1\nline 2 against @src/main.ts and [Image #1]",
      attachments: [
        { type: "file", path: "src/main.ts" },
        { type: "image", path: "C:/tmp/paste.png", mimeType: "image/png" },
      ],
    });
  });
});
