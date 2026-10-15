import { type AttachmentMimeType, attachmentMimeTypeSchema } from "@rejelly/devtool-contracts";
import sharp from "sharp";

export const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;
export const MAX_ATTACHMENT_PIXELS = 20_000_000;

export class AttachmentUploadError extends Error {
  constructor(
    readonly statusCode: 400 | 413 | 415,
    message: string,
  ) {
    super(message);
  }
}

function detectRasterMimeType(data: Buffer): AttachmentMimeType | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) {
    return "image/jpeg";
  }
  if (
    data.length >= 12 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  const gifHeader = data.toString("ascii", 0, 6);
  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") return "image/gif";
  return undefined;
}

/** Validate without re-encoding: the hash and BLOB represent the original image bytes. */
export async function validateImageUpload(
  data: Buffer,
  contentType: string,
): Promise<AttachmentMimeType> {
  const mimeType = attachmentMimeTypeSchema.safeParse(
    contentType.split(";")[0].trim().toLowerCase(),
  );
  if (!mimeType.success) {
    throw new AttachmentUploadError(415, "Supported image types: PNG, JPEG, WebP, GIF");
  }
  if (data.length === 0) throw new AttachmentUploadError(400, "Image body must not be empty");
  if (data.length > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentUploadError(413, "Image exceeds the 16 MiB attachment limit");
  }
  if (detectRasterMimeType(data) !== mimeType.data) {
    throw new AttachmentUploadError(400, "Image bytes do not match Content-Type");
  }

  try {
    // Metadata does not decode pixels; check all animation frames before allocating a decoder.
    const metadata = await sharp(data, { animated: true, limitInputPixels: false }).metadata();
    const pixels = (metadata.width ?? 0) * (metadata.height ?? 0);
    if (pixels === 0) throw new AttachmentUploadError(400, "Image dimensions are missing");
    if (pixels > MAX_ATTACHMENT_PIXELS) {
      throw new AttachmentUploadError(413, "Image exceeds the 20 million pixel attachment limit");
    }
    // Force a complete decode so truncated/corrupt images cannot pass by signature alone.
    await sharp(data, {
      animated: true,
      limitInputPixels: MAX_ATTACHMENT_PIXELS,
      failOn: "warning",
    }).stats();
  } catch (error) {
    if (error instanceof AttachmentUploadError) throw error;
    throw new AttachmentUploadError(400, "Image could not be decoded");
  }
  return mimeType.data;
}
