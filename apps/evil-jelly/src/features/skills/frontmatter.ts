import type { Pair, Node as YamlNode } from "yaml";
import { isAlias, isMap, isPair, isScalar, isSeq, parseDocument } from "yaml";
import { z } from "zod";
import { EXTENSION_LIMITS } from "../../shared/extensionLimits";
import { validateSkillName } from "./contracts";

const metadataSchema = z
  .object({
    "short-description": z.string().trim().min(1).max(EXTENSION_LIMITS.descriptionChars).optional(),
  })
  .passthrough();

const frontmatterSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().trim().min(1).max(EXTENSION_LIMITS.descriptionChars),
    metadata: metadataSchema.optional(),
  })
  .passthrough();

export interface ParsedSkillMarkdown {
  readonly name: string;
  readonly description: string;
  readonly shortDescription?: string;
  readonly instruction: string;
  readonly extras: Readonly<Record<string, unknown>>;
}

export type SkillMarkdownParseResult =
  | { readonly ok: true; readonly value: ParsedSkillMarkdown }
  | { readonly ok: false; readonly reason: string };

function failure(reason: string): SkillMarkdownParseResult {
  return { ok: false, reason };
}

function splitFrontmatter(
  raw: string,
):
  | { readonly ok: true; readonly yaml: string; readonly body: string }
  | { readonly ok: false; readonly reason: string } {
  const text = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  const firstLineEnd = text.indexOf("\n");
  if (firstLineEnd < 0 || text.slice(0, firstLineEnd).replace(/\r$/, "") !== "---") {
    return { ok: false, reason: "SKILL.md must start with a YAML frontmatter delimiter." };
  }

  let lineStart = firstLineEnd + 1;
  // Byte accounting is incremental. Re-measuring from offset 0 each line would be quadratic in the
  // size of an unterminated block, which is exactly the input the limit exists to reject.
  let consumedBytes = Buffer.byteLength(text.slice(0, lineStart), "utf8");
  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/, "");
    const blockEnd = newline < 0 ? lineEnd : newline + 1;
    consumedBytes += Buffer.byteLength(text.slice(lineStart, blockEnd), "utf8");
    if (consumedBytes > EXTENSION_LIMITS.frontmatterBytes) {
      return {
        ok: false,
        reason: `Frontmatter exceeds ${EXTENSION_LIMITS.frontmatterBytes} bytes.`,
      };
    }
    if (line === "---") {
      return {
        ok: true,
        yaml: text.slice(firstLineEnd + 1, lineStart),
        body: text.slice(blockEnd),
      };
    }
    if (newline < 0) {
      break;
    }
    lineStart = newline + 1;
  }
  return { ok: false, reason: "YAML frontmatter is missing its closing delimiter." };
}

function inspectYamlNode(node: YamlNode | Pair | null, depth: number): string | undefined {
  if (!node) {
    return undefined;
  }
  if (depth > EXTENSION_LIMITS.frontmatterDepth) {
    return `Frontmatter node depth exceeds ${EXTENSION_LIMITS.frontmatterDepth}.`;
  }
  if (isAlias(node)) {
    return "YAML aliases are disabled.";
  }
  if ("anchor" in node && node.anchor) {
    return "YAML anchors are disabled.";
  }
  if (isPair(node)) {
    if (isScalar(node.key) && node.key.value === "<<") {
      return "YAML merge keys are disabled.";
    }
    return (
      inspectYamlNode(node.key as YamlNode | null, depth + 1) ??
      inspectYamlNode(node.value as YamlNode | null, depth + 1)
    );
  }
  if (isMap(node) || isSeq(node)) {
    for (const item of node.items) {
      const problem = inspectYamlNode(item as YamlNode | Pair | null, depth + 1);
      if (problem) {
        return problem;
      }
    }
  }
  return undefined;
}

function invalidInstructionControl(text: string): boolean {
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (
      code <= 8 ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      (code >= 127 && code <= 159)
    ) {
      return true;
    }
  }
  return false;
}

function deepFreeze(value: unknown): unknown {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/** Parse the complete, already size-bounded UTF-8 contents of one SKILL.md. */
export function parseSkillMarkdown(raw: string, directoryName: string): SkillMarkdownParseResult {
  const split = splitFrontmatter(raw);
  if (!split.ok) {
    return failure(split.reason);
  }

  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(split.yaml, {
      schema: "core",
      customTags: [],
      merge: false,
      uniqueKeys: true,
      strict: true,
      prettyErrors: false,
    });
  } catch (error: unknown) {
    return failure(
      `Frontmatter YAML could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const yamlProblems = [...document.errors, ...document.warnings];
  if (yamlProblems.length > 0) {
    return failure(`Frontmatter YAML is invalid: ${yamlProblems[0]!.message}`);
  }
  const nodeProblem = inspectYamlNode(document.contents, 1);
  if (nodeProblem) {
    return failure(nodeProblem);
  }

  let yamlValue: unknown;
  try {
    yamlValue = document.toJS({ maxAliasCount: 0 });
  } catch (error: unknown) {
    return failure(
      `Frontmatter YAML is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = frontmatterSchema.safeParse(yamlValue);
  if (!parsed.success) {
    return failure(`Frontmatter fields failed validation: ${parsed.error.message}`);
  }

  const name = validateSkillName(parsed.data.name ?? directoryName);
  if (!name.ok) {
    return failure(name.reason);
  }
  if (invalidInstructionControl(split.body)) {
    return failure("Skill instruction contains NUL or unsupported control characters.");
  }

  const { name: _name, description, metadata, ...topLevelExtras } = parsed.data;
  const { "short-description": shortDescription, ...metadataExtras } = metadata ?? {};
  const extras: Record<string, unknown> = { ...topLevelExtras };
  if (Object.keys(metadataExtras).length > 0) {
    extras.metadata = metadataExtras;
  }
  deepFreeze(extras);

  return {
    ok: true,
    value: Object.freeze({
      name: name.value,
      description,
      ...(shortDescription ? { shortDescription } : {}),
      instruction: split.body,
      extras: Object.freeze(extras),
    }),
  };
}
