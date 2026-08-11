/**
 * Cross-platform path helpers (POSIX shape for git / diff display).
 */

import path from "node:path";

export function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Convert an already-validated POSIX-shaped relative path for native filesystem APIs. */
export function fromPosixPath(posixPath: string): string {
  return path.sep === "/" ? posixPath : posixPath.replaceAll("/", path.sep);
}
