import type { UserSkillListItem } from "../../../../shared/host/inputBindings";
import {
  type PromptDocument,
  promptTokens,
  type SkillPromptToken,
} from "../../../../shared/model/prompt/promptDocument";
import type { BufferState } from "../../editor/document/textBuffer";

const SKILL_QUERY_PATTERN = /^[a-z0-9._:-]*$/;

export function skillReferenceName(
  skill: UserSkillListItem,
  catalog: readonly UserSkillListItem[],
): string {
  const duplicate = catalog.some(
    (candidate) => candidate.name === skill.name && candidate.qualifiedName !== skill.qualifiedName,
  );
  return duplicate ? skill.qualifiedName : skill.name;
}

export function selectedSkillReferenceName(
  reference: { readonly qualifiedName: string },
  catalog: readonly UserSkillListItem[],
): string {
  const skill = catalog.find((candidate) => candidate.qualifiedName === reference.qualifiedName);
  return skill ? skillReferenceName(skill, catalog) : reference.qualifiedName;
}

/** Return the lowercase Skill query in the active `$token` immediately left of the caret. */
export function extractSkillQuery(text: string, cursor: number): string | null {
  const left = text.slice(0, cursor);
  const dollar = left.lastIndexOf("$");
  if (dollar === -1) {
    return null;
  }
  if (dollar > 0 && left[dollar - 1] !== " " && left[dollar - 1] !== "\n") {
    return null;
  }
  const token = left.slice(dollar + 1);
  if (!SKILL_QUERY_PATTERN.test(token)) {
    return null;
  }
  if (cursor < text.length && !/\s/.test(text[cursor]!)) {
    return null;
  }
  return token;
}

export interface ActiveSkillTrigger {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

export function activeSkillTrigger(text: string, cursor: number): ActiveSkillTrigger | null {
  const query = extractSkillQuery(text, cursor);
  if (query === null) {
    return null;
  }
  return { start: cursor - query.length - 1, end: cursor, query };
}

/** Remove the unfinished text trigger when the picker is dismissed. */
export function removeActiveSkillTrigger(state: BufferState): BufferState {
  const { text, cursor } = state;
  const left = text.slice(0, cursor);
  const dollar = left.lastIndexOf("$");
  if (dollar === -1) {
    return state;
  }
  const before = text.slice(0, dollar);
  const after = text.slice(cursor);
  return { text: before + after, cursor: before.length };
}

export function skillTokensFromDocument(document: PromptDocument): SkillPromptToken[] {
  const seen = new Set<string>();
  return promptTokens(document, "skill").filter((token) => {
    if (seen.has(token.qualifiedName)) {
      return false;
    }
    seen.add(token.qualifiedName);
    return true;
  });
}
