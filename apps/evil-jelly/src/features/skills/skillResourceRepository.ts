import path from "node:path";
import { fromPosixPath } from "../../shared/lib/path";
import { readBoundedUtf8File } from "./boundedTextFile";
import { resolveContainedPath, validateRelativeSkillPath } from "./containedPath";
import type { SkillRecord, SkillResourceReadResult, SkillResourceRepository } from "./contracts";
import { SKILL_LIMITS } from "./limits";

export interface LoadedSkillLocation {
  readonly skill: SkillRecord;
  readonly rootRealPath: string;
}

function result(
  reason: Exclude<SkillResourceReadResult, { ok: true }>["reason"],
  message: string,
): SkillResourceReadResult {
  return { ok: false, reason, message };
}

/** Build a path-owning repository while keeping the immutable SkillRecord path-free. */
export function createSkillResourceRepository(
  locations: readonly LoadedSkillLocation[],
): SkillResourceRepository {
  const roots = new WeakMap<SkillRecord, string>();
  for (const location of locations) {
    roots.set(location.skill, location.rootRealPath);
  }

  return Object.freeze({
    async readText(skill: SkillRecord, resourcePath: string): Promise<SkillResourceReadResult> {
      const rootRealPath = roots.get(skill);
      if (!rootRealPath) {
        // Catalog and repository are built from the same immutable record set, so a record with
        // no location is a broken host invariant rather than a model-facing input error.
        throw new Error(
          "Skill resource repository received a record that is not part of this snapshot.",
        );
      }
      const lexicalError = validateRelativeSkillPath(resourcePath);
      const normalized = path.posix.normalize(resourcePath);
      if (
        lexicalError ||
        normalized === "." ||
        normalized.startsWith("../") ||
        path.posix.isAbsolute(normalized)
      ) {
        return result("resource-escape", "Resource path must stay inside the selected skill.");
      }
      const inventoryEntry = skill.resources.find((entry) => entry.path === normalized);
      if (!inventoryEntry) {
        return result("resource-not-listed", "Resource is not present in the skill inventory.");
      }

      const contained = await resolveContainedPath(rootRealPath, fromPosixPath(normalized), "file");
      if (!contained.ok) {
        if (contained.reason === "missing") {
          return result("resource-missing", "Resource no longer exists in the skill snapshot.");
        }
        return result("resource-escape", "Resource failed its containment check.");
      }

      const file = await readBoundedUtf8File(contained.realPath, SKILL_LIMITS.resourceReadBytes);
      if (!file.ok && file.reason === "unavailable") {
        return result("resource-missing", "Resource could not be read from the skill snapshot.");
      }
      if (!file.ok && file.reason === "too-large") {
        return result(
          "resource-too-large",
          `Resource exceeds the ${SKILL_LIMITS.resourceReadBytes} byte read limit.`,
        );
      }
      if (!file.ok) {
        return result("unsupported-binary-resource", "Resource is not valid UTF-8 text.");
      }
      if (file.content.includes("\0")) {
        return result("unsupported-binary-resource", "Resource contains binary NUL bytes.");
      }
      return Object.freeze({ ok: true, content: file.content, resource: inventoryEntry });
    },
  });
}
