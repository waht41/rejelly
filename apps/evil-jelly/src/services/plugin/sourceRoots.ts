import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getWorkspaceFsPolicy } from "../../shared/fs-policy/workspace-fs-policy";
import { resolveGlobalJellyDir } from "../../shared/globalPath";
import { getErrnoCode } from "../../shared/lib/errors";
import { fnv1a32Hex } from "../../shared/lib/hash";
import {
  type ExtensionLoadDiagnostic,
  PLUGIN_MANIFEST_FILE_NAME,
  UNSUPPORTED_PLUGIN_MANIFEST_FILE_NAME,
} from "./contracts";

export type ExtensionSourceScope = "user" | "project";
export type ExtensionSourceRootKind = "plugin" | "loose-skill";

/** One host-side fixed root. Paths here are never exposed to the model. */
export interface ExtensionSourceRoot {
  readonly scope: ExtensionSourceScope;
  readonly kind: ExtensionSourceRootKind;
  readonly path: string;
}

/** The four v1 roots in deterministic discovery order. */
export interface ResolvedExtensionRoots {
  readonly roots: readonly ExtensionSourceRoot[];
}

/** A direct child of a formal plugin root that is ready for manifest loading. */
export interface PluginSourceCandidate {
  readonly kind: "plugin";
  readonly scope: ExtensionSourceScope;
  readonly directoryName: string;
  readonly directoryPath: string;
  readonly manifestPath: string;
}

/** A direct child of a loose skill root that is ready for SKILL.md loading. */
export interface LooseSkillSourceCandidate {
  readonly kind: "loose-skill";
  readonly scope: ExtensionSourceScope;
  readonly sourceId: string;
  readonly directoryName: string;
  readonly directoryPath: string;
  readonly skillFilePath: string;
}

export interface ExtensionSourceDiscovery {
  readonly plugins: readonly PluginSourceCandidate[];
  readonly looseSkills: readonly LooseSkillSourceCandidate[];
  readonly diagnostics: readonly ExtensionLoadDiagnostic[];
}

/**
 * Resolve the fixed roots without touching the filesystem.
 *
 * User roots intentionally come first. If an unusual setup aliases a project root to the global
 * root, discovery keeps the user identity and diagnoses the duplicate instead of loading it twice.
 */
export function resolveExtensionRoots(
  workspaceRoot: string,
  globalJellyDir: string,
): ResolvedExtensionRoots {
  const workspaceStateDir = path.join(path.resolve(workspaceRoot), ".evil-jelly");
  const globalStateDir = path.resolve(globalJellyDir);
  const roots: readonly ExtensionSourceRoot[] = Object.freeze([
    Object.freeze({ scope: "user", kind: "plugin", path: path.join(globalStateDir, "plugins") }),
    Object.freeze({
      scope: "project",
      kind: "plugin",
      path: path.join(workspaceStateDir, "plugins"),
    }),
    Object.freeze({
      scope: "user",
      kind: "loose-skill",
      path: path.join(globalStateDir, "skills"),
    }),
    Object.freeze({
      scope: "project",
      kind: "loose-skill",
      path: path.join(workspaceStateDir, "skills"),
    }),
  ]);
  return Object.freeze({ roots });
}

/** Resolve roots from the already-bound workspace and the app's global path authority. */
export function resolveConfiguredExtensionRoots(): ResolvedExtensionRoots {
  return resolveExtensionRoots(getWorkspaceFsPolicy().getRoot(), resolveGlobalJellyDir());
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalPathKey(canonicalPath: string): string {
  const normalized = path.normalize(canonicalPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function makeLooseSourceId(scope: ExtensionSourceScope, canonicalRoot: string): string {
  return `${scope}-${fnv1a32Hex(`${scope}\0${canonicalPathKey(canonicalRoot)}`)}`;
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (error: unknown) {
    const code = getErrnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

function unavailableDiagnostic(source: string, error: unknown): ExtensionLoadDiagnostic {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    severity: "warning",
    code: "plugin.source.missing",
    message: `Extension source could not be inspected and was skipped: ${detail}`,
    source,
  };
}

function duplicateRootDiagnostic(
  duplicate: ExtensionSourceRoot,
  kept: ExtensionSourceRoot,
): ExtensionLoadDiagnostic {
  return {
    severity: "warning",
    code: "plugin.source.duplicate",
    message:
      `Extension ${duplicate.kind} root resolves to the same directory as the ${kept.scope} root ` +
      `and was ignored: ${duplicate.path}`,
    source: duplicate.path,
  };
}

async function discoverPluginChild(
  root: ExtensionSourceRoot,
  canonicalRoot: string,
  directoryName: string,
  plugins: PluginSourceCandidate[],
  diagnostics: ExtensionLoadDiagnostic[],
): Promise<void> {
  const directoryPath = path.join(canonicalRoot, directoryName);
  const manifestPath = path.join(directoryPath, PLUGIN_MANIFEST_FILE_NAME);
  const unsupportedPath = path.join(directoryPath, UNSUPPORTED_PLUGIN_MANIFEST_FILE_NAME);
  let hasManifest: boolean;
  let hasUnsupportedManifest: boolean;
  try {
    [hasManifest, hasUnsupportedManifest] = await Promise.all([
      isFile(manifestPath),
      isFile(unsupportedPath),
    ]);
  } catch (error: unknown) {
    diagnostics.push(unavailableDiagnostic(directoryPath, error));
    return;
  }

  if (hasUnsupportedManifest) {
    diagnostics.push({
      severity: "warning",
      code: "plugin.manifest.unsupported-filename",
      message: hasManifest
        ? `${UNSUPPORTED_PLUGIN_MANIFEST_FILE_NAME} was ignored; delete it or merge it into ${PLUGIN_MANIFEST_FILE_NAME}.`
        : `Plugin manifests must be named ${PLUGIN_MANIFEST_FILE_NAME}; rename ${UNSUPPORTED_PLUGIN_MANIFEST_FILE_NAME}.`,
      source: unsupportedPath,
    });
  }
  if (hasManifest) {
    plugins.push(
      Object.freeze({
        kind: "plugin",
        scope: root.scope,
        directoryName,
        directoryPath,
        manifestPath,
      }),
    );
  }
}

async function discoverLooseSkillChild(
  root: ExtensionSourceRoot,
  canonicalRoot: string,
  sourceId: string,
  directoryName: string,
  looseSkills: LooseSkillSourceCandidate[],
  diagnostics: ExtensionLoadDiagnostic[],
): Promise<void> {
  const directoryPath = path.join(canonicalRoot, directoryName);
  const skillFilePath = path.join(directoryPath, "SKILL.md");
  let hasSkillFile: boolean;
  try {
    hasSkillFile = await isFile(skillFilePath);
  } catch (error: unknown) {
    diagnostics.push(unavailableDiagnostic(directoryPath, error));
    return;
  }
  if (hasSkillFile) {
    looseSkills.push(
      Object.freeze({
        kind: "loose-skill",
        scope: root.scope,
        sourceId,
        directoryName,
        directoryPath,
        skillFilePath,
      }),
    );
  }
}

/**
 * Enumerate only direct children of the fixed roots.
 *
 * This phase detects marker files but deliberately does not read manifests or SKILL.md. Missing
 * roots are normal. Every other root/item failure becomes data so one broken source cannot stop
 * discovery of healthy sources.
 */
export async function discoverExtensionSources(
  resolved: ResolvedExtensionRoots,
): Promise<ExtensionSourceDiscovery> {
  const plugins: PluginSourceCandidate[] = [];
  const looseSkills: LooseSkillSourceCandidate[] = [];
  const diagnostics: ExtensionLoadDiagnostic[] = [];
  const canonicalRoots = new Map<string, ExtensionSourceRoot>();

  for (const root of resolved.roots) {
    let canonicalRoot: string;
    try {
      canonicalRoot = await fs.realpath(root.path);
    } catch (error: unknown) {
      if (getErrnoCode(error) === "ENOENT") {
        continue;
      }
      diagnostics.push(unavailableDiagnostic(root.path, error));
      continue;
    }

    const dedupeKey = `${root.kind}\0${canonicalPathKey(canonicalRoot)}`;
    const keptRoot = canonicalRoots.get(dedupeKey);
    if (keptRoot) {
      diagnostics.push(duplicateRootDiagnostic(root, keptRoot));
      continue;
    }
    canonicalRoots.set(dedupeKey, root);

    let entries: Dirent[];
    try {
      entries = await fs.readdir(canonicalRoot, { withFileTypes: true });
    } catch (error: unknown) {
      diagnostics.push(unavailableDiagnostic(root.path, error));
      continue;
    }

    const directoryNames = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareCodeUnits);

    if (root.kind === "plugin") {
      for (const directoryName of directoryNames) {
        await discoverPluginChild(root, canonicalRoot, directoryName, plugins, diagnostics);
      }
    } else {
      const sourceId = makeLooseSourceId(root.scope, canonicalRoot);
      for (const directoryName of directoryNames) {
        await discoverLooseSkillChild(
          root,
          canonicalRoot,
          sourceId,
          directoryName,
          looseSkills,
          diagnostics,
        );
      }
    }
  }

  return Object.freeze({
    plugins: Object.freeze(plugins),
    looseSkills: Object.freeze(looseSkills),
    diagnostics: Object.freeze(diagnostics),
  });
}
