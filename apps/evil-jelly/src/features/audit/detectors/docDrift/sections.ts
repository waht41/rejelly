/**
 * Fence-aware Markdown section splitter for doc-drift validation (INV-0015). Sections are the
 * audit seeds: one per heading through the configured depth plus an optional preamble. Headings
 * inside fenced code blocks must NOT split (docs/api/core.md embeds `# Markdown` inside a fence),
 * hence the fence tracking.
 */

export type SectionDepth = 2 | 3;

export interface MarkdownSection {
  /** Heading text without leading hashes; `(preamble)` for content before the first heading. */
  heading: string;
  /** Available heading trail through the section heading, e.g. H1→H2→H3. */
  headingPath: string[];
  /** 1-based heading line (or 1 for the preamble). */
  startLine: number;
  /** 1-based inclusive last line. */
  endLine: number;
  /** Raw section text including the heading line. */
  text: string;
}

interface OpenFence {
  marker: string;
  length: number;
}

/** Opening fence when the line starts one (CommonMark: up to 3 spaces indent, ``` or ~~~). */
function fenceOpening(line: string): OpenFence | null {
  const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!m) {
    return null;
  }
  return { marker: m[1][0], length: m[1].length };
}

/** Whether the line closes the given open fence (same char, at least as long, nothing else). */
function closesFence(line: string, open: OpenFence): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return m !== null && m[1][0] === open.marker && m[1].length >= open.length;
}

/**
 * Split a Markdown document at headings through `sectionDepth` (H2 by default). Deeper headings
 * stay inside their parent section. Content before the first split heading becomes a `(preamble)`
 * section when non-blank.
 */
export function splitMarkdownSections(
  markdown: string,
  sectionDepth: SectionDepth = 2,
): MarkdownSection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: MarkdownSection[] = [];

  const ancestors: Array<string | undefined> = [];
  let open: { heading: string; headingPath: string[]; startLine: number } | null = null;
  let fence: OpenFence | null = null;

  const close = (endLine: number) => {
    if (!open || endLine < open.startLine) {
      open = null;
      return;
    }
    const text = lines.slice(open.startLine - 1, endLine).join("\n");
    if (text.trim().length > 0) {
      sections.push({ ...open, endLine, text });
    }
    open = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    if (fence) {
      if (closesFence(line, fence)) {
        fence = null;
      }
      continue;
    }
    const opening = fenceOpening(line);
    if (opening) {
      fence = opening;
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    const level = headingMatch?.[1].length;
    if (!headingMatch || level === undefined || level > sectionDepth) {
      if (!open) {
        open = { heading: "(preamble)", headingPath: ["(preamble)"], startLine: lineNo };
      }
      continue;
    }

    close(lineNo - 1);
    const heading = headingMatch[2];
    ancestors.length = level - 1;
    ancestors[level - 1] = heading;
    open = {
      heading,
      headingPath: ancestors.filter((ancestor): ancestor is string => ancestor !== undefined),
      startLine: lineNo,
    };
  }
  close(lines.length);

  return sections;
}
