import { ATTACHMENTS_API_PATH, getAttachmentHash } from "@rejelly/devtool-contracts";

/** Resolve internal references against the same API origin used for traces (and Vite's proxy). */
export function resolveTraceImageUrl(url: string): string | undefined {
  const hash = getAttachmentHash(url);
  if (hash) return `${ATTACHMENTS_API_PATH}/${hash}`;
  return /^(data:image\/|https?:\/\/|blob:)/i.test(url) ? url : undefined;
}
