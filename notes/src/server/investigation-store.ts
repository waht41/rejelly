import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  InvestigationDetail,
  InvestigationMetadata,
  InvestigationSummary,
} from "../shared/investigations";

const investigationIdPattern = /^(INV-\d{4})(?:-(.+))?\.md$/;

const requiredMetadataSchema = z.object({
  title: z.string().min(1),
  status: z.enum(["active", "later", "resolved", "superseded", "archived"]),
  createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  type: z.literal("investigation"),
});

export class InvestigationStore {
  readonly investigationsDir: string;

  constructor(repoRoot: string) {
    this.investigationsDir = path.join(repoRoot, "notes", "investigations");
  }

  async listInvestigations(): Promise<InvestigationSummary[]> {
    const files = await this.listInvestigationFiles();
    const investigations = await Promise.all(
      files.map((fileName) => this.readInvestigation(fileName)),
    );
    return investigations
      .map(({ body, frontmatter, ...summary }) => ({
        ...summary,
        synopsis: getSynopsis(body),
      }))
      .sort((a, b) => a.id.localeCompare(b.id, "en"));
  }

  async getInvestigation(id: string): Promise<InvestigationDetail | undefined> {
    const files = await this.listInvestigationFiles();
    const fileName = files.find((file) => parseInvestigationFileName(file)?.id === id);
    if (!fileName) return undefined;
    return this.readInvestigation(fileName);
  }

  private async listInvestigationFiles(): Promise<string[]> {
    const entries = await readdir(this.investigationsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && investigationIdPattern.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, "en"));
  }

  private async readInvestigation(fileName: string): Promise<InvestigationDetail> {
    const parsedName = parseInvestigationFileName(fileName);
    if (!parsedName) {
      throw new Error(`Invalid investigation filename: ${fileName}`);
    }

    const absolutePath = path.join(this.investigationsDir, fileName);
    const raw = (await readFile(absolutePath, "utf8")).replace(/\r\n/g, "\n");
    const parsed = parseMarkdownInvestigation(raw, fileName);
    const metadata = parseMetadata(parsed.frontmatter, fileName);

    return {
      id: parsedName.id,
      slug: parsedName.slug,
      fileName,
      relativePath: path.join("notes", "investigations", fileName).replace(/\\/g, "/"),
      metadata,
      synopsis: getSynopsis(parsed.body),
      body: parsed.body,
      frontmatter: parsed.frontmatter,
    };
  }
}

function parseInvestigationFileName(fileName: string): { id: string; slug: string } | undefined {
  const match = investigationIdPattern.exec(fileName);
  if (!match) return undefined;
  return {
    id: match[1],
    slug: match[2] ?? "",
  };
}

function parseMarkdownInvestigation(
  raw: string,
  fileName: string,
): { frontmatter: string; body: string } {
  if (!raw.startsWith("---\n")) {
    throw new Error(`${fileName} is missing frontmatter`);
  }

  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) {
    throw new Error(`${fileName} has unterminated frontmatter`);
  }

  return {
    frontmatter: raw.slice(4, end).trim(),
    body: raw.slice(end + "\n---\n".length).trim(),
  };
}

function parseMetadata(frontmatter: string, fileName: string): InvestigationMetadata {
  const lines = frontmatter.split("\n");
  const metadata: Record<string, unknown> = {};
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const blockMatch = /^([A-Za-z][\w-]*):\s*$/.exec(line);
    if (blockMatch) {
      const key = blockMatch[1];
      const blockLines: string[] = [];
      index += 1;
      while (index < lines.length && /^\s+/.test(lines[index])) {
        blockLines.push(lines[index]);
        index += 1;
      }
      metadata[key] = parseBlockValue(blockLines);
      continue;
    }

    const scalarMatch = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!scalarMatch) {
      throw new Error(`${fileName} has invalid frontmatter line: ${line}`);
    }
    metadata[scalarMatch[1]] = parseInlineValue(scalarMatch[2]);
    index += 1;
  }

  const required = requiredMetadataSchema.parse(metadata);
  return {
    ...metadata,
    ...required,
  } as InvestigationMetadata;
}

function parseInlineValue(raw: string): unknown {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => parseInlineValue(item));
  }
  return stripQuotes(value);
}

function parseBlockValue(lines: string[]): unknown {
  const items: unknown[] = [];
  let current: Record<string, unknown> | undefined;

  for (const line of lines) {
    const itemMatch = /^\s*-\s*(.*)$/.exec(line);
    if (itemMatch) {
      if (current) items.push(current);
      current = {};
      const inline = itemMatch[1].trim();
      if (inline) {
        const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(inline);
        if (pair) current[pair[1]] = parseInlineValue(pair[2]);
        else {
          items.push(parseInlineValue(inline));
          current = undefined;
        }
      }
      continue;
    }

    const propMatch = /^\s+([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (propMatch && current) {
      current[propMatch[1]] = parseInlineValue(propMatch[2]);
    }
  }

  if (current && Object.keys(current).length > 0) items.push(current);
  return items;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function getSynopsis(body: string): string {
  return (
    body
      .split("\n")
      .map((line) => line.replace(/^>\s*/, "").trim())
      .find((line) => line && !line.startsWith("#") && line !== "---") ?? ""
  );
}
