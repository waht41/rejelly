import { Box, Text } from "ink";
import stringWidth from "string-width";
import type { ComposerPickerKeySink } from "../ComposerPicker";
import { ComposerPicker } from "../ComposerPicker";
import type { PromptReferencePickerItem } from "./skillMatching";

interface SkillPickerOverlayProps {
  items: PromptReferencePickerItem[];
  getReferenceName: (item: PromptReferencePickerItem) => string;
  onSelect: (item: PromptReferencePickerItem) => void;
  onCancel: () => void;
  maxVisibleRows?: number;
  keySink?: ComposerPickerKeySink;
}

function pickerDescription(item: PromptReferencePickerItem): string {
  if (item.kind === "mcp") return `MCP server ${item.server.serverId}`;
  if (item.kind === "memory") {
    return item.memory.summary;
  }
  const text = (item.skill.shortDescription ?? item.skill.description).replace(/\s+/g, " ").trim();
  return text.length <= 100 ? text : `${text.slice(0, 99)}…`;
}

export function SkillPickerOverlay({
  items,
  getReferenceName,
  onSelect,
  onCancel,
  maxVisibleRows,
  keySink,
}: SkillPickerOverlayProps) {
  const displayTitle = (item: PromptReferencePickerItem) => `$${getReferenceName(item)}`;
  const titleColumnWidth = items.reduce(
    (width, item) => Math.max(width, stringWidth(displayTitle(item))),
    0,
  );

  return (
    <ComposerPicker
      items={items}
      getKey={(item) =>
        item.kind === "skill"
          ? `skill:${item.skill.qualifiedName}`
          : item.kind === "mcp"
            ? `mcp:${item.server.serverId}`
            : `memory:${item.memory.id}`
      }
      onSelect={onSelect}
      onCancel={onCancel}
      keySink={keySink}
      empty={<Text dimColor>No matching references</Text>}
      visibleRows={maxVisibleRows}
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
              [{item.kind === "skill" ? "Skill" : item.kind === "mcp" ? "MCP" : "Memory"}]{" "}
              {pickerDescription(item)}
            </Text>
          </Box>
        </Box>
      )}
    />
  );
}
