import crypto from "node:crypto";
import path from "node:path";

/** Shared session/tool-artifact bucket: <sanitized-basename>-<sha1(absRoot)[0..8]>. */
export function workspaceBucket(workspaceRoot: string): string {
  const abs = path.resolve(workspaceRoot);
  const hash = crypto.createHash("sha1").update(abs).digest("hex").slice(0, 8);
  const base = path.basename(abs).replace(/[^\w.-]+/g, "_") || "workspace";
  return `${base}-${hash}`;
}
