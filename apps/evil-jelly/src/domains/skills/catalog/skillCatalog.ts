import { fnv1a32Hex } from "../../../shared/foundation/fnv1a";
import { compareStringsByCodeUnit } from "../../../shared/foundation/string";
import type { SkillOrigin, SkillRecord } from "../definition/skillDefinition";
import { qualifiedSkillName } from "../definition/skillDefinition";
import { truncateSkillDisplayText } from "./displayText";
import { SKILL_CATALOG_LIMITS } from "./limits";

export type SkillResolveResult =
  | { readonly ok: true; readonly skill: SkillRecord }
  | {
      readonly ok: false;
      readonly reason: "not-found" | "ambiguous";
      readonly candidates: readonly string[];
    };

export interface SkillListItem {
  readonly name: string;
  readonly qualifiedName: string;
  readonly description: string;
  readonly shortDescription?: string;
  readonly origin: SkillOrigin;
}

export interface SkillListPage {
  readonly items: readonly SkillListItem[];
  readonly nextCursor?: string;
  readonly returned: number;
  readonly total: number;
}

export type SkillListResult =
  | { readonly ok: true; readonly page: SkillListPage }
  | { readonly ok: false; readonly reason: "invalid-cursor" };

/** Immutable query surface built once at the composition root. */
export interface SkillCatalogSnapshot {
  readonly size: number;
  readonly fingerprint: string;
  readonly entries: readonly SkillRecord[];
  resolve(name: string): SkillResolveResult;
  list(cursor?: string): SkillListResult;
}

const CURSOR_PREFIX = "skill-v1";
const MAX_CURSOR_CHARS = 128;
const MAX_SUGGESTIONS = 5;
const MAX_SUGGESTION_QUERY_CHARS = 128;

function toListItem(record: SkillRecord): SkillListItem {
  return Object.freeze({
    name: record.name,
    qualifiedName: qualifiedSkillName(record),
    description: truncateSkillDisplayText(
      record.description,
      SKILL_CATALOG_LIMITS.listingDescriptionChars,
    ),
    ...(record.shortDescription
      ? {
          shortDescription: truncateSkillDisplayText(
            record.shortDescription,
            SKILL_CATALOG_LIMITS.listingDescriptionChars,
          ),
        }
      : {}),
    origin: record.origin,
  });
}

function cursorFor(key: string, offset: number): string {
  return Buffer.from(`${CURSOR_PREFIX}:${key}:${offset}`, "utf8").toString("base64url");
}

function parseCursor(cursor: string, key: string, total: number): number | undefined {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_CHARS) {
    return undefined;
  }
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
  const match = /^skill-v1:([0-9a-f]{8}):([1-9]\d*)$/.exec(decoded);
  if (!match || match[1] !== key) {
    return undefined;
  }
  const offset = Number(match[2]);
  return Number.isSafeInteger(offset) && offset < total ? offset : undefined;
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (left.length === 0) {
    return right.length;
  }
  if (right.length === 0) {
    return left.length;
  }

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      current.push(
        Math.min(
          current[rightIndex]! + 1,
          previous[rightIndex + 1]! + 1,
          previous[rightIndex]! + (left[leftIndex] === right[rightIndex] ? 0 : 1),
        ),
      );
    }
    previous = current;
  }
  return previous[right.length]!;
}

function suggestions(query: string, entries: readonly SkillRecord[]): readonly string[] {
  const boundedQuery = [...query].slice(0, MAX_SUGGESTION_QUERY_CHARS).join("");
  return Object.freeze(
    entries
      .map((record) => {
        const qualifiedName = qualifiedSkillName(record);
        return {
          qualifiedName,
          distance: Math.min(
            levenshteinDistance(boundedQuery, record.name),
            levenshteinDistance(boundedQuery, qualifiedName),
          ),
        };
      })
      .sort(
        (left, right) =>
          left.distance - right.distance ||
          compareStringsByCodeUnit(left.qualifiedName, right.qualifiedName),
      )
      .slice(0, MAX_SUGGESTIONS)
      .map((candidate) => candidate.qualifiedName),
  );
}

function pageResult(
  items: readonly SkillListItem[],
  nextCursor: string | undefined,
  total: number,
): Extract<SkillListResult, { ok: true }> {
  const page: SkillListPage = Object.freeze({
    items: Object.freeze([...items]),
    ...(nextCursor ? { nextCursor } : {}),
    returned: items.length,
    total,
  });
  return Object.freeze({ ok: true, page });
}

/** Build the immutable, path-free query surface for one Skill snapshot. */
export function createSkillCatalog(records: readonly SkillRecord[]): SkillCatalogSnapshot {
  const entries = Object.freeze(
    [...records].sort((left, right) =>
      compareStringsByCodeUnit(qualifiedSkillName(left), qualifiedSkillName(right)),
    ),
  );
  const byQualifiedName = new Map<string, SkillRecord>();
  const byPlainName = new Map<string, SkillRecord[]>();
  for (const record of entries) {
    const qualifiedName = qualifiedSkillName(record);
    if (byQualifiedName.has(qualifiedName)) {
      throw new Error(`Skill catalog received duplicate qualified name ${qualifiedName}.`);
    }
    byQualifiedName.set(qualifiedName, record);
    const group = byPlainName.get(record.name) ?? [];
    group.push(record);
    byPlainName.set(record.name, group);
  }
  const listItems = Object.freeze(entries.map(toListItem));
  const catalogFingerprint = fnv1a32Hex(
    JSON.stringify(
      listItems.map((item) => [item.qualifiedName, item.description, item.shortDescription ?? ""]),
    ),
  );

  return Object.freeze({
    size: entries.length,
    fingerprint: catalogFingerprint,
    entries,
    resolve(input: string): SkillResolveResult {
      const name = input.trim();
      const qualified = byQualifiedName.get(name);
      if (qualified) {
        return Object.freeze({ ok: true, skill: qualified });
      }
      const plain = byPlainName.get(name);
      if (plain?.length === 1) {
        return Object.freeze({ ok: true, skill: plain[0]! });
      }
      if (plain && plain.length > 1) {
        return Object.freeze({
          ok: false,
          reason: "ambiguous",
          candidates: Object.freeze(plain.map(qualifiedSkillName).sort(compareStringsByCodeUnit)),
        });
      }
      return Object.freeze({
        ok: false,
        reason: "not-found",
        candidates: suggestions(name, entries),
      });
    },
    list(cursor?: string): SkillListResult {
      const offset =
        cursor === undefined ? 0 : parseCursor(cursor, catalogFingerprint, listItems.length);
      if (offset === undefined) {
        return Object.freeze({ ok: false, reason: "invalid-cursor" });
      }

      const items: SkillListItem[] = [];
      for (
        let index = offset;
        index < listItems.length && items.length < SKILL_CATALOG_LIMITS.listPageEntries;
        index += 1
      ) {
        const tentative = [...items, listItems[index]!];
        const nextOffset = offset + tentative.length;
        const nextCursor =
          nextOffset < listItems.length ? cursorFor(catalogFingerprint, nextOffset) : undefined;
        const candidate = pageResult(tentative, nextCursor, listItems.length);
        if (JSON.stringify(candidate.page).length > SKILL_CATALOG_LIMITS.listPageOutputChars) {
          break;
        }
        items.push(listItems[index]!);
      }

      const nextOffset = offset + items.length;
      const nextCursor =
        nextOffset < listItems.length ? cursorFor(catalogFingerprint, nextOffset) : undefined;
      return pageResult(items, nextCursor, listItems.length);
    },
  });
}
