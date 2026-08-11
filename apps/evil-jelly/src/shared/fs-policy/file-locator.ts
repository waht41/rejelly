import path from "node:path";
import { toPosixPath } from "../foundation/path";
import { isPathInside } from "./outside-access";
import type { ResolvedFsPath } from "./workspace-fs-policy";

export type FileLocator =
  | {
      scope: "workspace";
      path: string;
    }
  | {
      scope: "absolute";
      path: string;
    };

function normalizeWorkspacePath(value: string): string {
  const normalized = toPosixPath(path.normalize(value));
  return normalized.length === 0 ? "." : normalized;
}

/**
 * Convert a policy-approved path into the stable locator shown to the model and persisted in
 * message metadata. Do not derive this from `displayPath`: that field is presentation-only.
 */
export function fileLocatorFromResolved(resolved: ResolvedFsPath): FileLocator {
  return resolved.outside
    ? { scope: "absolute", path: toPosixPath(path.resolve(resolved.abs)) }
    : { scope: "workspace", path: normalizeWorkspacePath(resolved.rel) };
}

/**
 * Describe a user-selected path without granting filesystem access. Relative inputs are defined
 * against the workspace root; absolute paths inside it are reduced to workspace-relative form.
 */
export function fileLocatorFromUserPath(workspaceRoot: string, userPath: string): FileLocator {
  const root = path.resolve(workspaceRoot);
  const absolute = path.resolve(root, userPath);
  if (isPathInside(root, absolute)) {
    return {
      scope: "workspace",
      path: normalizeWorkspacePath(path.relative(root, absolute)),
    };
  }
  return { scope: "absolute", path: toPosixPath(absolute) };
}

export function fileLocatorAttributes(locator: FileLocator): {
  path: string;
  "path-scope": FileLocator["scope"];
} {
  return {
    path: locator.path,
    "path-scope": locator.scope,
  };
}
