import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const REGISTRY_VERSION = 1;
const REGISTRY_LOCK_TIMEOUT_MS = 5_000;

export interface MemoryProjectRecord {
  readonly projectId: string;
  readonly root: string;
  readonly createdAt: string;
}

interface MemoryProjectRegistryFile {
  readonly version: typeof REGISTRY_VERSION;
  readonly projects: readonly MemoryProjectRecord[];
}

function normalizeAbsolutePath(filePath: string): string {
  const normalized = path.normalize(path.resolve(filePath));
  const platformPath = process.platform === "win32" ? normalized.replaceAll("/", "\\") : normalized;
  const root = path.parse(platformPath).root;
  return platformPath.length > root.length ? platformPath.replace(/[\\\\/]+$/, "") : platformPath;
}

export function canonicalProjectPath(filePath: string): string {
  try {
    return normalizeAbsolutePath(fs.realpathSync.native(filePath));
  } catch {
    return normalizeAbsolutePath(filePath);
  }
}

function comparisonPath(filePath: string): string {
  const canonical = canonicalProjectPath(filePath);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function registryPath(memoryRoot: string): string {
  return path.join(path.resolve(memoryRoot), "projects", "registry.json");
}

function isProjectRecord(value: unknown): value is MemoryProjectRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.projectId === "string" &&
    /^[0-9a-f-]{36}$/i.test(record.projectId) &&
    typeof record.root === "string" &&
    path.isAbsolute(record.root) &&
    typeof record.createdAt === "string"
  );
}

function readRegistry(filePath: string): MemoryProjectRegistryFile {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: REGISTRY_VERSION, projects: [] };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Project registry is not valid JSON: ${filePath}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Project registry has an invalid shape: ${filePath}`);
  }
  const registry = parsed as Record<string, unknown>;
  if (
    registry.version !== REGISTRY_VERSION ||
    !Array.isArray(registry.projects) ||
    !registry.projects.every(isProjectRecord)
  ) {
    throw new Error(`Project registry failed validation: ${filePath}`);
  }
  return {
    version: REGISTRY_VERSION,
    projects: (registry.projects as MemoryProjectRecord[]).map((project) => ({
      ...project,
      root: canonicalProjectPath(project.root),
    })),
  };
}

function writeRegistry(filePath: string, registry: MemoryProjectRegistryFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The temporary file was already renamed or did not get created.
    }
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removeStaleLock(lockPath: string): boolean {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")) as {
      pid?: unknown;
    };
    if (typeof owner.pid === "number" && !processIsAlive(owner.pid)) {
      fs.rmSync(lockPath, { recursive: true, force: true });
      return true;
    }
  } catch {
    // Keep incomplete locks until the timeout; this is fail-closed.
  }
  return false;
}

function withRegistryLock<T>(filePath: string, callback: () => T): T {
  const lockPath = `${filePath}.lock`;
  const startedAt = Date.now();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      fs.writeFileSync(
        path.join(lockPath, "owner.json"),
        `${JSON.stringify({ pid: process.pid })}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (removeStaleLock(lockPath)) continue;
      if (Date.now() - startedAt >= REGISTRY_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for project registry lock: ${filePath}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }

  try {
    return callback();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

function isAncestorOrSame(ancestor: string, candidate: string): boolean {
  const relative = path.relative(comparisonPath(ancestor), comparisonPath(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function findRegisteredProject(
  workspaceRoot: string,
  memoryRoot: string,
): MemoryProjectRecord | undefined {
  const workspace = canonicalProjectPath(workspaceRoot);
  const registry = readRegistry(registryPath(memoryRoot));
  return registry.projects
    .filter((project) => isAncestorOrSame(project.root, workspace))
    .sort((left, right) => right.root.length - left.root.length)[0];
}

export function listRegisteredProjects(memoryRoot: string): readonly MemoryProjectRecord[] {
  return readRegistry(registryPath(memoryRoot)).projects;
}

export function getOrCreateRegisteredProject(
  projectRoot: string,
  memoryRoot: string,
): MemoryProjectRecord {
  const root = canonicalProjectPath(projectRoot);
  const filePath = registryPath(memoryRoot);
  return withRegistryLock(filePath, () => {
    const registry = readRegistry(filePath);
    const existing = registry.projects.find(
      (project) => comparisonPath(project.root) === comparisonPath(root),
    );
    if (existing) return existing;

    const project: MemoryProjectRecord = {
      projectId: crypto.randomUUID(),
      root,
      createdAt: new Date().toISOString(),
    };
    writeRegistry(filePath, {
      version: REGISTRY_VERSION,
      projects: [...registry.projects, project],
    });
    return project;
  });
}
