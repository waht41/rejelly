import type { UserSkillListItem, UserSkillReference } from "../../../../shared/host/inputBindings";
import {
  normalizePromptDocument,
  type PromptDocument,
  type PromptNode,
  promptTokens,
} from "../../../prompt-editor/promptDocument";
import type { BufferState } from "../../../prompt-editor/textBuffer";

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
  reference: UserSkillReference,
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

/** Legacy flat-text helper used to replace or clear the active `$token`. */
export function replaceSkillToken(
  state: BufferState,
  qualifiedNames: readonly string[],
): BufferState {
  const { text, cursor } = state;
  const left = text.slice(0, cursor);
  const dollar = left.lastIndexOf("$");
  if (dollar === -1) {
    return state;
  }
  const before = text.slice(0, dollar);
  const after = text.slice(cursor);
  const refs = qualifiedNames.map((name) => `$${name}`).join(" ");
  if (!refs) {
    return { text: before + after, cursor: before.length };
  }
  const insert = after.length === 0 || !/^\s/.test(after) ? `${refs} ` : refs;
  return { text: before + insert + after, cursor: before.length + insert.length };
}

function containsSelectedMarker(text: string, qualifiedName: string): boolean {
  const marker = `$${qualifiedName}`;
  let start = text.indexOf(marker);
  while (start !== -1) {
    const before = start === 0 ? "" : text[start - 1]!;
    const after = text[start + marker.length] ?? "";
    const startsAtBoundary = start === 0 || /\s/.test(before);
    const endsAtBoundary = after === "" || !/[a-z0-9._:-]/.test(after);
    if (startsAtBoundary && endsAtBoundary) {
      return true;
    }
    start = text.indexOf(marker, start + marker.length);
  }
  return false;
}

interface MarkerMatch {
  readonly start: number;
  readonly end: number;
  readonly reference: UserSkillReference;
  readonly displayText: string;
}

function selectedMarkerMatches(
  text: string,
  reference: UserSkillReference,
  displayName: string,
): MarkerMatch[] {
  const markers = new Set([`$${displayName}`, `$${reference.qualifiedName}`]);
  const matches: MarkerMatch[] = [];
  for (const marker of markers) {
    let start = text.indexOf(marker);
    while (start !== -1) {
      const before = start === 0 ? "" : text[start - 1]!;
      const after = text[start + marker.length] ?? "";
      if ((start === 0 || /\s/.test(before)) && (after === "" || !/[a-z0-9._:-]/.test(after))) {
        matches.push({
          start,
          end: start + marker.length,
          reference,
          displayText: `$${displayName}`,
        });
      }
      start = text.indexOf(marker, start + marker.length);
    }
  }
  return matches;
}

/** Rebuild semantic Skill tokens when a plain draft plus structured references is restored. */
export function hydrateSkillTokens(
  text: string,
  references: readonly UserSkillReference[],
  getDisplayName: (reference: UserSkillReference) => string,
  createId: () => string,
): PromptDocument {
  const matches = references
    .flatMap((reference) => selectedMarkerMatches(text, reference, getDisplayName(reference)))
    .sort(
      (left, right) =>
        left.start - right.start || right.end - right.start - (left.end - left.start),
    );
  const accepted: MarkerMatch[] = [];
  let end = 0;
  for (const match of matches) {
    if (match.start < end) {
      continue;
    }
    accepted.push(match);
    end = match.end;
  }

  const nodes: PromptNode[] = [];
  let offset = 0;
  for (const match of accepted) {
    if (offset < match.start) {
      nodes.push({ type: "text", text: text.slice(offset, match.start) });
    }
    nodes.push({
      type: "token",
      kind: "skill",
      id: createId(),
      qualifiedName: match.reference.qualifiedName,
      displayText: match.displayText,
    });
    offset = match.end;
  }
  if (offset < text.length) {
    nodes.push({ type: "text", text: text.slice(offset) });
  }
  return normalizePromptDocument(nodes);
}

export function skillReferencesFromDocument(document: PromptDocument): UserSkillReference[] {
  const seen = new Set<string>();
  return promptTokens(document, "skill")
    .filter((token) => {
      if (seen.has(token.qualifiedName)) {
        return false;
      }
      seen.add(token.qualifiedName);
      return true;
    })
    .map((token) => ({ qualifiedName: token.qualifiedName }));
}

/** Reconcile only already-selected references; arbitrary `$text` is never interpreted. */
export function skillReferencesPresentInText(
  text: string,
  references: readonly UserSkillReference[],
): UserSkillReference[] {
  return references.filter((reference) => containsSelectedMarker(text, reference.qualifiedName));
}
