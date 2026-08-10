import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getErrnoCode } from "../../shared/lib/errors";

export type ContainedPathKind = "file" | "directory";

export type ContainedPathResult =
  | {
      readonly ok: true;
      readonly rootRealPath: string;
      readonly realPath: string;
    }
  | {
      readonly ok: false;
      readonly reason: "invalid" | "missing" | "escape" | "symlink-directory" | "wrong-kind";
      readonly message: string;
    };

/** Reject path forms that could acquire different meanings on Windows and POSIX. */
export function validateRelativeSkillPath(relativePath: string): string | undefined {
  if (relativePath.length === 0 || relativePath.trim().length === 0) {
    return "Path must be a non-empty relative path.";
  }
  if (relativePath.includes("\0")) {
    return "Path must not contain NUL.";
  }
  if (
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    /^[a-zA-Z]:/.test(relativePath)
  ) {
    return "Path must be relative and must not use a drive or UNC root.";
  }
  return undefined;
}

function isInside(rootRealPath: string, targetPath: string): boolean {
  const relative = path.relative(rootRealPath, targetPath);
  return (
    relative.length === 0 ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function failure(
  reason: Exclude<ContainedPathResult, { ok: true }>["reason"],
  message: string,
): ContainedPathResult {
  return { ok: false, reason, message };
}

/**
 * Resolve an existing path under a canonical root without following directory links.
 *
 * A final regular-file symlink is allowed only when its real target remains inside the root.
 * Directory symlinks/junctions, including intermediate segments, are rejected.
 */
export async function resolveContainedPath(
  rootPath: string,
  relativePath: string,
  expectedKind: ContainedPathKind,
): Promise<ContainedPathResult> {
  const lexicalError = validateRelativeSkillPath(relativePath);
  if (lexicalError) {
    return failure("invalid", lexicalError);
  }

  let rootRealPath: string;
  try {
    rootRealPath = await fs.realpath(rootPath);
    if (!(await fs.stat(rootRealPath)).isDirectory()) {
      return failure("wrong-kind", "Containment root is not a directory.");
    }
  } catch (error: unknown) {
    return failure(
      getErrnoCode(error) === "ENOENT" ? "missing" : "invalid",
      `Containment root is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const lexicalTarget = path.resolve(rootRealPath, relativePath);
  if (!isInside(rootRealPath, lexicalTarget)) {
    return failure("escape", "Resolved path escapes its Skill root.");
  }

  const relativeFromRoot = path.relative(rootRealPath, lexicalTarget);
  const segments = relativeFromRoot.split(path.sep).filter(Boolean);
  let current = rootRealPath;
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]!);
    let entryStat: Stats;
    try {
      entryStat = await fs.lstat(current);
    } catch (error: unknown) {
      return failure(
        getErrnoCode(error) === "ENOENT" ? "missing" : "invalid",
        `Path is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const isFinal = index === segments.length - 1;
    if (entryStat.isSymbolicLink() && (!isFinal || expectedKind === "directory")) {
      return failure(
        "symlink-directory",
        "Directory symlinks and junction traversal are disabled.",
      );
    }
    if (!isFinal && !entryStat.isDirectory()) {
      return failure("wrong-kind", "An intermediate path segment is not a directory.");
    }
  }

  let realPath: string;
  try {
    realPath = await fs.realpath(lexicalTarget);
  } catch (error: unknown) {
    return failure(
      getErrnoCode(error) === "ENOENT" ? "missing" : "invalid",
      `Path target is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isInside(rootRealPath, realPath)) {
    return failure("escape", "Real path target escapes its Skill root.");
  }

  try {
    const targetStat = await fs.stat(realPath);
    const matches = expectedKind === "file" ? targetStat.isFile() : targetStat.isDirectory();
    if (!matches) {
      return failure("wrong-kind", `Path target is not a ${expectedKind}.`);
    }
  } catch (error: unknown) {
    return failure(
      getErrnoCode(error) === "ENOENT" ? "missing" : "invalid",
      `Path target is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { ok: true, rootRealPath, realPath };
}
