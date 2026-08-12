import type { UserSkillListItem } from "../../../../shared/host/inputBindings";

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
