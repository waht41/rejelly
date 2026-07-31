import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistMessageImageBlobs } from "../../shared/blobs/sessionBlobStore";
import { materializeActiveContext, parseStoredSessionMessage } from "./storedSessionMessage";

describe("storedSessionMessage", () => {
  let tmpDir: string;
  let blobRoot: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-stored-session-message-"));
    blobRoot = path.join(tmpDir, "blobs");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("validates the stored form and materializes referenced image blobs", async () => {
    const inline = `data:image/png;base64,${Buffer.from("image").toString("base64")}`;
    const stored = await persistMessageImageBlobs(
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", image: { url: inline, detail: "low" } },
        ],
      },
      { blobRoot },
    );
    const parsed = parseStoredSessionMessage(stored);

    await expect(materializeActiveContext([parsed], { blobRoot })).resolves.toMatchObject([
      {
        content: [
          { type: "text", text: "look" },
          { type: "image", image: { url: inline, detail: "low" } },
        ],
      },
    ]);
  });

  it("rejects inline images and blob locators without aligned metadata", async () => {
    const inline = `data:image/png;base64,${Buffer.from("image").toString("base64")}`;
    expect(() =>
      parseStoredSessionMessage({
        role: "user",
        content: [{ type: "image", image: { url: inline } }],
      }),
    ).toThrow("cannot contain inline image");

    const stored = await persistMessageImageBlobs(
      { role: "user", content: [{ type: "image", image: { url: inline } }] },
      { blobRoot },
    );
    expect(() =>
      parseStoredSessionMessage({
        ...stored,
        extra: { rejelly: { imageBlobs: {} } },
      }),
    ).toThrow("Missing metadata");
  });
});
