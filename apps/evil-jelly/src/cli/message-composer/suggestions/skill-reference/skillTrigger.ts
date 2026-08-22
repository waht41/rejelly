import type {
  UserMcpListItem,
  UserMemoryListItem,
  UserSkillListItem,
} from "../../../../shared/host/inputBindings";
import {
  type McpPromptToken,
  type MemoryPromptToken,
  type PromptDocument,
  promptTokens,
  type SkillPromptToken,
} from "../../../../shared/model/prompt/promptDocument";
import type { BufferState } from "../../editor/document/textBuffer";

const REFERENCE_QUERY_PATTERN = /^[\p{L}\p{N}._:-]*$/u;

export function skillReferenceName(
  skill: UserSkillListItem,
  catalog: readonly UserSkillListItem[],
  mcpCatalog: readonly UserMcpListItem[] = [],
): string {
  const duplicate =
    catalog.some(
      (candidate) =>
        candidate.name === skill.name && candidate.qualifiedName !== skill.qualifiedName,
    ) || mcpCatalog.some((candidate) => candidate.serverId === skill.name);
  return duplicate ? skill.qualifiedName : skill.name;
}

export function selectedSkillReferenceName(
  reference: { readonly qualifiedName: string },
  catalog: readonly UserSkillListItem[],
  mcpCatalog: readonly UserMcpListItem[] = [],
): string {
  const skill = catalog.find((candidate) => candidate.qualifiedName === reference.qualifiedName);
  return skill ? skillReferenceName(skill, catalog, mcpCatalog) : reference.qualifiedName;
}

export function mcpReferenceName(
  reference: { readonly serverId: string },
  skillCatalog: readonly UserSkillListItem[],
): string {
  return skillCatalog.some((skill) => skill.name === reference.serverId)
    ? `mcp:${reference.serverId}`
    : reference.serverId;
}

export function memoryReferenceName(
  reference: { readonly memoryId: string },
  memoryCatalog: readonly UserMemoryListItem[],
  skillCatalog: readonly UserSkillListItem[] = [],
  mcpCatalog: readonly UserMcpListItem[] = [],
): string {
  const memory = memoryCatalog.find((candidate) => candidate.id === reference.memoryId);
  if (!memory) return `memory:${reference.memoryId}`;
  const sameTitle = memoryCatalog.filter((candidate) => candidate.title === memory.title);
  const sameScope = sameTitle.filter((candidate) => candidate.scope === memory.scope);
  const scopedName =
    sameTitle.length === 1
      ? memory.title
      : sameScope.length === 1
        ? `${memory.scope}:${memory.title}`
        : `${memory.scope}:${memory.title}:${memory.id.slice(-8)}`;
  const conflictsWithAnotherKind =
    skillCatalog.some((skill) => skill.name === memory.title) ||
    mcpCatalog.some((server) => server.serverId === memory.title);
  return conflictsWithAnotherKind ? `memory:${scopedName}` : scopedName;
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
  if (!REFERENCE_QUERY_PATTERN.test(token) || token !== token.toLocaleLowerCase()) {
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

export function mcpTokensFromDocument(document: PromptDocument): McpPromptToken[] {
  const seen = new Set<string>();
  return promptTokens(document, "mcp").filter((token) => {
    if (seen.has(token.serverId)) return false;
    seen.add(token.serverId);
    return true;
  });
}

export function memoryTokensFromDocument(document: PromptDocument): MemoryPromptToken[] {
  const seen = new Set<string>();
  return promptTokens(document, "memory").filter((token) => {
    if (seen.has(token.memoryId)) return false;
    seen.add(token.memoryId);
    return true;
  });
}
