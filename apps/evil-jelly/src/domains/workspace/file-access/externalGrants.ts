import path from "node:path";
import type { FilePermission } from "../../../shared/configuration/filePermissions";
import { isPathInside, resolveRealPath } from "../../../shared/fs-policy/path-containment";
import type { ExternalFileAccess } from "../../../shared/host/toolConfirmationBindings";

/** One live session's directory grants, never reconstructed from model history. */
export class ExternalFileGrants {
  private readonly grants: FilePermission[] = [];

  find(access: ExternalFileAccess, targetPath: string): FilePermission | undefined {
    return this.grants.find((grant) => grantCovers(grant, access, targetPath));
  }

  approve(access: FilePermission["access"], directory: string): void {
    const real = resolveRealPath(directory);
    if (!real) throw new Error("Cannot resolve permission directory safely.");
    this.grants.push({ directory: real, access });
  }
}

/** Both the visible and real path must stay in one grant; links cannot widen its boundary. */
export function grantCovers(
  grant: FilePermission,
  access: ExternalFileAccess,
  targetPath: string,
): boolean {
  const root = path.resolve(grant.directory);
  const real = resolveRealPath(targetPath);
  return (
    (access !== "write" || grant.access === "read-write") &&
    isPathInside(root, targetPath) &&
    real !== undefined &&
    isPathInside(root, real)
  );
}
