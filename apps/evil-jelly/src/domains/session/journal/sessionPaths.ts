import crypto from "node:crypto";
import path from "node:path";
import { resolveGlobalJellyDir } from "../../../shared/globalPath";
import { workspaceBucket } from "../../../shared/workspaceBucket";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** ~/.evil-jelly/sessions */
export function resolveSessionsRoot(): string {
  return path.join(resolveGlobalJellyDir(), "sessions");
}

/** Resolve the journal and content-addressed blob roots inside one portable Session store. */
export function resolveSessionStorePaths(sessionStoreRoot: string): {
  sessionsRoot: string;
  blobRoot: string;
} {
  return {
    sessionsRoot: path.join(sessionStoreRoot, "sessions"),
    blobRoot: path.join(sessionStoreRoot, "blobs"),
  };
}

export function resolveWorkspaceDir(workspaceRoot: string, sessionsRoot = resolveSessionsRoot()) {
  return path.join(sessionsRoot, workspaceBucket(workspaceRoot));
}

/** Whether a value is safe to use as one session filename stem. */
export function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId) && sessionId !== "." && sessionId !== "..";
}

export function assertSessionId(sessionId: string): void {
  if (!isValidSessionId(sessionId)) {
    throw new Error(`Unsafe session id: ${JSON.stringify(sessionId)}`);
  }
}

/** Sortable, human-ish session id: base36 timestamp + short random suffix. */
export function generateSessionId(): string {
  return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}
