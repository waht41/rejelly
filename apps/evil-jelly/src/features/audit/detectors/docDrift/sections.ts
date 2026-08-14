/**
 * Fence-aware Markdown H2 splitter for doc-drift validation (INV-0015). Sections are the audit
 * seeds: one per H1/H2 heading plus an optional preamble. Headings inside fenced code blocks must
 * NOT split (docs/api/core.md embeds `# Markdown` inside a fence), hence the fence tracking.
 */

export interface MarkdownSection {
  /** Heading text without leading hashes; `(preamble)` for content before the first heading. */
  heading: string;
  /** H1→H2 trail identifying the section, e.g. `["Core", "createAgent(config)"]`. */
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
 * Split a Markdown document into H1/H2-delimited sections. H3+ headings stay inside their section.
 * Content before the first heading becomes a `(preamble)` section when non-blank.
 */
export function splitMarkdownH2Sections(markdown: string): MarkdownSection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: MarkdownSection[] = [];

  let currentH1: string | undefined;
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

    const headingMatch = /^(#{1,2})\s+(.+?)\s*$/.exec(line);
    if (!headingMatch) {
      if (!open) {
        open = { heading: "(preamble)", headingPath: ["(preamble)"], startLine: lineNo };
      }
      continue;
    }

    close(lineNo - 1);
    const level = headingMatch[1].length;
    const heading = headingMatch[2];
    if (level === 1) {
      currentH1 = heading;
      open = { heading, headingPath: [heading], startLine: lineNo };
    } else {
      open = {
        heading,
        headingPath: currentH1 !== undefined ? [currentH1, heading] : [heading],
        startLine: lineNo,
      };
    }
  }
  close(lines.length);

  return sections;
}
