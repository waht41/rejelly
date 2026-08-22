import type {
  UserMcpListItem,
  UserMemoryListItem,
  UserSkillListItem,
} from "../../../../shared/host/inputBindings";

export function skillReferenceName(
  skill: UserSkillListItem,
  catalog: readonly UserSkillListItem[],
  mcpCatalog: readonly UserMcpListItem[] = [],
): string {
  const duplicate =
    catalog.some(
      (candidate) =>
        candidate.name === skill.name && candidate.qualifiedName !== skill.qualifiedName,
    ) || mcpCatalog.some((candidate) => candidate.serverId === skill.name);
  return duplicate ? skill.qualifiedName : skill.name;
}

export function selectedSkillReferenceName(
  reference: { readonly qualifiedName: string },
  catalog: readonly UserSkillListItem[],
  mcpCatalog: readonly UserMcpListItem[] = [],
): string {
  const skill = catalog.find((candidate) => candidate.qualifiedName === reference.qualifiedName);
  return skill ? skillReferenceName(skill, catalog, mcpCatalog) : reference.qualifiedName;
}

export function mcpReferenceName(
  reference: { readonly serverId: string },
  skillCatalog: readonly UserSkillListItem[],
): string {
  return skillCatalog.some((skill) => skill.name === reference.serverId)
    ? `mcp:${reference.serverId}`
    : reference.serverId;
}

export function memoryReferenceName(
  reference: { readonly memoryId: string },
  memoryCatalog: readonly UserMemoryListItem[],
  skillCatalog: readonly UserSkillListItem[] = [],
  mcpCatalog: readonly UserMcpListItem[] = [],
): string {
  const memory = memoryCatalog.find((candidate) => candidate.id === reference.memoryId);
  if (!memory) return `memory:${reference.memoryId}`;
  const sameTitle = memoryCatalog.filter((candidate) => candidate.title === memory.title);
  const sameScope = sameTitle.filter((candidate) => candidate.scope === memory.scope);
  const scopedName =
    sameTitle.length === 1
      ? memory.title
      : sameScope.length === 1
        ? `${memory.scope}:${memory.title}`
        : `${memory.scope}:${memory.title}:${memory.id.slice(-8)}`;
  const conflictsWithAnotherKind =
    skillCatalog.some((skill) => skill.name === memory.title) ||
    mcpCatalog.some((server) => server.serverId === memory.title);
  return conflictsWithAnotherKind ? `memory:${scopedName}` : scopedName;
}
