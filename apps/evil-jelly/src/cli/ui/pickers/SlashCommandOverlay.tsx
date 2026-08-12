/**
 * Slash-command palette overlay for the `/`-trigger in SmartLinePrompt.
 * Presentational + keyboard navigation over a controlled command list; Enter submits the
 * highlighted command, Esc dismisses. Mirrors FilePickerOverlay's interaction model.
 */

import { Box, Text } from "ink";
import type { SlashCommand } from "../../prompt-editor/slashCommands";
import type { ComposerPickerKeySink } from "./ComposerPicker";
import { ComposerPicker } from "./ComposerPicker";

interface SlashCommandOverlayProps {
  /** Filtered commands to show (already matched against the typed query). */
  commands: SlashCommand[];
  /** Called with the chosen command name (e.g. "/resume"). */
  onSelect: (name: string) => void;
  /** Called when the user dismisses the panel (Esc). */
  onCancel: () => void;
  /** Slot to publish the picker's key handler into (shared-stdin hosts). */
  keySink?: ComposerPickerKeySink;
}

export function SlashCommandOverlay({
  commands,
  onSelect,
  onCancel,
  keySink,
}: SlashCommandOverlayProps) {
  return (
    <ComposerPicker
      items={commands}
      getKey={(command) => command.name}
      onSelect={(command) => onSelect(command.name)}
      onCancel={onCancel}
      keySink={keySink}
      renderItem={(command, { selected }) => (
        <Box flexDirection="row">
          <Text color={selected ? "cyan" : undefined}>
            {selected ? "▸ " : "  "}
            {command.name}
          </Text>
          <Text dimColor> — {command.description}</Text>
        </Box>
      )}
    />
  );
}
