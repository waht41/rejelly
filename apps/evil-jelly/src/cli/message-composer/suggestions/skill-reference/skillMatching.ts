import type {
  UserMcpListItem,
  UserMemoryListItem,
  UserSkillListItem,
} from "../../../../shared/host/inputBindings";

export type PromptReferencePickerItem =
  | { readonly kind: "skill"; readonly skill: UserSkillListItem }
  | { readonly kind: "mcp"; readonly server: UserMcpListItem }
  | { readonly kind: "memory"; readonly memory: UserMemoryListItem };

export function filterSkillPickerItems(
  items: readonly UserSkillListItem[],
  query: string,
): UserSkillListItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [...items];
  }
  return items.filter((item) => {
    const display =
      `${item.qualifiedName} ${item.shortDescription ?? item.description}`.toLowerCase();
    return display.includes(normalized);
  });
}

export function filterPromptReferencePickerItems(
  skills: readonly UserSkillListItem[],
  mcpServers: readonly UserMcpListItem[],
  memories: readonly UserMemoryListItem[],
  query: string,
): PromptReferencePickerItem[] {
  const normalized = query.trim().toLowerCase();
  const items: PromptReferencePickerItem[] = [
    ...skills.map((skill) => ({ kind: "skill" as const, skill })),
    ...mcpServers.map((server) => ({ kind: "mcp" as const, server })),
    ...memories.map((memory) => ({ kind: "memory" as const, memory })),
  ];
  if (!normalized) return items;
  return items.filter((item) => {
    const searchable =
      item.kind === "skill"
        ? `${item.skill.qualifiedName} ${item.skill.shortDescription ?? item.skill.description}`
        : item.kind === "mcp"
          ? `mcp:${item.server.serverId} ${item.server.serverId}`
          : `memory:${item.memory.id} ${item.memory.scope} ${item.memory.title} ${item.memory.summary}`;
    return searchable.toLowerCase().includes(normalized);
  });
}
