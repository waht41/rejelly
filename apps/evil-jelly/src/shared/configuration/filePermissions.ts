import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import { z } from "zod";
import { getErrnoCode } from "../foundation/errno";
import { parseJsonc } from "../foundation/jsonc";
import { resolveRealPath } from "../fs-policy/path-containment";
import { sameCanonicalPath } from "../workspaceScope";

const absolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => path.isAbsolute(value), {
    message: "Expected an absolute filesystem path.",
  });

export const FilePermissionSchema = z
  .object({
    directory: absolutePathSchema,
    access: z.enum(["read", "read-write"]),
  })
  .strict();
export type FilePermission = z.infer<typeof FilePermissionSchema>;

export const PermissionsSettingsSchema = z
  .object({
    projects: z
      .record(
        absolutePathSchema,
        z
          .object({
            filesystem: z.object({ allow: z.array(FilePermissionSchema) }).strict(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type PermissionsSettings = z.infer<typeof PermissionsSettingsSchema>;

/** Exact project matching only: a parent project's grants never authorize its children. */
export function projectFilePermissions(
  settings: PermissionsSettings | undefined,
  workspaceRoot: string,
): FilePermission[] {
  const projects = Object.entries(settings?.projects ?? {}).filter(([root]) =>
    sameCanonicalPath(root, workspaceRoot),
  );
  if (projects.length > 1)
    throw new Error("Duplicate canonical project paths in permission settings.");
  return projects.flatMap(([, project]) => project.filesystem.allow);
}

/** Update only the selected project's allow list, preserving JSONC comments and other settings. */
export function persistProjectFilePermission(
  filePath: string,
  workspaceRoot: string,
  grant: FilePermission,
): void {
  const directory = resolveRealPath(grant.directory);
  const projectRoot = resolveRealPath(workspaceRoot);
  if (!directory || !projectRoot) throw new Error("Cannot resolve permission paths safely.");
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true });
  const lockPath = `${filePath}.permissions.lock`;
  let lock: number;
  try {
    lock = fs.openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (getErrnoCode(error) === "EEXIST")
      throw new Error("Permission settings are busy; retry approval.");
    throw error;
  }
  const temporary = path.join(parent, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if (getErrnoCode(error) !== "ENOENT") throw error;
      raw = "{}\n";
    }
    const parsed = parseJsonc(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Settings ${filePath} must contain a JSON object.`);
    }
    const settings = PermissionsSettingsSchema.parse(
      (parsed as Record<string, unknown>).permissions ?? {},
    );
    const projectKey =
      Object.keys(settings.projects ?? {}).find((root) => sameCanonicalPath(root, projectRoot)) ??
      projectRoot;
    const allow = projectFilePermissions(settings, projectRoot);
    const existing = allow.find((entry) => sameCanonicalPath(entry.directory, directory));
    const updated = allow.filter((entry) => !sameCanonicalPath(entry.directory, directory));
    updated.push({
      directory,
      access: existing?.access === "read-write" ? "read-write" : grant.access,
    });
    const edits = modify(
      raw,
      ["permissions", "projects", projectKey, "filesystem", "allow"],
      updated,
      {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
      },
    );
    const text = applyEdits(raw, edits);
    const mode = fs.existsSync(filePath) ? fs.statSync(filePath).mode : 0o600;
    const descriptor = fs.openSync(temporary, "wx", mode);
    try {
      fs.writeFileSync(descriptor, text.endsWith("\n") ? text : `${text}\n`, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    // Permission writers cooperate via the lock; detect unrelated/manual settings edits too.
    let current = "{}\n";
    try {
      current = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if (getErrnoCode(error) !== "ENOENT") throw error;
    }
    if (current !== raw)
      throw new Error("Settings changed while saving permissions; retry approval.");
    fs.renameSync(temporary, filePath);
  } finally {
    fs.closeSync(lock);
    try {
      fs.rmSync(temporary, { force: true });
    } finally {
      fs.unlinkSync(lockPath);
    }
  }
}
