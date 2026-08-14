import { describe, expect, it } from "vitest";
import { parseStoredUserInputMaterializationV1 } from "./storedUserInputMaterialization";

const sha256 = "a".repeat(64);
const blobRef = `rejelly-blob://${sha256}`;
const blob = {
  blobRef,
  sha256,
  mediaType: "image/png",
  byteLength: 24,
  width: 2,
  height: 3,
};

describe("stored user-input materialization V1", () => {
  it("accepts a clean frozen image message with sidecar resolution metadata", () => {
    expect(
      parseStoredUserInputMaterializationV1({
        version: 1,
        message: {
          role: "user",
          content: [{ type: "image", image: { url: blobRef, detail: "high" } }],
        },
        display: { text: "[Image #1]", attachments: [] },
        resolutions: [
          {
            version: 1,
            nodeOrdinal: 0,
            kind: "image",
            attachmentId: "image-1",
            status: "resolved",
            mediaType: "image/png",
            detail: "high",
            blob,
          },
        ],
      }),
    ).toMatchObject({ version: 1, resolutions: [{ kind: "image", blob: { blobRef } }] });
  });

  it("rejects inline images, missing blob sidecars, and Message.extra input metadata", () => {
    const base = {
      version: 1,
      display: { text: "image", attachments: [] },
      resolutions: [],
    };
    expect(() =>
      parseStoredUserInputMaterializationV1({
        ...base,
        message: {
          role: "user",
          content: [{ type: "image", image: { url: "data:image/png;base64,AA==" } }],
        },
      }),
    ).toThrow();
    expect(() =>
      parseStoredUserInputMaterializationV1({
        ...base,
        message: { role: "user", content: [{ type: "image", image: { url: blobRef } }] },
      }),
    ).toThrow();
    expect(() =>
      parseStoredUserInputMaterializationV1({
        ...base,
        message: {
          role: "user",
          content: "text",
          extra: { rejelly: { kind: "user_input", display: base.display } },
        },
      }),
    ).toThrow(/must live beside/);
  });
});
