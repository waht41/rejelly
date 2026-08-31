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
import { ReferencePickerOverlay } from "./semantic-reference/ReferencePickerOverlay";
import {
  mcpReferenceName,
  memoryReferenceName,
  skillReferenceName,
} from "./semantic-reference/referenceNaming";
import type { ReferenceSuggestion } from "./semantic-reference/useReferenceSuggestion";

type CommandSuggestionView = Pick<CommandSuggestion, "matches" | "open" | "select" | "dismiss">;
type FileSuggestionView = Pick<
  FileReferenceSuggestion,
  "query" | "open" | "select" | "browse" | "dismiss"
>;
type ReferenceSuggestionView = Pick<ReferenceSuggestion, "matches" | "open" | "select" | "dismiss">;

interface ComposerSuggestionOverlayProps {
  command: CommandSuggestionView;
  file: FileSuggestionView;
  reference: ReferenceSuggestionView;
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
  reference,
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

  if (reference.open) {
    return (
      <ReferencePickerOverlay
        items={reference.matches}
        getReferenceName={(item) =>
          item.kind === "skill"
            ? skillReferenceName(item.skill, availableSkills, availableMcpServers)
            : item.kind === "mcp"
              ? mcpReferenceName(item.server, availableSkills)
              : memoryReferenceName(
                  { memoryId: item.memory.id },
                  availableMemories,
                  availableSkills,
                  availableMcpServers,
                )
        }
        maxVisibleRows={visibleRows}
        onSelect={reference.select}
        onCancel={reference.dismiss}
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
        onBrowse={file.browse}
        onCancel={file.dismiss}
        keySink={keySink}
      />
    );
  }

  return null;
}
