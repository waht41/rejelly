import path from "node:path";
import { resolveGlobalJellyDir } from "../../../shared/globalPath";
import {
  type MemoryProjectIdentity,
  memoryProjectBucket,
  resolveMemoryProjectIdentity,
} from "./memoryProjectIdentity";

export interface PersistentMemoryPaths {
  readonly root: string;
  readonly userFile: string;
  readonly projectFile: string;
  readonly projectIdentity: MemoryProjectIdentity;
}

export function resolvePersistentMemoryRoot(): string {
  return path.join(resolveGlobalJellyDir(), "memory");
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
  const identity = resolveMemoryProjectIdentity(workspaceRoot);
  const userFile = assertInsideRoot(root, path.join(root, "user.json"));
  const projectFile = assertInsideRoot(
    root,
    path.join(root, "projects", memoryProjectBucket(identity), "memory.json"),
  );
  return { root, userFile, projectFile, projectIdentity: identity };
}
