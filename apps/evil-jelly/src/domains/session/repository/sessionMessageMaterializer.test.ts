import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Message } from "@rejelly/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_BLOB_SCHEME } from "../../../shared/session/blobContract";
import {
  persistMessageImageBlobs,
  persistSessionBlob,
  readSessionBlob,
} from "../journal/sessionBlobStore";
import { materializeMessageImageBlobs } from "./sessionMessageMaterializer";

function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe("sessionBlobStore", () => {
  let tmpDir: string;
  let blobRoot: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-session-blobs-"));
    blobRoot = path.join(tmpDir, "blobs");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("moves inline images into a durable content-addressed blob and materializes them", async () => {
    const bytes = pngHeader(640, 480);
    const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
    const message: Message = {
      role: "user",
      content: [
        { type: "text", text: "inspect" },
        { type: "image", image: { url: dataUrl, detail: "high" } },
      ],
      extra: { rejelly: { kind: "user_input" } },
    };

    const stored = await persistMessageImageBlobs(message, { blobRoot });
    expect(stored.content).toEqual([
      { type: "text", text: "inspect" },
      {
        type: "image",
        image: { url: expect.stringMatching(/^rejelly-blob:\/\/[a-f0-9]{64}$/), detail: "high" },
      },
    ]);
    const storedImage = Array.isArray(stored.content)
      ? stored.content.find((part) => part.type === "image")
      : undefined;
    if (!storedImage || storedImage.type !== "image") {
      throw new Error("Expected stored image content");
    }
    const blobRef = storedImage.image.url;
    expect(stored.extra?.rejelly).toMatchObject({
      kind: "user_input",
      imageBlobs: {
        [blobRef]: {
          blobRef: expect.stringMatching(/^rejelly-blob:\/\//),
          mediaType: "image/png",
          byteLength: bytes.length,
          width: 640,
          height: 480,
        },
      },
    });
    await expect(materializeMessageImageBlobs(stored, { blobRoot })).resolves.toMatchObject({
      content: [
        { type: "text", text: "inspect" },
        { type: "image", image: { url: dataUrl, detail: "high" } },
      ],
    });
  });

  it("deduplicates identical content", async () => {
    const bytes = pngHeader(1, 1);
    const first = await persistSessionBlob(bytes, "image/png", { blobRoot });
    const second = await persistSessionBlob(bytes, "image/png", { blobRoot });
    expect(second).toEqual(first);
    expect(await fs.readdir(blobRoot)).toEqual([first.sha256]);
  });

  it("leaves public image URLs unchanged", async () => {
    const message: Message = {
      role: "user",
      content: [{ type: "image", image: { url: "https://example.com/image.png" } }],
    };
    await expect(persistMessageImageBlobs(message, { blobRoot })).resolves.toBe(message);
  });

  it("materializes reordered images by blobRef instead of their former positions", async () => {
    const firstDataUrl = `data:image/png;base64,${Buffer.from("first").toString("base64")}`;
    const secondDataUrl = `data:image/jpeg;base64,${Buffer.from("second").toString("base64")}`;
    const message: Message = {
      role: "user",
      content: [
        { type: "image", image: { url: firstDataUrl } },
        { type: "image", image: { url: "https://example.com/public.png" } },
        { type: "image", image: { url: secondDataUrl } },
      ],
    };

    const stored = await persistMessageImageBlobs(message, { blobRoot });
    if (!Array.isArray(stored.content)) {
      throw new Error("Expected stored multipart content");
    }
    const reordered: Message = {
      ...stored,
      content: [stored.content[2]!, stored.content[1]!, stored.content[0]!],
    };

    await expect(materializeMessageImageBlobs(reordered, { blobRoot })).resolves.toMatchObject({
      content: [
        { type: "image", image: { url: secondDataUrl } },
        { type: "image", image: { url: "https://example.com/public.png" } },
        { type: "image", image: { url: firstDataUrl } },
      ],
    });
  });

  it("detects corrupted blobs instead of sending them to a provider", async () => {
    const blob = await persistSessionBlob(pngHeader(2, 3), "image/png", { blobRoot });
    await fs.writeFile(path.join(blobRoot, blob.sha256), "tampered");
    await expect(readSessionBlob(blob.blobRef, { blobRoot })).rejects.toThrow(
      "digest verification",
    );
  });

  it("rejects an internal locator without aligned media metadata", async () => {
    const bytes = pngHeader(2, 3);
    const blob = await persistSessionBlob(bytes, "image/png", { blobRoot });
    const message: Message = {
      role: "user",
      content: [{ type: "image", image: { url: blob.blobRef } }],
    };
    expect(blob.blobRef.startsWith(SESSION_BLOB_SCHEME)).toBe(true);
    await expect(materializeMessageImageBlobs(message, { blobRoot })).rejects.toThrow(
      "Missing image media type",
    );
  });

  it("rejects malformed image metadata loaded from storage", async () => {
    const blob = await persistSessionBlob(pngHeader(2, 3), "image/png", { blobRoot });
    const message: Message = {
      role: "user",
      content: [{ type: "image", image: { url: blob.blobRef } }],
      extra: {
        rejelly: {
          imageBlobs: {
            [blob.blobRef]: {
              ...blob,
              byteLength: "not-a-number",
            },
          },
        },
      },
    };

    await expect(materializeMessageImageBlobs(message, { blobRoot })).rejects.toThrow(
      "Invalid session image blob metadata",
    );
  });
});
