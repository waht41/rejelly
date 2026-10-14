import { createHash } from "node:crypto";
import {
  ATTACHMENTS_API_PATH,
  attachmentUploadResponseSchema,
  getAttachmentHash,
} from "@rejelly/devtool-contracts";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as imageUploads from "../../../capabilities/trace-attachments/images";
import { MAX_ATTACHMENT_BYTES } from "../../../capabilities/trace-attachments/images";
import { db, schema } from "../../../db/drizzle";
import { buildServer } from "../../../server/server";

let app: FastifyInstance;
let png: Buffer;

beforeAll(async () => {
  app = await buildServer();
  app.log.level = "silent";
  await app.ready();
  png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
    .png()
    .toBuffer();
});
beforeEach(() => db.delete(schema.traceAttachments).run());
afterAll(async () => app?.close());

function upload(payload: Buffer, contentType = "image/png") {
  return app.inject({
    method: "POST",
    url: ATTACHMENTS_API_PATH,
    headers: { "content-type": contentType },
    payload,
  });
}

function attachmentRows() {
  return db
    .select({
      hash: schema.traceAttachments.hash,
      byteSize: schema.traceAttachments.byteSize,
      storageType: sql<string>`typeof(${schema.traceAttachments.data})`,
    })
    .from(schema.traceAttachments)
    .all();
}

describe("image attachment protocol", () => {
  it("stores original bytes as a deduplicated SQLite BLOB and returns a stable reference", async () => {
    const response = await upload(png);
    expect(response.statusCode).toBe(200);
    const result = attachmentUploadResponseSchema.parse(response.json());
    const hash = createHash("sha256").update(png).digest("hex");
    expect(result).toEqual({
      id: `sha256:${hash}`,
      url: `attachment://sha256/${hash}`,
      mimeType: "image/png",
      byteSize: png.length,
    });
    expect(getAttachmentHash(result.url)).toBe(hash);
    expect(attachmentRows()).toEqual([{ hash, byteSize: png.length, storageType: "blob" }]);

    const duplicate = await upload(png);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toEqual(result);
    expect(attachmentRows()).toHaveLength(1);

    const read = await app.inject({ url: `${ATTACHMENTS_API_PATH}/${hash}` });
    expect(read.statusCode).toBe(200);
    expect(read.rawPayload.equals(png)).toBe(true);
    expect(read.headers["content-type"]).toBe("image/png");
    expect(read.headers["content-length"]).toBe(String(png.length));
    expect(read.headers["x-content-type-options"]).toBe("nosniff");
    expect(read.headers.etag).toBe(`"${hash}"`);
    expect(read.headers["cache-control"]).toContain("private");

    for (const tag of [`"${hash}"`, `W/"${hash}"`, `"other", "${hash}"`, "*"]) {
      const cached = await app.inject({
        url: `${ATTACHMENTS_API_PATH}/${hash}`,
        headers: { "if-none-match": tag },
      });
      expect(cached.statusCode).toBe(304);
      expect(cached.rawPayload.length).toBe(0);
    }
    const head = await app.inject({ method: "HEAD", url: `${ATTACHMENTS_API_PATH}/${hash}` });
    expect(head.statusCode).toBe(200);
    expect(head.rawPayload.length).toBe(0);
    expect(head.headers["content-length"]).toBe(String(png.length));
  });

  it("deduplicates simultaneous uploads", async () => {
    const results = await Promise.all([upload(png), upload(png)]);
    expect(results.map((result) => result.statusCode)).toEqual([200, 200]);
    expect(results[0].json()).toEqual(results[1].json());
    expect(attachmentRows()).toHaveLength(1);
  });

  it("bounds concurrent image decoding and releases capacity after completion", async () => {
    let release: (value: "image/png") => void;
    const validation = new Promise<"image/png">((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(imageUploads, "validateImageUpload").mockReturnValue(validation);
    const pending = [upload(png), upload(png)];
    try {
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
      const busy = await upload(png);
      expect(busy.statusCode).toBe(503);
      expect(busy.headers["retry-after"]).toBe("1");
    } finally {
      release!("image/png");
      await Promise.all(pending);
      spy.mockRestore();
    }
    expect((await upload(png)).statusCode).toBe(200);
  });

  it.each([
    "jpeg",
    "webp",
    "gif",
  ] as const)("accepts and serves %s without re-encoding", async (format) => {
    const bytes = await sharp({ create: { width: 3, height: 3, channels: 3, background: "blue" } })
      .toFormat(format)
      .toBuffer();
    const response = await upload(bytes, `image/${format}`);
    expect(response.statusCode).toBe(200);
    const result = response.json();
    const read = await app.inject({
      url: `${ATTACHMENTS_API_PATH}/${getAttachmentHash(result.url)}`,
    });
    expect(read.rawPayload.equals(bytes)).toBe(true);
    expect(read.headers["content-type"]).toBe(`image/${format}`);
  });

  it("handles a binary PNG body with Content-Type parameters", async () => {
    expect((await upload(png, "image/png; charset=binary")).statusCode).toBe(200);
  });

  it("rejects MIME mismatches, corrupt files and empty bodies without storing anything", async () => {
    for (const [body, type] of [
      [png, "image/jpeg"],
      [Buffer.from("not an image"), "image/png"],
      [png.subarray(0, 32), "image/png"],
      [Buffer.alloc(0), "image/png"],
    ] as const) {
      expect((await upload(body, type)).statusCode).toBe(400);
    }
    expect(attachmentRows()).toHaveLength(0);
  });

  it("rejects SVG, JSON and base64 instead of guessing or decoding arbitrary content", async () => {
    expect(
      (await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), "image/svg+xml"))
        .statusCode,
    ).toBe(415);
    expect(
      (await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), "image/png"))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await upload(
          Buffer.from(JSON.stringify({ image: png.toString("base64") })),
          "application/json",
        )
      ).statusCode,
    ).toBe(415);
    expect((await upload(Buffer.from(png.toString("base64")))).statusCode).toBe(400);
    expect(attachmentRows()).toHaveLength(0);
  });

  it("enforces the binary request limit before storing an attachment", async () => {
    expect((await upload(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1))).statusCode).toBe(413);
    expect(attachmentRows()).toHaveLength(0);
  });

  it("rejects excessive pixel dimensions before decoding", async () => {
    const large = Buffer.from(png);
    large.writeUInt32BE(10_000, 16);
    large.writeUInt32BE(10_000, 20);
    // PNG CRC for IHDR type + data, so the header is valid independently of pixel data.
    let crc = 0xffffffff;
    for (const byte of large.subarray(12, 29)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    large.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
    expect((await upload(large)).statusCode).toBe(413);
    expect(attachmentRows()).toHaveLength(0);
  });

  it("returns 404 for missing attachments and 400 for invalid hashes", async () => {
    expect(
      (await app.inject({ url: `${ATTACHMENTS_API_PATH}/${"a".repeat(64)}` })).statusCode,
    ).toBe(404);
    for (const hash of ["bad", "a".repeat(63), "A".repeat(64), "g".repeat(64)]) {
      expect((await app.inject({ url: `${ATTACHMENTS_API_PATH}/${hash}` })).statusCode).toBe(400);
    }
  });

  it("does not install image body parsing on the trace ingestion endpoint", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/traces",
      headers: { "content-type": "image/png" },
      payload: png,
    });
    expect(response.statusCode).toBe(415);
    const json = await app.inject({ method: "POST", url: "/api/v1/traces", payload: [] });
    expect(json.statusCode).toBe(200);
  });

  it("adds the upload and read endpoints to the API documentation", () => {
    const document = app.swagger();
    expect(document.paths?.[ATTACHMENTS_API_PATH]?.post).toBeDefined();
    expect(document.paths?.[`${ATTACHMENTS_API_PATH}/{hash}`]?.get).toBeDefined();
  });
});
