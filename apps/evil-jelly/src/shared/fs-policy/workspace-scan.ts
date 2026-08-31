import fs from "node:fs";
import path from "node:path";
import ignore from "ignore";
import { EVIL_JELLY_STATE_DIR } from "./workspace-context";

export type WorkspaceAccessKind = "discovery" | "scoped-discovery" | "direct-read" | "direct-write";

export type WorkspaceDirEntry = {
  name: string;
  isDirectory: () => boolean;
  isSymbolicLink?: () => boolean;
};

export type ScanPath = {
  rel: string;
  outside: boolean;
};

export const AGENT_HIDDEN_NAMES = new Set([
  ".agents",
  ".cursor",
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);

const AGENT_PROTECTED_NAMES = new Set([".agents", ".cursor", ".git"]);
const DEPENDENCY_DIR_NAME = "node_modules";

export const TOOL_ALWAYS_IGNORED_DIR_NAMES = new Set([
  ".agents",
  ".cursor",
  ".git",
  ".next",
  ".env",
  "node_modules",
  "dist",
  "build",
]);

export const SENSITIVE_FILE_PATTERNS = [/^\.env(\..+)?$/i, /\.pem$/i, /id_rsa/i, /\.npmrc$/i];
const SAFE_ENV_TEMPLATE_SUFFIXES = new Set(["example", "sample", "template"]);

export function toGitignorePath(relativeNormalized: string): string {
  let normalized = relativeNormalized.replace(/\\/g, "/");
  if (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

function isEnvTemplateFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (!lower.startsWith(".env.")) {
    return false;
  }
  const suffix = lower.slice(lower.lastIndexOf(".") + 1);
  return SAFE_ENV_TEMPLATE_SUFFIXES.has(suffix);
}

export function isSensitiveFileName(fileName: string): boolean {
  if (isEnvTemplateFileName(fileName)) {
    return false;
  }
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(fileName));
}

export function isSensitiveFsPath(filePath: string): boolean {
  const fileName = path.basename(filePath);
  return fileName.length > 0 && isSensitiveFileName(fileName);
}

export function sensitiveFsPathError(displayPath: string): string {
  return (
    `Access denied: Path '${displayPath}' matches a sensitive file pattern. ` +
    "If you explicitly need to inspect it, ask the user to run the command via run_command."
  );
}

function isPathSystemHidden(relativeNormalized: string, access: WorkspaceAccessKind): boolean {
  const parts = relativeNormalized.split(path.sep).filter((part) => part.length > 0);
  const fileName = parts[parts.length - 1];
  for (const segment of parts) {
    if (
      AGENT_PROTECTED_NAMES.has(segment) ||
      (access === "discovery" && AGENT_HIDDEN_NAMES.has(segment)) ||
      (access === "direct-write" && segment === DEPENDENCY_DIR_NAME)
    ) {
      return true;
    }
  }
  return Boolean(fileName && isSensitiveFileName(fileName));
}

/** Workspace visibility and traversal rules, including the root .gitignore snapshot. */
export class WorkspaceScan {
  private readonly rootGitignore: ReturnType<typeof ignore>;

  constructor(root: string) {
    this.rootGitignore = ignore();
    const gitignorePath = path.join(root, ".gitignore");
    if (fs.existsSync(gitignorePath)) {
      try {
        this.rootGitignore.add(fs.readFileSync(gitignorePath, "utf-8"));
      } catch {
        // Keep scanning operational when .gitignore is unreadable.
      }
    }
  }

  isIgnoredByGitignore(workspaceRelative: string, isDirectory: boolean): boolean {
    const gitignorePath = toGitignorePath(workspaceRelative);
    if (gitignorePath.length === 0 || gitignorePath === ".") {
      return false;
    }
    if (isDirectory) {
      return (
        this.rootGitignore.ignores(gitignorePath) || this.rootGitignore.ignores(`${gitignorePath}/`)
      );
    }
    return this.rootGitignore.ignores(gitignorePath);
  }

  shouldSkipIgnoredWorkspaceEntry(parentRelativeDir: string, entry: WorkspaceDirEntry): boolean {
    const isDirectory = entry.isDirectory();
    if (isDirectory && TOOL_ALWAYS_IGNORED_DIR_NAMES.has(entry.name)) {
      return true;
    }
    return this.isIgnoredByGitignore(path.join(parentRelativeDir, entry.name), isDirectory);
  }

  shouldSkipResolvedEntry(parent: ScanPath, entry: WorkspaceDirEntry): boolean {
    if (parent.outside) {
      return entry.isDirectory() && TOOL_ALWAYS_IGNORED_DIR_NAMES.has(entry.name);
    }
    return this.shouldSkipIgnoredWorkspaceEntry(parent.rel, entry);
  }

  shouldSkipScopedResolvedEntry(parent: ScanPath, entry: WorkspaceDirEntry): boolean {
    if (entry.isSymbolicLink?.()) {
      return true;
    }
    if (
      entry.isDirectory() &&
      (TOOL_ALWAYS_IGNORED_DIR_NAMES.has(entry.name) || AGENT_HIDDEN_NAMES.has(entry.name))
    ) {
      return true;
    }
    return parent.outside
      ? false
      : isPathSystemHidden(path.join(parent.rel, entry.name), "scoped-discovery");
  }

  validateScopedDiscoveryRoot(resolved: ScanPath): string | undefined {
    if (!resolved.outside && resolved.rel === ".") {
      return "includeIgnored requires an explicit workspace subdirectory; scanning the workspace root is not allowed.";
    }

    const segments = resolved.rel.split(path.sep).filter(Boolean);
    const dependencyIndex = segments.lastIndexOf(DEPENDENCY_DIR_NAME);
    if (dependencyIndex < 0) {
      return undefined;
    }
    const packageSegments = segments.slice(dependencyIndex + 1);
    if (
      packageSegments.length === 0 ||
      packageSegments[0] === ".pnpm" ||
      (packageSegments[0]?.startsWith("@") && packageSegments.length < 2)
    ) {
      return "includeIgnored under node_modules must be scoped to a concrete package (for example node_modules/zod or node_modules/@scope/pkg).";
    }
    return undefined;
  }

  isPathHidden(relativeNormalized: string, access: WorkspaceAccessKind): boolean {
    if (isPathSystemHidden(relativeNormalized, access)) {
      return true;
    }
    const gitignorePath = toGitignorePath(relativeNormalized);
    if (
      gitignorePath === EVIL_JELLY_STATE_DIR ||
      gitignorePath.startsWith(`${EVIL_JELLY_STATE_DIR}/`)
    ) {
      return false;
    }
    return (
      access === "discovery" &&
      gitignorePath.length > 0 &&
      gitignorePath !== "." &&
      this.rootGitignore.ignores(gitignorePath)
    );
  }
}
