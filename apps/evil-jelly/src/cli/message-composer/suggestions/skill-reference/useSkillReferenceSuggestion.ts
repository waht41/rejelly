import { useCallback, useEffect, useState } from "react";
import type { UserSkillReference } from "../../../../shared/host/inputBindings";
import type { TextBuffer } from "../../editor/document/textBuffer";
import type { SkillPickerItem } from "../../session/composerStore";
import { filterSkillPickerItems } from "./skillMatching";
import {
  activeSkillTrigger,
  extractSkillQuery,
  replaceSkillToken,
  skillReferenceName,
} from "./skillTrigger";

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
  createTokenId,
  maxSelectedSkills,
  onNotice,
}: {
  buffer: TextBuffer;
  availableSkills: SkillPickerItem[];
  selectedSkills: UserSkillReference[];
  createTokenId: () => string;
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
    buffer.apply((state) => replaceSkillToken(state, []));
    setQuery(null);
  }, [buffer.apply]);
  const select = useCallback(
    (skill: SkillPickerItem) => {
      if (
        selectedSkills.length >= maxSelectedSkills &&
        !selectedSkills.some((selected) => selected.qualifiedName === skill.qualifiedName)
      ) {
        onNotice(`At most ${maxSelectedSkills} Skills can be selected for one input.`);
        buffer.apply((state) => replaceSkillToken(state, []));
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
          id: createTokenId(),
          qualifiedName: skill.qualifiedName,
          displayText: `$${skillReferenceName(skill, availableSkills)}`,
        },
        ...(after.length === 0 || !/^\s/.test(after) ? [{ type: "text" as const, text: " " }] : []),
      ]);
      setQuery(null);
    },
    [
      availableSkills,
      buffer.apply,
      buffer.cursor,
      buffer.replaceDisplayRange,
      buffer.text,
      createTokenId,
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
