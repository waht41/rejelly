import { Text } from "ink";
import type { SkillPickerItem } from "../../store/usePromptStore";
import type { PickerKeySink } from "./ListPicker";
import { ListPicker } from "./ListPicker";

interface SkillPickerOverlayProps {
  items: SkillPickerItem[];
  onSelect: (skill: SkillPickerItem) => void;
  onCancel: () => void;
  maxVisibleRows?: number;
  keySink?: PickerKeySink;
}

function pickerDescription(item: SkillPickerItem): string {
  const text = (item.shortDescription ?? item.description).replace(/\s+/g, " ").trim();
  return text.length <= 100 ? text : `${text.slice(0, 99)}…`;
}

export function filterSkillPickerItems(
  items: readonly SkillPickerItem[],
  query: string,
): SkillPickerItem[] {
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

export function SkillPickerOverlay({
  items,
  onSelect,
  onCancel,
  maxVisibleRows,
  keySink,
}: SkillPickerOverlayProps) {
  return (
    <ListPicker
      items={items}
      getId={(item) => item.qualifiedName}
      onSelect={onSelect}
      onCancel={onCancel}
      keySink={keySink}
      emptyText="No matching Skills"
      maxVisibleRows={maxVisibleRows}
      renderItem={(item, { selected }) => (
        <Text color={selected ? "cyan" : undefined}>
          {selected ? "▸ " : "  "}${item.qualifiedName} · {pickerDescription(item)}
        </Text>
      )}
    />
  );
}
