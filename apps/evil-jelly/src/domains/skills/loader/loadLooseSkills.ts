import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { compareStringsByCodeUnit } from "../../../shared/foundation/string";
import type {
  SkillAccessRepository,
  SkillRecord,
  SkillResourceRepository,
} from "../definition/skillDefinition";
import { qualifiedSkillName, skillOrigin } from "../definition/skillDefinition";
import { type SkillLoadDiagnostic, skillDiagnostic } from "./diagnostics";
import { SKILL_LOADER_LIMITS } from "./limits";
import { type LoadedSkill, loadSkill, type SkillLoadCandidate } from "./skillLoader";
import {
  createSkillAccessRepository,
  createSkillResourceRepository,
} from "./skillResourceRepository";
import type { SkillSource } from "./skillSourceRoots";

export interface LoadedSkillSources {
  readonly records: readonly SkillRecord[];
  readonly access: SkillAccessRepository;
  readonly resources: SkillResourceRepository;
  readonly diagnostics: readonly SkillLoadDiagnostic[];
}

export type SkillRecordPredicate = (skill: SkillRecord) => boolean;

function compareSources(left: SkillSource, right: SkillSource): number {
  if (left.scope !== right.scope) {
    return left.scope === "user" ? -1 : 1;
  }
  return compareStringsByCodeUnit(left.rootPath, right.rootPath);
}

interface SourceCandidatesResult {
  readonly candidates: readonly SkillLoadCandidate[];
  readonly diagnostics: readonly SkillLoadDiagnostic[];
}

/** Enumerate only direct child directories from one already-canonical fixed source. */
async function collectSkillCandidates(source: SkillSource): Promise<SourceCandidatesResult> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(source.rootPath, { withFileTypes: true });
  } catch (error: unknown) {
    return {
      candidates: Object.freeze([]),
      diagnostics: Object.freeze([
        skillDiagnostic(
          "skill.source.invalid",
          `Skill source could not be read: ${error instanceof Error ? error.message : String(error)}`,
          source.rootPath,
          skillOrigin(source.scope),
        ),
      ]),
    };
  }

  const origin = skillOrigin(source.scope);
  const candidates: SkillLoadCandidate[] = [];
  const diagnostics: SkillLoadDiagnostic[] = [];
  entries.sort((left, right) => compareStringsByCodeUnit(left.name, right.name));
  for (const entry of entries) {
    const directoryPath = path.join(source.rootPath, entry.name);
    if (entry.isSymbolicLink()) {
      diagnostics.push(
        skillDiagnostic(
          "skill.directory.invalid",
          "Skill directory symlinks and junctions are disabled.",
          directoryPath,
          origin,
        ),
      );
      continue;
    }
    if (!entry.isDirectory()) {
      continue;
    }
    candidates.push(
      Object.freeze({ scope: source.scope, directoryName: entry.name, directoryPath }),
    );
  }

  if (candidates.length > SKILL_LOADER_LIMITS.skillsPerSource) {
    diagnostics.push(
      skillDiagnostic(
        "skill.source.limit-exceeded",
        `The ${source.scope} Skill source exposes ${candidates.length} directories; only the first ${SKILL_LOADER_LIMITS.skillsPerSource} were inspected.`,
        source.rootPath,
        origin,
      ),
    );
    candidates.length = SKILL_LOADER_LIMITS.skillsPerSource;
  }
  return Object.freeze({
    candidates: Object.freeze(candidates),
    diagnostics: Object.freeze(diagnostics),
  });
}

function rejectDuplicateSkills(
  loaded: readonly LoadedSkill[],
  diagnostics: SkillLoadDiagnostic[],
): LoadedSkill[] {
  const byQualifiedName = new Map<string, LoadedSkill[]>();
  for (const skill of loaded) {
    const name = qualifiedSkillName(skill.record);
    const group = byQualifiedName.get(name) ?? [];
    group.push(skill);
    byQualifiedName.set(name, group);
  }

  const accepted: LoadedSkill[] = [];
  for (const name of [...byQualifiedName.keys()].sort(compareStringsByCodeUnit)) {
    const group = byQualifiedName.get(name)!;
    if (group.length === 1) {
      accepted.push(group[0]!);
      continue;
    }
    for (const skill of group) {
      diagnostics.push(
        skillDiagnostic(
          "skill.name.duplicate",
          `Qualified Skill name ${name} is declared more than once; every duplicate was skipped.`,
          skill.location.rootRealPath,
          skill.record.origin,
        ),
      );
    }
  }
  return accepted;
}

/** Load the two fixed loose Skill sources into immutable records and a path-owning repository. */
export async function loadLooseSkills(
  sources: readonly SkillSource[],
  includeSkill: SkillRecordPredicate = () => true,
): Promise<LoadedSkillSources> {
  const diagnostics: SkillLoadDiagnostic[] = [];
  const candidates: SkillLoadCandidate[] = [];

  for (const source of [...sources].sort(compareSources)) {
    try {
      const collected = await collectSkillCandidates(source);
      diagnostics.push(...collected.diagnostics);
      candidates.push(...collected.candidates);
    } catch (error: unknown) {
      diagnostics.push(
        skillDiagnostic(
          "skill.source.invalid",
          `Skill discovery failed and the source was skipped: ${error instanceof Error ? error.message : String(error)}`,
          source.rootPath,
          skillOrigin(source.scope),
        ),
      );
    }
  }

  const loadedSkills: LoadedSkill[] = [];
  for (const candidate of candidates) {
    try {
      const result = await loadSkill(candidate);
      diagnostics.push(...result.diagnostics);
      if (result.ok) {
        loadedSkills.push(result.skill);
      }
    } catch (error: unknown) {
      diagnostics.push(
        skillDiagnostic(
          "skill.load.failed",
          `Skill loading failed and the Skill was skipped: ${error instanceof Error ? error.message : String(error)}`,
          candidate.directoryPath,
          skillOrigin(candidate.scope),
        ),
      );
    }
  }

  const accepted = rejectDuplicateSkills(
    loadedSkills.filter((skill) => includeSkill(skill.record)),
    diagnostics,
  ).sort((left, right) =>
    compareStringsByCodeUnit(qualifiedSkillName(left.record), qualifiedSkillName(right.record)),
  );
  const records = Object.freeze(accepted.map((skill) => skill.record));
  const locations = accepted.map((skill) => skill.location);
  const access = createSkillAccessRepository(locations);
  const resources = createSkillResourceRepository(locations);

  return Object.freeze({
    records,
    access,
    resources,
    diagnostics: Object.freeze(diagnostics),
  });
}
