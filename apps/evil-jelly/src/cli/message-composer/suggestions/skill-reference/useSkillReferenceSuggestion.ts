import { useCallback, useEffect, useState } from "react";
import type { SkillPromptToken } from "../../../../shared/model/prompt/promptDocument";
import type { TextBuffer } from "../../editor/document/textBuffer";
import type { SkillPickerItem } from "../../session/composerSession";
import { filterSkillPickerItems } from "./skillMatching";
import { activeSkillTrigger, extractSkillQuery, removeActiveSkillTrigger } from "./skillTrigger";

export interface SkillReferenceSuggestion {
  matches: SkillPickerItem[];
  open: boolean;
  select: (skill: SkillPickerItem) => void;
  dismiss: () => void;
}

export function useSkillReferenceSuggestion({
  buffer,
  availableSkills,
  selectedSkills,
  maxSelectedSkills,
  onNotice,
}: {
  buffer: TextBuffer;
  availableSkills: SkillPickerItem[];
  selectedSkills: SkillPromptToken[];
  maxSelectedSkills: number;
  onNotice: (message: string) => void;
}): SkillReferenceSuggestion {
  const [query, setQuery] = useState<string | null>(null);

  useEffect(() => {
    const followsSemanticToken = buffer.tokenSpans.some(
      (span) => span.start < buffer.cursor && buffer.cursor <= span.end,
    );
    setQuery(followsSemanticToken ? null : extractSkillQuery(buffer.text, buffer.cursor));
  }, [buffer.text, buffer.cursor, buffer.tokenSpans]);

  const dismiss = useCallback(() => {
    buffer.apply(removeActiveSkillTrigger);
    setQuery(null);
  }, [buffer.apply]);
  const select = useCallback(
    (skill: SkillPickerItem) => {
      if (
        selectedSkills.length >= maxSelectedSkills &&
        !selectedSkills.some((selected) => selected.qualifiedName === skill.qualifiedName)
      ) {
        onNotice(`At most ${maxSelectedSkills} Skills can be selected for one input.`);
        buffer.apply(removeActiveSkillTrigger);
        setQuery(null);
        return;
      }
      const trigger = activeSkillTrigger(buffer.text, buffer.cursor);
      if (!trigger) {
        setQuery(null);
        return;
      }
      const after = buffer.text.slice(trigger.end);
      buffer.replaceDisplayRange(trigger.start, trigger.end, [
        {
          type: "token",
          kind: "skill",
          qualifiedName: skill.qualifiedName,
        },
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
      onNotice,
      selectedSkills,
    ],
  );

  const matches = query === null ? [] : filterSkillPickerItems(availableSkills, query);
  return {
    matches,
    open: query !== null && matches.length > 0,
    select,
    dismiss,
  };
}
