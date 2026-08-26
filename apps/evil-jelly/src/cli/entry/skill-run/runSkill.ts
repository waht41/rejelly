import path from "node:path";
import type { SkillRuntimeSnapshot } from "../../../domains/skills/agent/skillRuntime";
import { buildConfiguredSkillRuntimeSnapshot } from "../../skill-runtime/configuredRuntime";
import type { SkillManagementCommand } from "./args";

type SkillRecord = SkillRuntimeSnapshot["catalog"]["entries"][number];

function qualifiedName(skill: SkillRecord): string {
  return `${skill.origin.scope}:${skill.name}`;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function resolveSkill(snapshot: SkillRuntimeSnapshot, name: string): SkillRecord {
  const resolved = snapshot.catalog.resolve(name);
  if (resolved.ok) return resolved.skill;
  if (resolved.reason === "ambiguous") {
    throw new Error(
      `Skill name "${name}" is ambiguous. Use one of: ${resolved.candidates.join(", ")}.`,
    );
  }
  const suggestions =
    resolved.candidates.length > 0 ? ` Similar Skills: ${resolved.candidates.join(", ")}.` : "";
  throw new Error(`Skill not found: ${name}.${suggestions}`);
}

function listProjection(snapshot: SkillRuntimeSnapshot): object {
  return {
    type: "skill_list_v1",
    total: snapshot.catalog.size,
    fingerprint: snapshot.catalog.fingerprint,
    skills: snapshot.catalog.entries.map((skill) => ({
      name: skill.name,
      qualifiedName: qualifiedName(skill),
      scope: skill.origin.scope,
      description: skill.description,
      ...(skill.shortDescription ? { shortDescription: skill.shortDescription } : {}),
      resourceCount: skill.resources.length,
    })),
  };
}

function detailProjection(snapshot: SkillRuntimeSnapshot, name: string): object {
  const skill = resolveSkill(snapshot, name);
  const access = snapshot.access.get(skill);
  return {
    type: "skill_v1",
    skill: {
      name: skill.name,
      qualifiedName: qualifiedName(skill),
      scope: skill.origin.scope,
      description: skill.description,
      ...(skill.shortDescription ? { shortDescription: skill.shortDescription } : {}),
      instructionCharacters: skill.instruction.length,
      access: {
        kind: access.kind,
        rootPath: access.rootPath,
        mainResource: access.mainResource,
        mainPath: path.join(access.rootPath, access.mainResource),
        pathConvention: access.pathConvention,
        policy: "locator_only",
      },
      resources: skill.resources,
    },
  };
}

export async function runSkillCommand(command: SkillManagementCommand): Promise<void> {
  const built = await buildConfiguredSkillRuntimeSnapshot();
  switch (command.action) {
    case "list":
      printJson(listProjection(built.snapshot));
      return;
    case "show":
      printJson(detailProjection(built.snapshot, command.name));
      return;
    case "doctor":
      printJson({
        type: "skill_doctor_v1",
        loaded: built.snapshot.catalog.size,
        fingerprint: built.snapshot.catalog.fingerprint,
        warnings: built.diagnostics.length,
        diagnostics: built.diagnostics,
      });
      return;
  }
}
