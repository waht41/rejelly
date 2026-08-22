import type {
  UserMcpListItem,
  UserMemoryListItem,
  UserSkillListItem,
} from "../../../shared/host/inputBindings";
import type { ComposerPickerKeySink } from "./ComposerPicker";
import { SlashCommandOverlay } from "./commands/SlashCommandOverlay";
import type { CommandSuggestion } from "./commands/useCommandSuggestion";
import { FilePickerOverlay } from "./file-reference/FilePickerOverlay";
import type { FileReferenceSuggestion } from "./file-reference/useFileReferenceSuggestion";
import { SkillPickerOverlay } from "./skill-reference/SkillPickerOverlay";
import {
  mcpReferenceName,
  memoryReferenceName,
  skillReferenceName,
} from "./skill-reference/skillTrigger";
import type { SkillReferenceSuggestion } from "./skill-reference/useSkillReferenceSuggestion";

type CommandSuggestionView = Pick<CommandSuggestion, "matches" | "open" | "select" | "dismiss">;
type FileSuggestionView = Pick<FileReferenceSuggestion, "query" | "open" | "select" | "dismiss">;
type SkillSuggestionView = Pick<
  SkillReferenceSuggestion,
  "matches" | "open" | "select" | "dismiss"
>;

interface ComposerSuggestionOverlayProps {
  command: CommandSuggestionView;
  file: FileSuggestionView;
  skill: SkillSuggestionView;
  availableSkills: readonly UserSkillListItem[];
  availableMcpServers: readonly UserMcpListItem[];
  availableMemories: readonly UserMemoryListItem[];
  visibleRows: number;
  keySink: ComposerPickerKeySink;
}

/** Renders the highest-priority suggestion source that is currently active. */
export function ComposerSuggestionOverlay({
  command,
  file,
  skill,
  availableSkills,
  availableMcpServers,
  availableMemories,
  visibleRows,
  keySink,
}: ComposerSuggestionOverlayProps) {
  if (command.open) {
    return (
      <SlashCommandOverlay
        commands={command.matches}
        maxVisibleRows={visibleRows}
        onSelect={command.select}
        onCancel={command.dismiss}
        keySink={keySink}
      />
    );
  }

  if (skill.open) {
    return (
      <SkillPickerOverlay
        items={skill.matches}
        getReferenceName={(item) =>
          item.kind === "skill"
            ? skillReferenceName(item.skill, availableSkills, availableMcpServers)
            : item.kind === "mcp"
              ? mcpReferenceName(item.server, availableSkills)
              : memoryReferenceName({ memoryId: item.memory.id }, availableMemories)
        }
        maxVisibleRows={visibleRows}
        onSelect={skill.select}
        onCancel={skill.dismiss}
        keySink={keySink}
      />
    );
  }

  if (file.open) {
    return (
      <FilePickerOverlay
        query={file.query ?? ""}
        maxVisibleRows={visibleRows}
        onSelect={file.select}
        onCancel={file.dismiss}
        keySink={keySink}
      />
    );
  }

  return null;
}
