/** Editor operations and display projection over the shared semantic prompt contract. */

import {
  normalizePromptDocument,
  type PromptDocument,
  type PromptNode,
  type PromptToken,
  promptDocumentLogicalLength,
  promptNodeLogicalLength,
} from "../../../../shared/model/prompt/promptDocument";

export type ProjectionBias = "left" | "right" | "nearest";
export type PromptTokenDisplayText = (token: PromptToken, document: PromptDocument) => string;

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

export function defaultPromptTokenDisplayText(token: PromptToken): string {
  switch (token.kind) {
    case "skill":
      return `$${token.qualifiedName}`;
    case "paste": {
      const lines = token.text.split("\n").length;
      return lines > 1
        ? `[Pasted text +${lines} lines]`
        : `[Pasted text +${token.text.length} chars]`;
    }
    case "file":
      return "[File]";
    case "image":
      return "[Image]";
  }
}

function slicePromptDocument(
  document: PromptDocument,
  rawStart: number,
  rawEnd: number,
): PromptDocument {
  const length = promptDocumentLogicalLength(document);
  const start = clamp(rawStart, 0, length);
  const end = clamp(rawEnd, start, length);
  const nodes: PromptNode[] = [];
  let logicalOffset = 0;

  for (const node of document) {
    const nodeLength = promptNodeLogicalLength(node);
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
  const length = promptDocumentLogicalLength(document);
  const start = clamp(rawStart, 0, length);
  const end = clamp(rawEnd, start, length);
  return normalizePromptDocument([
    ...slicePromptDocument(document, 0, start),
    ...inserted,
    ...slicePromptDocument(document, end, length),
  ]);
}

export function projectPromptDocument(
  document: PromptDocument,
  tokenDisplayText: PromptTokenDisplayText = defaultPromptTokenDisplayText,
): PromptProjection {
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
    const displayText = tokenDisplayText(node, document);
    text += displayText;
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
      const nodeLength = promptNodeLogicalLength(node);
      if (position <= logicalOffset + nodeLength) {
        return node.type === "text"
          ? displayOffset + position - logicalOffset
          : position === logicalOffset
            ? displayOffset
            : displayOffset + tokenDisplayText(node, document).length;
      }
      logicalOffset += nodeLength;
      displayOffset +=
        node.type === "text" ? node.text.length : tokenDisplayText(node, document).length;
    }
    return text.length;
  };

  const displayToLogical = (rawPosition: number, bias: ProjectionBias = "nearest"): number => {
    const position = clamp(rawPosition, 0, text.length);
    let logicalOffset = 0;
    let displayOffset = 0;
    for (const node of document) {
      const displayLength =
        node.type === "text" ? node.text.length : tokenDisplayText(node, document).length;
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
      logicalOffset += promptNodeLogicalLength(node);
      displayOffset = displayEnd;
    }
    return logicalLength;
  };

  return { text, tokenSpans, logicalToDisplay, displayToLogical };
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
