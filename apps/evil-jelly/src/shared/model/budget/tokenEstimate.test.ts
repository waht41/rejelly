import type { Message } from "@rejelly/core";
import { describe, expect, it } from "vitest";
import {
  type FrozenResolvedUserInputV1,
  registerFrozenUserInputOrigin,
} from "../prompt/frozenUserInput";
import {
  estimateMessagesTokens,
  IMAGE_CONTENT_TOKEN_ESTIMATE,
  LOW_DETAIL_IMAGE_TOKEN_ESTIMATE,
} from "./tokenEstimate";

function imageMessage(options: {
  detail?: "auto" | "low" | "high";
  width?: number;
  height?: number;
}): Message {
  const { width, height, detail } = options;
  const message: Message = {
    role: "user",
    content: [{ type: "image", image: { url: "data:image/png;base64,x", detail } }],
  };
  if (width !== undefined && height !== undefined) {
    const input: FrozenResolvedUserInputV1 = {
      version: 1,
      kind: "resolved",
      nodes: [
        {
          kind: "image",
          detail: detail ?? "auto",
          blob: {
            blobRef: `rejelly-blob://${"a".repeat(64)}` as never,
            sha256: "a".repeat(64),
            mediaType: "image/png",
            byteLength: 1,
            width,
            height,
          },
        },
      ],
    };
    registerFrozenUserInputOrigin(message, input);
  }
  return message;
}

describe("image token estimation", () => {
  it("uses a fixed lower estimate for low-detail images", () => {
    expect(
      estimateMessagesTokens([imageMessage({ detail: "low", width: 4000, height: 3000 })]),
    ).toBe(LOW_DETAIL_IMAGE_TOKEN_ESTIMATE);
  });

  it("uses conservative dimension tiers for auto/high-detail images", () => {
    expect(estimateMessagesTokens([imageMessage({ width: 512, height: 512 })])).toBe(1024);
    expect(estimateMessagesTokens([imageMessage({ width: 1024, height: 768 })])).toBe(2048);
    expect(estimateMessagesTokens([imageMessage({ width: 1025, height: 100 })])).toBe(
      IMAGE_CONTENT_TOKEN_ESTIMATE,
    );
  });

  it("falls back to the conservative estimate when dimensions are unavailable", () => {
    expect(estimateMessagesTokens([imageMessage({ detail: "auto" })])).toBe(
      IMAGE_CONTENT_TOKEN_ESTIMATE,
    );
  });

  it("reads dimensions from a tool-style data URL when message metadata is unavailable", () => {
    const bytes = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
    bytes.write("IHDR", 12, "ascii");
    bytes.writeUInt32BE(400, 16);
    bytes.writeUInt32BE(300, 20);
    const message: Message = {
      role: "tool",
      tool_call_id: "image",
      content: [
        {
          type: "image",
          image: { url: `data:image/png;base64,${bytes.toString("base64")}` },
        },
      ],
    };

    expect(estimateMessagesTokens([message])).toBe(1024);
  });
});
