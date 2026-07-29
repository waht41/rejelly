import { describe, expect, it } from "vitest";
import { readImageDimensions } from "./imageDimensions";

describe("readImageDimensions", () => {
  it("reads PNG dimensions from the IHDR header", () => {
    const bytes = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
    bytes.write("IHDR", 12, "ascii");
    bytes.writeUInt32BE(640, 16);
    bytes.writeUInt32BE(480, 20);

    expect(readImageDimensions(bytes)).toEqual({ width: 640, height: 480 });
  });

  it("reads GIF logical-screen dimensions", () => {
    const bytes = Buffer.alloc(10);
    bytes.write("GIF89a", 0, "ascii");
    bytes.writeUInt16LE(320, 6);
    bytes.writeUInt16LE(200, 8);

    expect(readImageDimensions(bytes)).toEqual({ width: 320, height: 200 });
  });

  it("reads JPEG start-of-frame dimensions", () => {
    const bytes = Buffer.alloc(15);
    bytes.set([0xff, 0xd8, 0xff, 0xc0]);
    bytes.writeUInt16BE(11, 4);
    bytes[6] = 8;
    bytes.writeUInt16BE(720, 7);
    bytes.writeUInt16BE(1280, 9);

    expect(readImageDimensions(bytes)).toEqual({ width: 1280, height: 720 });
  });

  it("reads extended WebP canvas dimensions", () => {
    const bytes = Buffer.alloc(30);
    bytes.write("RIFF", 0, "ascii");
    bytes.write("WEBP", 8, "ascii");
    bytes.write("VP8X", 12, "ascii");
    bytes.writeUIntLE(1919, 24, 3);
    bytes.writeUIntLE(1079, 27, 3);

    expect(readImageDimensions(bytes)).toEqual({ width: 1920, height: 1080 });
  });

  it("returns undefined for truncated or invalid image data", () => {
    expect(readImageDimensions(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
    expect(readImageDimensions(Buffer.from("not an image"))).toBeUndefined();
  });
});
