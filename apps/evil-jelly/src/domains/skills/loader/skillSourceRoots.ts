import fs from "node:fs/promises";
import path from "node:path";
import { getErrnoCode } from "../../../shared/foundation/errno";
import type { SkillScope } from "../definition/skillDefinition";
import { type SkillLoadDiagnostic, skillDiagnostic } from "./diagnostics";

/** One fixed loose Skill root. Paths are host-only and never enter model-facing records. */
export interface SkillSourceRoot {
  readonly scope: SkillScope;
  readonly path: string;
}

export interface ResolvedSkillRoots {
  readonly roots: readonly SkillSourceRoot[];
}

/** An existing, canonical loose Skill source ready for direct-child enumeration. */
export interface SkillSource {
  readonly scope: SkillScope;
  readonly rootPath: string;
}

export interface SkillSourceDiscovery {
  readonly sources: readonly SkillSource[];
  readonly diagnostics: readonly SkillLoadDiagnostic[];
}

/** Resolve the two fixed roots without touching the filesystem. */
export function resolveSkillRoots(
  workspaceRoot: string,
  globalJellyDir: string,
): ResolvedSkillRoots {
  const roots: readonly SkillSourceRoot[] = Object.freeze([
    Object.freeze({ scope: "user", path: path.join(path.resolve(globalJellyDir), "skills") }),
    Object.freeze({
      scope: "project",
      path: path.join(path.resolve(workspaceRoot), ".evil-jelly", "skills"),
    }),
  ]);
  return Object.freeze({ roots });
}

function canonicalPathKey(canonicalPath: string): string {
  const normalized = path.normalize(canonicalPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Resolve existing fixed roots and deduplicate aliases.
 *
 * Missing roots are the normal empty state. Other failures become diagnostics so one broken root
 * cannot prevent a healthy source from loading. User is first in the fixed order and retains its
 * identity if an unusual setup aliases both roots to the same canonical directory.
 */
export async function discoverSkillSources(
  resolved: ResolvedSkillRoots,
): Promise<SkillSourceDiscovery> {
  const sources: SkillSource[] = [];
  const diagnostics: SkillLoadDiagnostic[] = [];
  const canonicalRoots = new Map<string, SkillSourceRoot>();

  for (const root of resolved.roots) {
    let canonicalRoot: string;
    try {
      canonicalRoot = await fs.realpath(root.path);
      if (!(await fs.stat(canonicalRoot)).isDirectory()) {
        diagnostics.push(
          skillDiagnostic(
            "skill.source.invalid",
            "Skill source root is not a directory.",
            root.path,
          ),
        );
        continue;
      }
    } catch (error: unknown) {
      if (getErrnoCode(error) === "ENOENT") {
        continue;
      }
      diagnostics.push(
        skillDiagnostic(
          "skill.source.invalid",
          `Skill source could not be inspected and was skipped: ${
            error instanceof Error ? error.message : String(error)
          }`,
          root.path,
        ),
      );
      continue;
    }

    const key = canonicalPathKey(canonicalRoot);
    const kept = canonicalRoots.get(key);
    if (kept) {
      diagnostics.push(
        skillDiagnostic(
          "skill.source.duplicate",
          `Skill source resolves to the same directory as the ${kept.scope} source and was ignored.`,
          root.path,
        ),
      );
      continue;
    }
    canonicalRoots.set(key, root);
    sources.push(Object.freeze({ scope: root.scope, rootPath: canonicalRoot }));
  }

  return Object.freeze({
    sources: Object.freeze(sources),
    diagnostics: Object.freeze(diagnostics),
  });
}
