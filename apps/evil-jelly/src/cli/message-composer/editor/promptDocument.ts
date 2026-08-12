/**
 * Rich prompt document primitives.
 *
 * Text keeps its existing UTF-16 offsets. Every semantic token occupies one logical position,
 * regardless of the terminal width of its display text. Projection maps between those logical
 * positions and the flat display string consumed by the legacy trigger/wrap helpers.
 */

export interface PromptTextNode {
  readonly type: "text";
  readonly text: string;
}

export interface SkillPromptToken {
  readonly type: "token";
  readonly kind: "skill";
  readonly id: string;
  readonly qualifiedName: string;
  readonly displayText: string;
}

export type PromptToken = SkillPromptToken;
export type PromptNode = PromptTextNode | PromptToken;
export type PromptDocument = readonly PromptNode[];
export type ProjectionBias = "left" | "right" | "nearest";

export interface ProjectedTokenSpan {
  readonly start: number;
  readonly end: number;
  readonly logicalStart: number;
  readonly logicalEnd: number;
  readonly token: PromptToken;
}

export interface PromptProjection {
  readonly text: string;
  readonly tokenSpans: readonly ProjectedTokenSpan[];
  logicalToDisplay(position: number): number;
  displayToLogical(position: number, bias?: ProjectionBias): number;
}

export interface ProjectedDisplayRun {
  readonly text: string;
  readonly token?: PromptToken;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value));

export function nodeLogicalLength(node: PromptNode): number {
  return node.type === "text" ? node.text.length : 1;
}

export function documentLogicalLength(document: PromptDocument): number {
  return document.reduce((length, node) => length + nodeLogicalLength(node), 0);
}

/** Remove empty text and merge adjacent text nodes so every edit leaves a canonical document. */
export function normalizePromptDocument(nodes: readonly PromptNode[]): PromptDocument {
  const normalized: PromptNode[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      if (node.text.length === 0) {
        continue;
      }
      const previous = normalized.at(-1);
      if (previous?.type === "text") {
        normalized[normalized.length - 1] = { type: "text", text: previous.text + node.text };
      } else {
        normalized.push({ type: "text", text: node.text });
      }
      continue;
    }
    normalized.push(node);
  }
  return normalized;
}

export function textPromptDocument(text: string): PromptDocument {
  return text.length > 0 ? [{ type: "text", text }] : [];
}

function slicePromptDocument(
  document: PromptDocument,
  rawStart: number,
  rawEnd: number,
): PromptDocument {
  const length = documentLogicalLength(document);
  const start = clamp(rawStart, 0, length);
  const end = clamp(rawEnd, start, length);
  const nodes: PromptNode[] = [];
  let logicalOffset = 0;

  for (const node of document) {
    const nodeLength = nodeLogicalLength(node);
    const nodeStart = logicalOffset;
    const nodeEnd = nodeStart + nodeLength;
    logicalOffset = nodeEnd;
    if (nodeEnd <= start || nodeStart >= end) {
      continue;
    }
    if (node.type === "token") {
      nodes.push(node);
      continue;
    }
    const textStart = Math.max(0, start - nodeStart);
    const textEnd = Math.min(node.text.length, end - nodeStart);
    if (textStart < textEnd) {
      nodes.push({ type: "text", text: node.text.slice(textStart, textEnd) });
    }
  }
  return normalizePromptDocument(nodes);
}

export function replacePromptRange(
  document: PromptDocument,
  rawStart: number,
  rawEnd: number,
  inserted: readonly PromptNode[],
): PromptDocument {
  const length = documentLogicalLength(document);
  const start = clamp(rawStart, 0, length);
  const end = clamp(rawEnd, start, length);
  return normalizePromptDocument([
    ...slicePromptDocument(document, 0, start),
    ...inserted,
    ...slicePromptDocument(document, end, length),
  ]);
}

export function projectPromptDocument(document: PromptDocument): PromptProjection {
  let text = "";
  let logicalLength = 0;
  const tokenSpans: ProjectedTokenSpan[] = [];

  for (const node of document) {
    if (node.type === "text") {
      text += node.text;
      logicalLength += node.text.length;
      continue;
    }
    const start = text.length;
    text += node.displayText;
    tokenSpans.push({
      start,
      end: text.length,
      logicalStart: logicalLength,
      logicalEnd: logicalLength + 1,
      token: node,
    });
    logicalLength += 1;
  }

  const logicalToDisplay = (rawPosition: number): number => {
    const position = clamp(rawPosition, 0, logicalLength);
    let logicalOffset = 0;
    let displayOffset = 0;
    for (const node of document) {
      const nodeLength = nodeLogicalLength(node);
      if (position <= logicalOffset + nodeLength) {
        return node.type === "text"
          ? displayOffset + position - logicalOffset
          : position === logicalOffset
            ? displayOffset
            : displayOffset + node.displayText.length;
      }
      logicalOffset += nodeLength;
      displayOffset += node.type === "text" ? node.text.length : node.displayText.length;
    }
    return text.length;
  };

  const displayToLogical = (rawPosition: number, bias: ProjectionBias = "nearest"): number => {
    const position = clamp(rawPosition, 0, text.length);
    let logicalOffset = 0;
    let displayOffset = 0;
    for (const node of document) {
      const displayLength = node.type === "text" ? node.text.length : node.displayText.length;
      const displayEnd = displayOffset + displayLength;
      if (position <= displayEnd) {
        if (node.type === "text") {
          return logicalOffset + position - displayOffset;
        }
        if (position <= displayOffset) {
          return logicalOffset;
        }
        if (position >= displayEnd) {
          return logicalOffset + 1;
        }
        if (bias === "left") {
          return logicalOffset;
        }
        if (bias === "right") {
          return logicalOffset + 1;
        }
        return position - displayOffset <= displayEnd - position
          ? logicalOffset
          : logicalOffset + 1;
      }
      logicalOffset += nodeLogicalLength(node);
      displayOffset = displayEnd;
    }
    return logicalLength;
  };

  return { text, tokenSpans, logicalToDisplay, displayToLogical };
}

export function promptTokens(document: PromptDocument, kind?: PromptToken["kind"]): PromptToken[] {
  return document.filter(
    (node): node is PromptToken =>
      node.type === "token" && (kind === undefined || node.kind === kind),
  );
}

/** Split one already-wrapped display row into plain and semantic-token render runs. */
export function projectedDisplayRuns(
  rowText: string,
  rowStart: number,
  tokenSpans: readonly ProjectedTokenSpan[],
): ProjectedDisplayRun[] {
  const rowEnd = rowStart + rowText.length;
  const runs: ProjectedDisplayRun[] = [];
  let offset = rowStart;
  for (const span of tokenSpans) {
    if (span.end <= rowStart) {
      continue;
    }
    if (span.start >= rowEnd) {
      break;
    }
    const tokenStart = Math.max(rowStart, span.start);
    const tokenEnd = Math.min(rowEnd, span.end);
    if (offset < tokenStart) {
      runs.push({ text: rowText.slice(offset - rowStart, tokenStart - rowStart) });
    }
    if (tokenStart < tokenEnd) {
      runs.push({
        text: rowText.slice(tokenStart - rowStart, tokenEnd - rowStart),
        token: span.token,
      });
    }
    offset = Math.max(offset, tokenEnd);
  }
  if (offset < rowEnd) {
    runs.push({ text: rowText.slice(offset - rowStart) });
  }
  return runs;
}
