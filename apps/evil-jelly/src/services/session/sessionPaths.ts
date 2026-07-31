import crypto from "node:crypto";
import path from "node:path";
import { resolveGlobalJellyDir } from "../../shared/globalPath";

/** ~/.evil-jelly/sessions */
export function resolveSessionsRoot(): string {
  return path.join(resolveGlobalJellyDir(), "sessions");
}

/** Per-workspace bucket: <sanitized-basename>-<sha1(absRoot)[0..8]>. */
export function workspaceBucket(workspaceRoot: string): string {
  const abs = path.resolve(workspaceRoot);
  const hash = crypto.createHash("sha1").update(abs).digest("hex").slice(0, 8);
  const base = path.basename(abs).replace(/[^\w.-]+/g, "_") || "workspace";
  return `${base}-${hash}`;
}

export function resolveWorkspaceDir(workspaceRoot: string, sessionsRoot = resolveSessionsRoot()) {
  return path.join(sessionsRoot, workspaceBucket(workspaceRoot));
}

/** Sortable, human-ish session id: base36 timestamp + short random suffix. */
export function generateSessionId(): string {
  return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}
