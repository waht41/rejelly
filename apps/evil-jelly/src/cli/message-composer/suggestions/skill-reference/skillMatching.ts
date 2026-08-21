import type { UserMcpListItem, UserSkillListItem } from "../../../../shared/host/inputBindings";

export type PromptReferencePickerItem =
  | { readonly kind: "skill"; readonly skill: UserSkillListItem }
  | { readonly kind: "mcp"; readonly server: UserMcpListItem };

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
  query: string,
): PromptReferencePickerItem[] {
  const normalized = query.trim().toLowerCase();
  const items: PromptReferencePickerItem[] = [
    ...skills.map((skill) => ({ kind: "skill" as const, skill })),
    ...mcpServers.map((server) => ({ kind: "mcp" as const, server })),
  ];
  if (!normalized) return items;
  return items.filter((item) => {
    const searchable =
      item.kind === "skill"
        ? `${item.skill.qualifiedName} ${item.skill.shortDescription ?? item.skill.description}`
        : `mcp:${item.server.serverId} ${item.server.serverId}`;
    return searchable.toLowerCase().includes(normalized);
  });
}
