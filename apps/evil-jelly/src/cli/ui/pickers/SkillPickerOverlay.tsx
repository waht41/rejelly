import { Box, Text } from "ink";
import stringWidth from "string-width";
import type { SkillPickerItem } from "../../store/usePromptStore";
import type { PickerKeySink } from "./ListPicker";
import { ListPicker } from "./ListPicker";

interface SkillPickerOverlayProps {
  items: SkillPickerItem[];
  getReferenceName: (skill: SkillPickerItem) => string;
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
  getReferenceName,
  onSelect,
  onCancel,
  maxVisibleRows,
  keySink,
}: SkillPickerOverlayProps) {
  const displayTitle = (item: SkillPickerItem) => `$${getReferenceName(item)}`;
  const titleColumnWidth = items.reduce(
    (width, item) => Math.max(width, stringWidth(displayTitle(item))),
    0,
  );

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
        <Box flexDirection="row">
          <Box width={titleColumnWidth + 3} flexShrink={0}>
            <Text color={selected ? "cyan" : undefined}>
              {selected ? "▸ " : "  "}
              {displayTitle(item)}
            </Text>
          </Box>
          <Box flexShrink={1}>
            <Text color={selected ? "cyan" : undefined} dimColor={!selected} wrap="truncate-end">
              [Skill] {pickerDescription(item)}
            </Text>
          </Box>
        </Box>
      )}
    />
  );
}
