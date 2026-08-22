import { useCallback, useEffect, useState } from "react";
import type {
  MemoryPromptToken,
  SkillPromptToken,
} from "../../../../shared/model/prompt/promptDocument";
import type { TextBuffer } from "../../editor/document/textBuffer";
import type {
  McpPickerItem,
  MemoryPickerItem,
  SkillPickerItem,
} from "../../session/composerSession";
import {
  filterPromptReferencePickerItems,
  type PromptReferencePickerItem,
} from "./referenceMatching";
import {
  activeReferenceTrigger,
  extractReferenceQuery,
  removeActiveReferenceTrigger,
} from "./referenceTrigger";

export interface ReferenceSuggestion {
  matches: PromptReferencePickerItem[];
  open: boolean;
  select: (item: PromptReferencePickerItem) => void;
  dismiss: () => void;
}

export function useReferenceSuggestion({
  buffer,
  availableSkills,
  availableMcpServers,
  availableMemories,
  selectedSkills,
  selectedMemories,
  maxSelectedSkills,
  maxSelectedMemories,
  onNotice,
}: {
  buffer: TextBuffer;
  availableSkills: SkillPickerItem[];
  availableMcpServers: McpPickerItem[];
  availableMemories: MemoryPickerItem[];
  selectedSkills: SkillPromptToken[];
  selectedMemories: MemoryPromptToken[];
  maxSelectedSkills: number;
  maxSelectedMemories: number;
  onNotice: (message: string) => void;
}): ReferenceSuggestion {
  const [query, setQuery] = useState<string | null>(null);

  useEffect(() => {
    const followsSemanticToken = buffer.tokenSpans.some(
      (span) => span.start < buffer.cursor && buffer.cursor <= span.end,
    );
    setQuery(followsSemanticToken ? null : extractReferenceQuery(buffer.text, buffer.cursor));
  }, [buffer.text, buffer.cursor, buffer.tokenSpans]);

  const dismiss = useCallback(() => {
    buffer.apply(removeActiveReferenceTrigger);
    setQuery(null);
  }, [buffer.apply]);
  const select = useCallback(
    (item: PromptReferencePickerItem) => {
      if (
        item.kind === "skill" &&
        selectedSkills.length >= maxSelectedSkills &&
        !selectedSkills.some((selected) => selected.qualifiedName === item.skill.qualifiedName)
      ) {
        onNotice(`At most ${maxSelectedSkills} Skills can be selected for one input.`);
        buffer.apply(removeActiveReferenceTrigger);
        setQuery(null);
        return;
      }
      if (
        item.kind === "memory" &&
        selectedMemories.length >= maxSelectedMemories &&
        !selectedMemories.some((selected) => selected.memoryId === item.memory.id)
      ) {
        onNotice(`At most ${maxSelectedMemories} Memories can be selected for one input.`);
        buffer.apply(removeActiveReferenceTrigger);
        setQuery(null);
        return;
      }
      const trigger = activeReferenceTrigger(buffer.text, buffer.cursor);
      if (!trigger) {
        setQuery(null);
        return;
      }
      const after = buffer.text.slice(trigger.end);
      buffer.replaceDisplayRange(trigger.start, trigger.end, [
        item.kind === "skill"
          ? { type: "token", kind: "skill", qualifiedName: item.skill.qualifiedName }
          : item.kind === "mcp"
            ? { type: "token", kind: "mcp", serverId: item.server.serverId }
            : { type: "token", kind: "memory", memoryId: item.memory.id },
        ...(after.length === 0 || !/^\s/.test(after) ? [{ type: "text" as const, text: " " }] : []),
      ]);
      setQuery(null);
    },
    [
      buffer.apply,
      buffer.cursor,
      buffer.replaceDisplayRange,
      buffer.text,
      maxSelectedSkills,
      maxSelectedMemories,
      onNotice,
      selectedMemories,
      selectedSkills,
    ],
  );

  const matches =
    query === null
      ? []
      : filterPromptReferencePickerItems(
          availableSkills,
          availableMcpServers,
          availableMemories,
          query,
        );
  return {
    matches,
    open: query !== null && matches.length > 0,
    select,
    dismiss,
  };
}
