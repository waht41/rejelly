import { describe, expect, it } from "vitest";
import type { PromptDocument } from "../../../shared/model/prompt/promptDocument";
import {
  decodeStoredPromptDocumentV1,
  encodeStoredPromptDocumentV1,
  parseStoredPromptInputV1,
} from "./storedPromptInput";

const imageBlobRef = `rejelly-blob://${"a".repeat(64)}`;

describe("stored prompt input V1 contract", () => {
  it("round-trips the five semantic node kinds", () => {
    const document: PromptDocument = [
      { type: "text", text: "review " },
      { type: "token", kind: "skill", qualifiedName: "project:review" },
      { type: "token", kind: "paste", text: "full paste" },
      { type: "token", kind: "file", attachmentId: "file-1" },
      { type: "token", kind: "image", attachmentId: "image-1" },
    ];

    const stored = encodeStoredPromptDocumentV1(document);

    expect(stored).toEqual({ version: 1, nodes: document });
    expect(decodeStoredPromptDocumentV1(stored)).toEqual(document);
  });

  it("rejects UI-only fields instead of persisting an editor snapshot", () => {
    expect(() =>
      decodeStoredPromptDocumentV1({
        version: 1,
        nodes: [
          {
            type: "token",
            kind: "skill",
            qualifiedName: "project:review",
            id: "skill-1",
            displayText: "$review",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects non-canonical or blank stored document values", () => {
    expect(() =>
      decodeStoredPromptDocumentV1({
        version: 1,
        nodes: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    ).toThrow("must merge adjacent text nodes");
    expect(() =>
      decodeStoredPromptDocumentV1({
        version: 1,
        nodes: [{ type: "token", kind: "skill", qualifiedName: "  " }],
      }),
    ).toThrow();
  });

  it("validates durable attachment references and image metadata", () => {
    const parsed = parseStoredPromptInputV1({
      document: {
        version: 1,
        nodes: [
          { type: "token", kind: "file", attachmentId: "file-1" },
          { type: "token", kind: "image", attachmentId: "image-1" },
        ],
      },
      attachments: [
        { version: 1, id: "file-1", kind: "file", path: "src/main.ts" },
        {
          version: 1,
          id: "image-1",
          kind: "image",
          blobRef: imageBlobRef,
          mediaType: "image/png",
          byteLength: 24,
          width: 20,
          height: 10,
          detail: "high",
        },
      ],
    });

    expect(parsed.attachments).toHaveLength(2);
  });

  it("rejects missing, mismatched, duplicate, and orphan attachments", () => {
    const document = {
      version: 1,
      nodes: [{ type: "token", kind: "image", attachmentId: "image-1" }],
    };

    expect(() => parseStoredPromptInputV1({ document, attachments: [] })).toThrow();
    expect(() =>
      parseStoredPromptInputV1({
        document,
        attachments: [{ version: 1, id: "image-1", kind: "file", path: "image.png" }],
      }),
    ).toThrow();
    expect(() =>
      parseStoredPromptInputV1({
        document,
        attachments: [
          {
            version: 1,
            id: "image-1",
            kind: "image",
            blobRef: imageBlobRef,
            mediaType: "image/png",
            byteLength: 24,
          },
          {
            version: 1,
            id: "image-1",
            kind: "image",
            blobRef: imageBlobRef,
            mediaType: "image/png",
            byteLength: 24,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseStoredPromptInputV1({
        document,
        attachments: [
          {
            version: 1,
            id: "image-1",
            kind: "image",
            blobRef: imageBlobRef,
            mediaType: "image/png",
            byteLength: 24,
          },
          { version: 1, id: "file-1", kind: "file", path: "src/main.ts" },
        ],
      }),
    ).toThrow();
  });
});
