import type { Dirent, Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fromPosixPath } from "../../shared/lib/path";
import { compareStringsByCodeUnit } from "../../shared/lib/string";
import { readBoundedUtf8File } from "./boundedTextFile";
import { resolveContainedPath } from "./containedPath";
import type {
  SkillLoadDiagnostic,
  SkillOrigin,
  SkillRecord,
  SkillResourceEntry,
  SkillResourceKind,
  SkillScope,
} from "./contracts";
import { skillOrigin } from "./contracts";
import { skillDiagnostic } from "./diagnostics";
import { parseSkillMarkdown } from "./frontmatter";
import { SKILL_LIMITS } from "./limits";
import type { LoadedSkillLocation } from "./skillResourceRepository";

export interface SkillLoadCandidate {
  readonly scope: SkillScope;
  readonly directoryName: string;
  readonly directoryPath: string;
}

export interface LoadedSkill {
  readonly record: SkillRecord;
  readonly location: LoadedSkillLocation;
  /** Bounded, host-only frontmatter fields unknown to the v1 consumer. */
  readonly extras: Readonly<Record<string, unknown>>;
}

export type SkillLoadResult =
  | {
      readonly ok: true;
      readonly skill: LoadedSkill;
      readonly diagnostics: readonly SkillLoadDiagnostic[];
    }
  | { readonly ok: false; readonly diagnostics: readonly SkillLoadDiagnostic[] };

function failed(
  code: SkillLoadDiagnostic["code"],
  message: string,
  source: string,
): SkillLoadResult {
  return { ok: false, diagnostics: Object.freeze([skillDiagnostic(code, message, source)]) };
}

interface InventoryResult {
  readonly entries: readonly SkillResourceEntry[];
  readonly diagnostics: readonly SkillLoadDiagnostic[];
}

/**
 * Enumerate bounded resources without ever failing the skill.
 *
 * The instruction body is what a skill is for; an over-sized or over-deep resource tree truncates
 * the inventory and warns. Anything left out is simply not listed, and `read_skill_resource`
 * already refuses paths that are not in the inventory.
 */
async function inventoryResources(
  skillRootRealPath: string,
  origin: SkillOrigin,
): Promise<InventoryResult> {
  const entries: SkillResourceEntry[] = [];
  const diagnostics: SkillLoadDiagnostic[] = [];
  let truncated = false;

  async function walk(
    absoluteDirectory: string,
    relativeDirectory: string,
    kind: SkillResourceKind,
    depth: number,
  ): Promise<void> {
    if (truncated) {
      return;
    }
    let children: Dirent[];
    try {
      children = await fs.readdir(absoluteDirectory, { withFileTypes: true });
    } catch (error: unknown) {
      diagnostics.push(
        skillDiagnostic(
          "skill.resource.invalid",
          `Resource directory could not be read: ${error instanceof Error ? error.message : String(error)}`,
          absoluteDirectory,
          origin,
        ),
      );
      return;
    }
    children.sort((left, right) => compareStringsByCodeUnit(left.name, right.name));

    for (const child of children) {
      const relativePath = path.posix.join(relativeDirectory, child.name);
      const absolutePath = path.join(absoluteDirectory, child.name);
      if (child.isDirectory()) {
        if (depth >= SKILL_LIMITS.resourceDirectoryDepth) {
          diagnostics.push(
            skillDiagnostic(
              "skill.resource.limit-exceeded",
              `Resource directory depth exceeds ${SKILL_LIMITS.resourceDirectoryDepth}; deeper resources are not listed.`,
              absolutePath,
              origin,
            ),
          );
          continue;
        }
        await walk(absolutePath, relativePath, kind, depth + 1);
        continue;
      }

      if (!child.isFile() && !child.isSymbolicLink()) {
        diagnostics.push(
          skillDiagnostic(
            "skill.resource.invalid",
            "Unsupported resource entry type was skipped.",
            absolutePath,
            origin,
          ),
        );
        continue;
      }
      const contained = await resolveContainedPath(
        skillRootRealPath,
        fromPosixPath(relativePath),
        "file",
      );
      if (!contained.ok) {
        diagnostics.push(
          skillDiagnostic(
            contained.reason === "escape" || contained.reason === "symlink-directory"
              ? "skill.resource.escape"
              : "skill.resource.invalid",
            `Resource was skipped: ${contained.message}`,
            absolutePath,
            origin,
          ),
        );
        continue;
      }
      if (entries.length >= SKILL_LIMITS.resourcesPerSkill) {
        diagnostics.push(
          skillDiagnostic(
            "skill.resource.limit-exceeded",
            `Skill declares more than ${SKILL_LIMITS.resourcesPerSkill} resources; the remainder is not listed.`,
            absolutePath,
            origin,
          ),
        );
        truncated = true;
        return;
      }
      try {
        const stat = await fs.stat(contained.realPath);
        entries.push(Object.freeze({ path: relativePath, kind, sizeBytes: stat.size }));
      } catch {
        diagnostics.push(
          skillDiagnostic(
            "skill.resource.invalid",
            "Resource changed while its inventory was being built and was skipped.",
            absolutePath,
            origin,
          ),
        );
      }
    }
  }

  for (const [directoryName, kind] of [
    ["references", "reference"],
    ["assets", "asset"],
  ] as const) {
    const directoryPath = path.join(skillRootRealPath, directoryName);
    let directoryStat: Stats;
    try {
      directoryStat = await fs.lstat(directoryPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      diagnostics.push(
        skillDiagnostic(
          "skill.resource.invalid",
          "Resource root could not be inspected and was skipped.",
          directoryPath,
          origin,
        ),
      );
      continue;
    }
    if (directoryStat.isSymbolicLink()) {
      diagnostics.push(
        skillDiagnostic(
          "skill.resource.escape",
          "Resource directory symlinks and junctions are disabled.",
          directoryPath,
          origin,
        ),
      );
      continue;
    }
    if (!directoryStat.isDirectory()) {
      diagnostics.push(
        skillDiagnostic(
          "skill.resource.invalid",
          "Resource root is not a directory and was skipped.",
          directoryPath,
          origin,
        ),
      );
      continue;
    }
    await walk(directoryPath, directoryName, kind, 0);
  }

  entries.sort((left, right) => compareStringsByCodeUnit(left.path, right.path));
  return {
    entries: Object.freeze(entries),
    diagnostics: Object.freeze(diagnostics),
  };
}

/** Load one skill into an immutable record plus an internal resource location. */
export async function loadSkill(candidate: SkillLoadCandidate): Promise<SkillLoadResult> {
  const skillFilePath = path.join(candidate.directoryPath, "SKILL.md");
  const containedSkillFile = await resolveContainedPath(
    candidate.directoryPath,
    "SKILL.md",
    "file",
  );
  if (!containedSkillFile.ok) {
    return failed(
      "skill.file.invalid",
      `SKILL.md failed its path boundary: ${containedSkillFile.message}`,
      skillFilePath,
    );
  }

  const file = await readBoundedUtf8File(containedSkillFile.realPath, SKILL_LIMITS.skillFileBytes);
  if (!file.ok && file.reason === "too-large") {
    return failed(
      "skill.file.too-large",
      `SKILL.md exceeds ${SKILL_LIMITS.skillFileBytes} bytes.`,
      skillFilePath,
    );
  }
  if (!file.ok) {
    return failed(
      "skill.file.invalid",
      file.reason === "invalid-utf8"
        ? "SKILL.md is not valid UTF-8."
        : `SKILL.md could not be read: ${file.message}`,
      skillFilePath,
    );
  }
  const parsed = parseSkillMarkdown(file.content, candidate.directoryName);
  if (!parsed.ok) {
    return failed("skill.frontmatter.invalid", parsed.reason, skillFilePath);
  }

  const origin = skillOrigin(candidate.scope);
  const inventory = await inventoryResources(containedSkillFile.rootRealPath, origin);
  const record: SkillRecord = Object.freeze({
    name: parsed.value.name,
    description: parsed.value.description,
    ...(parsed.value.shortDescription ? { shortDescription: parsed.value.shortDescription } : {}),
    origin,
    instruction: parsed.value.instruction,
    resources: inventory.entries,
  });
  const location: LoadedSkillLocation = Object.freeze({
    skill: record,
    rootRealPath: containedSkillFile.rootRealPath,
  });
  return Object.freeze({
    ok: true,
    skill: Object.freeze({ record, location, extras: parsed.value.extras }),
    diagnostics: inventory.diagnostics,
  });
}
