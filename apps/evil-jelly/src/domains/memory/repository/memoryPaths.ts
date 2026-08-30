import { mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveGlobalJellyDir } from "../../../shared/globalPath";
import { type MemoryProjectIdentity, resolveMemoryProjectIdentity } from "./memoryProjectIdentity";

export interface PersistentMemoryPaths {
  readonly root: string;
  readonly userFile: string;
  readonly projectFile: string;
  readonly projectIdentity: MemoryProjectIdentity;
  /** Set when the project registry could not be read; user memory remains available. */
  readonly projectUnavailable?: string;
}

export function resolvePersistentMemoryRoot(): string {
  return path.join(resolveGlobalJellyDir(), "memory");
}

export async function ensurePersistentMemoryRoot(): Promise<void> {
  await mkdir(resolvePersistentMemoryRoot(), { recursive: true });
}

function assertInsideRoot(root: string, candidate: string): string {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Persistent memory path escaped its root: ${candidate}`);
  }
  return candidate;
}

export function resolveMemoryPaths(
  workspaceRoot: string,
  memoryRoot = resolvePersistentMemoryRoot(),
): PersistentMemoryPaths {
  const root = path.resolve(memoryRoot);
  let identity: MemoryProjectIdentity;
  let projectUnavailable: string | undefined;
  try {
    identity = resolveMemoryProjectIdentity(workspaceRoot, root);
  } catch (error) {
    projectUnavailable = error instanceof Error ? error.message : String(error);
    identity = {
      projectId: "unavailable",
      root: path.resolve(workspaceRoot),
      createdAt: new Date(0).toISOString(),
      projectName: "unavailable",
      kind: "standard",
    };
  }
  const userFile = assertInsideRoot(root, path.join(root, "user.json"));
  const projectFile = assertInsideRoot(
    root,
    path.join(root, "projects", identity.projectId, "memory.json"),
  );
  return {
    root,
    userFile,
    projectFile,
    projectIdentity: identity,
    ...(projectUnavailable ? { projectUnavailable } : {}),
  };
}
