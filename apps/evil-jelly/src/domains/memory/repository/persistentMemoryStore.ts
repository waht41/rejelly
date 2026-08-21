import crypto from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getErrnoCode } from "../../../shared/foundation/errno";
import {
  assertMemoryFileByteLimit,
  type MemoryScope,
  PERSISTENT_MEMORY_LIMITS,
  type PersistentMemoryEntryV1,
  type PersistentMemoryFileV1,
  parseScopedMemoryFile,
} from "../model/memorySchema";
import { type PersistentMemoryPaths, resolveMemoryPaths } from "./memoryPaths";

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 15_000;

export class PersistentMemoryStoreError extends Error {
  constructor(
    readonly code: "unavailable" | "lock_timeout" | "write_failed",
    readonly scope: MemoryScope,
    readonly filePath: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PersistentMemoryStoreError";
  }
}

export interface PersistentMemoryStoreOptions {
  readonly workspaceRoot: string;
  readonly memoryRoot?: string;
  readonly paths?: PersistentMemoryPaths;
  readonly lockTimeoutMs?: number;
}

export interface MemoryStoreMutationContext {
  readonly scope: MemoryScope;
  readonly filePath: string;
  readonly current: PersistentMemoryFileV1;
}

export interface MemoryStoreMutationOutcome<T> {
  readonly file: PersistentMemoryFileV1;
  readonly value: T;
}

function emptyFile(): PersistentMemoryFileV1 {
  return { version: 1, entries: [] };
}

function fileForScope(paths: PersistentMemoryPaths, scope: MemoryScope): string {
  return scope === "user" ? paths.userFile : paths.projectFile;
}

function sortEntries(entries: readonly PersistentMemoryEntryV1[]): PersistentMemoryEntryV1[] {
  return [...entries].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}

function normalizeFile(file: PersistentMemoryFileV1): PersistentMemoryFileV1 {
  return { version: 1, entries: sortEntries(file.entries) };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return getErrnoCode(error) === "EPERM";
  }
}

function lockDirectory(filePath: string): string {
  return path.join(path.dirname(filePath), ".locks", path.basename(filePath));
}

async function removeDirectoryIfStale(lockPath: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")) as {
      pid?: unknown;
      hostname?: unknown;
    };
    if (
      owner.hostname === os.hostname() &&
      typeof owner.pid === "number" &&
      Number.isInteger(owner.pid) &&
      !processIsAlive(owner.pid)
    ) {
      await rm(lockPath, { recursive: true, force: true });
      return true;
    }
  } catch {
    // An incomplete or foreign lock is conservatively left in place until timeout.
  }
  return false;
}

async function acquireLock(filePath: string, timeoutMs: number): Promise<string> {
  const lockPath = lockDirectory(filePath);
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(
        path.join(lockPath, "owner.json"),
        `${JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt })}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      return lockPath;
    } catch (error) {
      if (getErrnoCode(error) !== "EEXIST") throw error;
      if (await removeDirectoryIfStale(lockPath)) continue;
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for persistent memory lock: ${filePath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  await rm(lockPath, { recursive: true, force: true });
}

export class PersistentMemoryStore {
  readonly paths: PersistentMemoryPaths;
  private readonly lockTimeoutMs: number;

  constructor(options: PersistentMemoryStoreOptions) {
    this.paths = options.paths ?? resolveMemoryPaths(options.workspaceRoot, options.memoryRoot);
    this.lockTimeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  }

  filePath(scope: MemoryScope): string {
    return fileForScope(this.paths, scope);
  }

  async read(scope: MemoryScope): Promise<PersistentMemoryFileV1> {
    return this.readUnlocked(scope);
  }

  async readBoth(): Promise<Record<MemoryScope, PersistentMemoryFileV1>> {
    return { user: await this.read("user"), project: await this.read("project") };
  }

  async withLock<T>(
    scope: MemoryScope,
    callback: (context: MemoryStoreMutationContext) => Promise<T> | T,
  ): Promise<T> {
    return this.runLocked(scope, async (context) => callback(context));
  }

  async mutate<T>(
    scope: MemoryScope,
    mutation: (
      context: MemoryStoreMutationContext,
    ) => Promise<MemoryStoreMutationOutcome<T>> | MemoryStoreMutationOutcome<T>,
  ): Promise<T> {
    return this.runLocked(scope, async (context) => {
      const outcome = await mutation(context);
      await this.writeUnlocked(scope, outcome.file);
      return outcome.value;
    });
  }

  private async runLocked<T>(
    scope: MemoryScope,
    callback: (context: MemoryStoreMutationContext) => Promise<T>,
  ): Promise<T> {
    const filePath = this.filePath(scope);
    let lockPath: string;
    try {
      lockPath = await acquireLock(filePath, this.lockTimeoutMs);
    } catch (error) {
      throw new PersistentMemoryStoreError(
        "lock_timeout",
        scope,
        filePath,
        `Could not acquire persistent memory lock: ${filePath}`,
        { cause: error },
      );
    }

    try {
      const current = await this.readUnlocked(scope);
      return await callback({ scope, filePath, current });
    } finally {
      await releaseLock(lockPath);
    }
  }

  private async readUnlocked(scope: MemoryScope): Promise<PersistentMemoryFileV1> {
    const filePath = this.filePath(scope);
    let raw: string;
    try {
      const info = await stat(filePath);
      if (info.size > PERSISTENT_MEMORY_LIMITS.maxFileBytes) {
        throw new Error(`file exceeds ${PERSISTENT_MEMORY_LIMITS.maxFileBytes} bytes`);
      }
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (getErrnoCode(error) === "ENOENT") return emptyFile();
      if (error instanceof PersistentMemoryStoreError) throw error;
      throw new PersistentMemoryStoreError(
        "unavailable",
        scope,
        filePath,
        `Persistent memory store is unavailable: ${filePath}`,
        { cause: error },
      );
    }

    try {
      const parsed = parseScopedMemoryFile(JSON.parse(raw) as unknown, scope);
      assertMemoryFileByteLimit(parsed);
      return normalizeFile(parsed);
    } catch (error) {
      throw new PersistentMemoryStoreError(
        "unavailable",
        scope,
        filePath,
        `Persistent memory store failed validation: ${filePath}`,
        { cause: error },
      );
    }
  }

  private async writeUnlocked(scope: MemoryScope, file: PersistentMemoryFileV1): Promise<void> {
    const filePath = this.filePath(scope);
    let normalized: PersistentMemoryFileV1;
    try {
      normalized = parseScopedMemoryFile(file, scope);
      assertMemoryFileByteLimit(normalized);
    } catch (error) {
      throw new PersistentMemoryStoreError(
        "write_failed",
        scope,
        filePath,
        `Persistent memory mutation failed validation: ${filePath}`,
        { cause: error },
      );
    }
    const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > PERSISTENT_MEMORY_LIMITS.maxFileBytes) {
      throw new PersistentMemoryStoreError(
        "write_failed",
        scope,
        filePath,
        `Persistent memory file exceeds ${PERSISTENT_MEMORY_LIMITS.maxFileBytes} bytes: ${filePath}`,
      );
    }

    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`,
    );
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, filePath);
      await chmod(filePath, 0o600).catch(() => undefined);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (error instanceof PersistentMemoryStoreError) throw error;
      throw new PersistentMemoryStoreError(
        "write_failed",
        scope,
        filePath,
        `Failed to atomically write persistent memory: ${filePath}`,
        { cause: error },
      );
    }
  }
}
