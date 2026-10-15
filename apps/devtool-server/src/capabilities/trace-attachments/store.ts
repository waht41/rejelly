import { createHash } from "node:crypto";
import {
  ATTACHMENT_REFERENCE_PREFIX,
  type AttachmentMimeType,
  type AttachmentUploadResponse,
} from "@rejelly/devtool-contracts";
import { eq } from "drizzle-orm";
import { db, schema } from "../../db/drizzle";

/** Content-addressed BLOBs are immutable; repeated uploads never create another row. */
export function storeAttachment(
  data: Buffer,
  mimeType: AttachmentMimeType,
): AttachmentUploadResponse {
  const hash = createHash("sha256").update(data).digest("hex");
  db.insert(schema.traceAttachments)
    .values({ hash, mimeType, byteSize: data.length, data, createdAt: Date.now() })
    .onConflictDoNothing()
    .run();

  return {
    id: `sha256:${hash}`,
    url: `${ATTACHMENT_REFERENCE_PREFIX}${hash}`,
    mimeType,
    byteSize: data.length,
  };
}

export function readAttachment(hash: string) {
  return db
    .select({
      data: schema.traceAttachments.data,
      mimeType: schema.traceAttachments.mimeType,
      byteSize: schema.traceAttachments.byteSize,
    })
    .from(schema.traceAttachments)
    .where(eq(schema.traceAttachments.hash, hash))
    .get();
}
