import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { normalizeNewlines } from "../../../shared/lib/string";

const markdownProcessor = unified().use(remarkParse).use(remarkGfm);

type MarkdownRoot = ReturnType<typeof markdownProcessor.parse>;
type RootContent = MarkdownRoot["children"][number];
type Blockquote = Extract<RootContent, { type: "blockquote" }>;
type List = Extract<RootContent, { type: "list" }>;
type ListItem = List["children"][number];
type Table = Extract<RootContent, { type: "table" }>;
export type MarkdownPhrasingContent = Extract<
  RootContent,
  { type: "paragraph" }
>["children"][number];

export type TableAlignment = "left" | "center" | "right";

/**
 * Inline content keeps the mdast nodes from the document parse as the source of
 * truth. `text` is their rendered plain-text projection for width measurement.
 */
export type MarkdownInline = {
  text: string;
  nodes: MarkdownPhrasingContent[];
};

export type MarkdownListItem = MarkdownInline & {
  depth: number;
  marker: number | null;
};

export type MarkdownBlock =
  | (MarkdownInline & { type: "heading"; depth: number })
  | (MarkdownInline & { type: "paragraph" })
  | { type: "list"; ordered: boolean; items: MarkdownListItem[] }
  | { type: "table"; headers: string[]; alignments: TableAlignment[]; rows: string[][] }
  | { type: "quote"; lines: MarkdownInline[] }
  | { type: "code"; language?: string; lines: string[] }
  | { type: "rule" };

function nodeSource(markdown: string, node: RootContent): string {
  return markdown.slice(
    node.position?.start.offset ?? 0,
    node.position?.end.offset ?? markdown.length,
  );
}

function textNode(value: string): MarkdownPhrasingContent {
  return { type: "text", value };
}

function listItemNodes(item: ListItem): MarkdownPhrasingContent[] {
  const paragraphs = item.children
    .filter((child) => child.type === "paragraph")
    .map((paragraph) => paragraph.children);
  const nodes = paragraphs.flatMap((children, index) =>
    index === 0 ? children : [textNode(" "), ...children],
  );
  return typeof item.checked === "boolean"
    ? [textNode(`[${item.checked ? "x" : " "}] `), ...nodes]
    : nodes;
}

function flattenList(list: List, depth = 0): MarkdownListItem[] {
  const items: MarkdownListItem[] = [];
  let marker = list.start ?? 1;

  for (const item of list.children) {
    const nodes = listItemNodes(item);
    items.push({
      depth,
      marker: list.ordered ? marker : null,
      text: phrasingText(nodes),
      nodes,
    });
    marker++;

    for (const child of item.children) {
      if (child.type === "list") {
        items.push(...flattenList(child, depth + 1));
      }
    }
  }

  return items;
}

function tableCells(table: Table): string[][] {
  return table.children.map((row) =>
    row.children.map((cell) => phrasingText(cell.children).trim()),
  );
}

function splitPhrasingNode(node: MarkdownPhrasingContent): MarkdownPhrasingContent[][] {
  if (node.type === "break") {
    return [[], []];
  }
  if (node.type === "text" && node.value.includes("\n")) {
    return node.value.split("\n").map((value) => (value.length > 0 ? [{ ...node, value }] : []));
  }
  if ("children" in node) {
    return splitPhrasingLines(node.children).map((children) =>
      children.length > 0 ? [{ ...node, children } as MarkdownPhrasingContent] : [],
    );
  }
  return [[node]];
}

function splitPhrasingLines(nodes: MarkdownPhrasingContent[]): MarkdownPhrasingContent[][] {
  const lines: MarkdownPhrasingContent[][] = [[]];
  for (const node of nodes) {
    const nodeLines = splitPhrasingNode(node);
    lines.at(-1)?.push(...(nodeLines[0] ?? []));
    for (const line of nodeLines.slice(1)) {
      lines.push(line);
    }
  }
  return lines;
}

function blockquoteLines(quote: Blockquote): MarkdownPhrasingContent[][] {
  const lines: MarkdownPhrasingContent[][] = [];
  let previousEndLine: number | undefined;

  for (const child of quote.children) {
    const startLine = child.position?.start.line;
    if (previousEndLine !== undefined && startLine !== undefined) {
      for (let line = previousEndLine + 1; line < startLine; line++) {
        lines.push([]);
      }
    }

    if (child.type === "paragraph" || child.type === "heading") {
      lines.push(...splitPhrasingLines(child.children));
    } else if (child.type === "list") {
      for (const item of flattenList(child)) {
        const indent = "  ".repeat(item.depth);
        const marker = item.marker === null ? "- " : `${item.marker}. `;
        lines.push([textNode(`${indent}${marker}`), ...item.nodes]);
      }
    } else if (child.type === "code") {
      const fence = `\`\`\`${child.lang ?? ""}`;
      lines.push([textNode(fence)]);
      lines.push(...child.value.split("\n").map((line) => [textNode(line)]));
      lines.push([textNode("```")]);
    } else if (child.type === "blockquote") {
      lines.push(...blockquoteLines(child).map((line) => [textNode("> "), ...line]));
    } else if (child.type === "thematicBreak") {
      lines.push([textNode("---")]);
    } else if (child.type === "html") {
      lines.push([textNode(child.value)]);
    }

    previousEndLine = child.position?.end.line ?? previousEndLine;
  }
  return lines;
}

function literalParagraph(text: string): Extract<MarkdownBlock, { type: "paragraph" }> {
  const nodes = text.length > 0 ? [textNode(text)] : [];
  return { type: "paragraph", text, nodes };
}

function convertBlock(markdown: string, node: RootContent): MarkdownBlock | null {
  if (node.type === "heading") {
    const text = phrasingText(node.children);
    // While streaming, a bare marker is held back. If it is finalized as-is,
    // keep showing the literal marker instead of turning it into an empty title.
    return text.length > 0
      ? { type: "heading", depth: node.depth, text, nodes: node.children }
      : literalParagraph(nodeSource(markdown, node).trim());
  }
  if (node.type === "paragraph") {
    return { type: "paragraph", text: phrasingText(node.children), nodes: node.children };
  }
  if (node.type === "list") {
    const items = flattenList(node);
    if (items.every((item) => item.text.length === 0)) {
      return literalParagraph(nodeSource(markdown, node).trim());
    }
    return { type: "list", ordered: Boolean(node.ordered), items };
  }
  if (node.type === "table") {
    const [headers = [], ...rows] = tableCells(node);
    return {
      type: "table",
      headers,
      alignments: headers.map((_, index) => node.align?.[index] ?? "left") as TableAlignment[],
      rows,
    };
  }
  if (node.type === "blockquote") {
    return {
      type: "quote",
      lines: blockquoteLines(node).map((nodes) => ({ text: phrasingText(nodes), nodes })),
    };
  }
  if (node.type === "code") {
    return {
      type: "code",
      language: node.lang ?? undefined,
      lines: node.value.split("\n"),
    };
  }
  if (node.type === "thematicBreak") {
    return { type: "rule" };
  }
  if (node.type === "html") {
    return literalParagraph(node.value);
  }
  return null;
}

export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const normalized = normalizeNewlines(markdown);
  const tree = markdownProcessor.parse(normalized) as MarkdownRoot;
  return tree.children.flatMap((node) => {
    const block = convertBlock(normalized, node);
    return block ? [block] : [];
  });
}

export function phrasingText(nodes: MarkdownPhrasingContent[]): string {
  return nodes
    .map((node) => {
      if (node.type === "text") {
        return node.value.replace(/\n/g, " ");
      }
      if (node.type === "inlineCode") {
        return node.value;
      }
      if (node.type === "break") {
        return "\n";
      }
      if (node.type === "image") {
        return node.alt ?? "";
      }
      if (node.type === "footnoteReference") {
        return `[^${node.label ?? node.identifier}]`;
      }
      if ("children" in node) {
        return phrasingText(node.children);
      }
      return "value" in node && typeof node.value === "string" ? node.value : "";
    })
    .join("");
}
