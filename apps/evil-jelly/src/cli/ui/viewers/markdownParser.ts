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
type PositionedNode = {
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
};
type Parent = PositionedNode & { children: PositionedNode[] };
export type MarkdownPhrasingContent = Extract<
  RootContent,
  { type: "paragraph" }
>["children"][number];

export type TableAlignment = "left" | "center" | "right";

export type MarkdownListItem = {
  depth: number;
  marker: number | null;
  text: string;
};

export type MarkdownBlock =
  | { type: "heading"; depth: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: MarkdownListItem[] }
  | { type: "table"; headers: string[]; alignments: TableAlignment[]; rows: string[][] }
  | { type: "quote"; lines: string[] }
  | { type: "code"; language?: string; lines: string[] }
  | { type: "rule" };

const INLINE_SENTINEL = "\u{e000}";

function offset(value: number | undefined, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function nodeSource(markdown: string, node: RootContent): string {
  return markdown.slice(
    offset(node.position?.start.offset, 0),
    offset(node.position?.end.offset, markdown.length),
  );
}

function inlineSource(markdown: string, parent: Parent): string {
  const first = parent.children[0];
  const last = parent.children.at(-1);
  if (!first || !last) {
    return "";
  }
  return markdown.slice(
    offset(first.position?.start.offset, 0),
    offset(last.position?.end.offset, markdown.length),
  );
}

function normalizeSoftBreaks(value: string): string {
  return value.replace(/[ \t]*\n[ \t]*/g, " ");
}

function listItemText(markdown: string, item: ListItem): string {
  const text = item.children
    .filter((child) => child.type === "paragraph")
    .map((paragraph) => normalizeSoftBreaks(inlineSource(markdown, paragraph)))
    .join(" ");
  return typeof item.checked === "boolean" ? `[${item.checked ? "x" : " "}] ${text}` : text;
}

function flattenList(markdown: string, list: List, depth = 0): MarkdownListItem[] {
  const items: MarkdownListItem[] = [];
  let marker = list.start ?? 1;

  for (const item of list.children) {
    items.push({
      depth,
      marker: list.ordered ? marker : null,
      text: listItemText(markdown, item),
    });
    marker++;

    for (const child of item.children) {
      if (child.type === "list") {
        items.push(...flattenList(markdown, child, depth + 1));
      }
    }
  }

  return items;
}

function tableCells(table: Table): string[][] {
  return table.children.map((row) =>
    row.children.map((cell) => cell.children.map(phrasingText).join("").trim()),
  );
}

function blockquoteLines(markdown: string, quote: Blockquote): string[] {
  return nodeSource(markdown, quote)
    .split("\n")
    .map((line) => line.replace(/^\s{0,3}>\s?/, ""));
}

function convertBlock(markdown: string, node: RootContent): MarkdownBlock | null {
  if (node.type === "heading") {
    const text = inlineSource(markdown, node);
    // While streaming, a bare marker is held back. If it is finalized as-is,
    // keep showing the literal marker instead of turning it into an empty title.
    return text.length > 0
      ? { type: "heading", depth: node.depth, text }
      : { type: "paragraph", text: nodeSource(markdown, node).trim() };
  }
  if (node.type === "paragraph") {
    return { type: "paragraph", text: normalizeSoftBreaks(inlineSource(markdown, node)) };
  }
  if (node.type === "list") {
    const items = flattenList(markdown, node);
    if (items.every((item) => item.text.length === 0)) {
      return { type: "paragraph", text: nodeSource(markdown, node).trim() };
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
    return { type: "quote", lines: blockquoteLines(markdown, node) };
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
    return { type: "paragraph", text: node.value };
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

function phrasingText(node: MarkdownPhrasingContent): string {
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
    return node.children.map(phrasingText).join("");
  }
  return "value" in node && typeof node.value === "string" ? node.value : "";
}

export function parseMarkdownInline(markdown: string): MarkdownPhrasingContent[] {
  const tree = markdownProcessor.parse(
    `${INLINE_SENTINEL}${normalizeNewlines(markdown)}`,
  ) as MarkdownRoot;
  const block = tree.children[0];
  if (block?.type !== "paragraph") {
    return [];
  }

  const children = [...block.children];
  const first = children[0];
  if (first?.type === "text" && first.value.startsWith(INLINE_SENTINEL)) {
    const value = first.value.slice(INLINE_SENTINEL.length);
    if (value.length === 0) {
      children.shift();
    } else {
      children[0] = { ...first, value };
    }
  }
  return children;
}

export function markdownInlineText(markdown: string): string {
  return parseMarkdownInline(markdown).map(phrasingText).join("");
}
