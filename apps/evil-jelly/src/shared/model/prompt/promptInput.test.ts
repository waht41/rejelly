import { describe, expect, it } from "vitest";
import {
  isPromptDocumentSemanticallyEmpty,
  normalizePromptDocument,
  type PromptDocument,
  promptDocumentCommandText,
  promptDocumentLogicalLength,
} from "./promptDocument";
import {
  assertValidPromptInput,
  isPromptInputSemanticallyEmpty,
  normalizePromptInput,
  type PromptInput,
  promptInputCommandText,
  promptInputCopyText,
  promptInputPlainText,
  textPromptInput,
} from "./promptInput";

const richInput: PromptInput = {
  document: [
    { type: "text", text: "review " },
    { type: "token", kind: "skill", qualifiedName: "project:review" },
    { type: "text", text: "\n" },
    { type: "token", kind: "paste", text: "pasted\nbody" },
    { type: "text", text: " " },
    { type: "token", kind: "file", attachmentId: "file-1" },
    { type: "text", text: " " },
    { type: "token", kind: "image", attachmentId: "image-1" },
  ],
  attachments: [
    { id: "file-1", kind: "file", path: "src/main.ts" },
    {
      id: "image-1",
      kind: "image",
      path: "C:/temp/clipboard.png",
      mimeType: "image/png",
      ownership: "composer_temp",
    },
  ],
};

describe("prompt document contract", () => {
  it("normalizes text without flattening semantic tokens", () => {
    const document = normalizePromptDocument([
      { type: "text", text: "a" },
      { type: "text", text: "" },
      { type: "text", text: "b" },
      { type: "token", kind: "skill", qualifiedName: "project:review" },
      { type: "text", text: "c" },
    ]);

    expect(document).toEqual([
      { type: "text", text: "ab" },
      { type: "token", kind: "skill", qualifiedName: "project:review" },
      { type: "text", text: "c" },
    ]);
    expect(promptDocumentLogicalLength(document)).toBe(4);
  });

  it("treats every token as semantic input and recognizes commands only from text", () => {
    expect(isPromptDocumentSemanticallyEmpty([{ type: "text", text: " \n " }])).toBe(true);
    expect(
      isPromptDocumentSemanticallyEmpty([
        { type: "token", kind: "skill", qualifiedName: "project:review" },
      ]),
    ).toBe(false);
    expect(promptDocumentCommandText([{ type: "text", text: " /status " }])).toBe(" /status ");
    expect(promptDocumentCommandText(richInput.document)).toBeUndefined();
  });
});

describe("prompt input contract", () => {
  it("provides an explicit text-only adapter", () => {
    const input = textPromptInput("hello");

    expect(input).toEqual({ document: [{ type: "text", text: "hello" }], attachments: [] });
    expect(promptInputCommandText(input)).toBe("hello");
    expect(isPromptInputSemanticallyEmpty(input)).toBe(false);
  });

  it("keeps plain and copy fallback projections explicit and lossy", () => {
    const expected = "review $project:review\npasted\nbody @src/main.ts [Image]";

    expect(promptInputPlainText(richInput)).toBe(expected);
    expect(promptInputCopyText(richInput)).toBe(expected);
    expect(promptInputCommandText(richInput)).toBeUndefined();
  });

  it("validates attachment identity, kind, and reachability", () => {
    expect(() => assertValidPromptInput(richInput)).not.toThrow();

    expect(() =>
      assertValidPromptInput({
        document: richInput.document,
        attachments: richInput.attachments.slice(1),
      }),
    ).toThrow("Missing file attachment: file-1");
    expect(() =>
      assertValidPromptInput({
        document: [{ type: "token", kind: "file", attachmentId: "image-1" }],
        attachments: richInput.attachments.slice(1),
      }),
    ).toThrow("expects file attachment image-1, received image");
    expect(() =>
      assertValidPromptInput({
        document: [],
        attachments: [{ id: "file-1", kind: "file", path: "src/main.ts" }],
      }),
    ).toThrow("Unreferenced prompt attachment: file-1");
  });

  it("rejects non-canonical documents and blank attachment locators", () => {
    expect(() =>
      assertValidPromptInput({
        document: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
        attachments: [],
      }),
    ).toThrow("must merge adjacent text nodes");
    expect(() =>
      assertValidPromptInput({
        document: [{ type: "token", kind: "file", attachmentId: "file-1" }],
        attachments: [{ id: "file-1", kind: "file", path: "  " }],
      }),
    ).toThrow("file attachment path must not be empty");
  });

  it("normalizes only the document and preserves attachment identity", () => {
    const document: PromptDocument = [
      { type: "text", text: "a" },
      { type: "text", text: "b" },
      { type: "token", kind: "file", attachmentId: "file-1" },
    ];
    const attachments = [{ id: "file-1", kind: "file" as const, path: "src/main.ts" }];
    const normalized = normalizePromptInput({ document, attachments });

    expect(normalized.document).toEqual([
      { type: "text", text: "ab" },
      { type: "token", kind: "file", attachmentId: "file-1" },
    ]);
    expect(normalized.attachments).toBe(attachments);
  });
});
