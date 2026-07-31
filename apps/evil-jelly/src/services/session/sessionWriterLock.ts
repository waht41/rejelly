import crypto from "node:crypto";
import { link, mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CLAIM_FILE_SUFFIX = ".json";
const TEMP_FILE_SUFFIX = ".tmp";
const CLAIM_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface SessionLockInfo {
  pid: number;
  hostname: string;
  startedAt: number;
  token: string;
  traceId?: string;
}

export interface AcquiredSessionWriterLock {
  claimPath: string;
  info: SessionLockInfo;
}

export type SessionWriterLockReason =
  | "active_writer"
  | "foreign_host"
  | "invalid_claim"
  | "unreadable_claim";

export class SessionWriterLockedError extends Error {
  constructor(
    readonly filePath: string,
    readonly reason: SessionWriterLockReason,
    readonly claimPath: string,
    readonly lockInfo?: SessionLockInfo,
    options?: ErrorOptions,
  ) {
    const detail =
      reason === "active_writer"
        ? "an active writer owns the session"
        : reason === "foreign_host"
          ? "a writer claim belongs to another host"
          : reason === "invalid_claim"
            ? "a writer claim is invalid"
            : "a writer claim cannot be read";
    super(`Cannot open session writer because ${detail}: ${filePath}`, options);
    this.name = "SessionWriterLockedError";
  }
}

type ClaimReadResult =
  | { kind: "found"; info: SessionLockInfo }
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "unreadable"; error: unknown };

function lockDirectory(filePath: string): string {
  // Keep cleanup physically separated from durable session data. Even a future scanner bug in
  // this directory cannot match or unlink a sibling JSONL transcript.
  return path.join(path.dirname(filePath), ".locks", path.basename(filePath));
}

function claimPathFor(filePath: string, token: string): string {
  return path.join(lockDirectory(filePath), `${token}${CLAIM_FILE_SUFFIX}`);
}

function parseLockInfo(value: unknown): SessionLockInfo | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as Partial<SessionLockInfo>;
  if (
    !Number.isInteger(candidate.pid) ||
    (candidate.pid ?? 0) <= 0 ||
    typeof candidate.hostname !== "string" ||
    candidate.hostname.length === 0 ||
    !Number.isInteger(candidate.startedAt) ||
    (candidate.startedAt ?? -1) < 0 ||
    typeof candidate.token !== "string" ||
    !CLAIM_TOKEN_PATTERN.test(candidate.token) ||
    (candidate.traceId !== undefined && typeof candidate.traceId !== "string")
  ) {
    return undefined;
  }
  return candidate as SessionLockInfo;
}

async function readLockInfo(claimPath: string): Promise<ClaimReadResult> {
  let serialized: string;
  try {
    serialized = await readFile(claimPath, "utf8");
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "unreadable", error };
  }

  try {
    const info = parseLockInfo(JSON.parse(serialized) as unknown);
    return info ? { kind: "found", info } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function publishClaim(
  filePath: string,
  info: SessionLockInfo,
): Promise<AcquiredSessionWriterLock> {
  const directory = lockDirectory(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const claimPath = claimPathFor(filePath, info.token);
  const temporary = path.join(directory, `${info.token}${TEMP_FILE_SUFFIX}`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(info)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // The hard link is the publication boundary: contenders can see either no claim or the complete
    // serialized claim, never a destination file whose contents are still being written. Do not
    // simplify this to opening `claimPath` and filling it in place.
    await link(temporary, claimPath);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return { claimPath, info };
}

async function activeClaims(
  filePath: string,
  ownToken: string,
): Promise<Array<{ claimPath: string; info: SessionLockInfo }>> {
  const directory = lockDirectory(filePath);
  const currentHostname = os.hostname();
  const entries = await readdir(directory, { withFileTypes: true });
  const active: Array<{ claimPath: string; info: SessionLockInfo }> = [];

  for (const entry of entries) {
    if (!entry.name.endsWith(CLAIM_FILE_SUFFIX)) {
      continue;
    }
    const token = entry.name.slice(0, -CLAIM_FILE_SUFFIX.length);
    const claimPath = path.join(directory, entry.name);
    if (token === ownToken) {
      continue;
    }

    const result = await readLockInfo(claimPath);
    if (result.kind === "missing") {
      continue;
    }
    if (result.kind === "unreadable") {
      throw new SessionWriterLockedError(filePath, "unreadable_claim", claimPath, undefined, {
        cause: result.error,
      });
    }
    if (result.kind === "invalid" || result.info.token !== token) {
      throw new SessionWriterLockedError(filePath, "invalid_claim", claimPath);
    }

    const info = result.info;
    if (info.hostname === currentHostname && !processIsAlive(info.pid)) {
      // Claim paths include an unguessable token and are never reused. Removing this exact,
      // positively identified stale claim cannot unlink a replacement writer's live claim.
      await unlink(claimPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      });
      continue;
    }
    active.push({ claimPath, info });
  }
  return active;
}

/**
 * Publish a unique writer claim, then reject if any other live claim exists. Two simultaneous
 * contenders may both reject, but can never both win. Foreign-host claims and claims whose validity
 * cannot be established are conservatively treated as blockers.
 */
export async function acquireSessionWriterLock(
  filePath: string,
  traceId?: string,
): Promise<AcquiredSessionWriterLock> {
  const info: SessionLockInfo = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: Date.now(),
    token: crypto.randomBytes(16).toString("hex"),
    ...(traceId ? { traceId } : {}),
  };
  const own = await publishClaim(filePath, info);
  try {
    const others = await activeClaims(filePath, info.token);
    const other = others[0];
    if (other) {
      throw new SessionWriterLockedError(
        filePath,
        other.info.hostname === os.hostname() ? "active_writer" : "foreign_host",
        other.claimPath,
        other.info,
      );
    }
    return own;
  } catch (error) {
    try {
      await unlink(own.claimPath);
    } catch (cleanupError: unknown) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AggregateError(
          [error, cleanupError],
          `Failed to remove writer claim after acquisition failed: ${own.claimPath}`,
        );
      }
    }
    throw error;
  }
}

export async function releaseSessionWriterLock(lock: AcquiredSessionWriterLock): Promise<void> {
  await unlink(lock.claimPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
}
