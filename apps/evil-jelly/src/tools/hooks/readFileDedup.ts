import {
  equipToolCallLoopMiddleware,
  type Message,
  type ToolCallLoopMiddleware,
  type ToolOutput,
} from "@rejelly/core";
import { type PseudoXmlAttributes, renderPseudoXmlEmptyElement } from "../../shared/lib/pseudoXml";

const READ_FILE_TOOL_NAME = "read_file";
const FILE_OPENING = /(?:^|\n)<(file(?:-[a-f0-9]{8}(?:-\d+)?)?)((?: [^>\n]*)?)>\n/g;

interface FileEnvelope {
  full: string;
  attributes: PseudoXmlAttributes;
}

function unescapePseudoXmlAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function parsePseudoXmlAttributes(serialized: string): PseudoXmlAttributes {
  const attributes: Record<string, string> = {};
  const pattern = / ([A-Za-z_][A-Za-z0-9_.:-]*)="([^"]*)"/g;
  let consumed = 0;
  let match = pattern.exec(serialized);
  while (match !== null) {
    if (match.index !== consumed) {
      throw new Error(`Invalid internal file-envelope attributes: ${serialized}`);
    }
    attributes[match[1]!] = unescapePseudoXmlAttribute(match[2] ?? "");
    consumed = pattern.lastIndex;
    match = pattern.exec(serialized);
  }
  if (consumed !== serialized.length) {
    throw new Error(`Invalid internal file-envelope attributes: ${serialized}`);
  }
  return attributes;
}

function extractSuccessfulFileEnvelopes(text: string): FileEnvelope[] {
  const envelopes: FileEnvelope[] = [];
  FILE_OPENING.lastIndex = 0;
  let match = FILE_OPENING.exec(text);
  while (match !== null) {
    const tag = match[1]!;
    const serializedAttributes = match[2] ?? "";
    const start = match.index + (match[0].startsWith("\n") ? 1 : 0);
    const close = `\n</${tag}>`;
    const closeIndex = text.indexOf(close, FILE_OPENING.lastIndex);
    if (closeIndex < 0) {
      break;
    }
    const end = closeIndex + close.length;
    const full = text.slice(start, end);
    FILE_OPENING.lastIndex = end;
    const attributes = parsePseudoXmlAttributes(serializedAttributes);
    if (attributes.status !== "error") {
      envelopes.push({ full, attributes });
    }
    match = FILE_OPENING.exec(text);
  }
  return envelopes;
}

function previousReadFileCallIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const call of message.tool_calls ?? []) {
      if (call.name === READ_FILE_TOOL_NAME) {
        ids.add(call.id);
      }
    }
  }
  return ids;
}

function previousSuccessfulEnvelopes(messages: readonly Message[]): Set<string> {
  const readCallIds = previousReadFileCallIds(messages);
  const envelopes = new Set<string>();
  for (const message of messages) {
    if (
      message.role !== "tool" ||
      !message.tool_call_id ||
      !readCallIds.has(message.tool_call_id) ||
      typeof message.content !== "string"
    ) {
      continue;
    }
    for (const envelope of extractSuccessfulFileEnvelopes(message.content)) {
      envelopes.add(envelope.full);
    }
  }
  return envelopes;
}

function unchangedMarker(attributes: PseudoXmlAttributes): string {
  return renderPseudoXmlEmptyElement("file", {
    ...attributes,
    status: "unchanged",
    reference: "previous-read",
  });
}

function deduplicateOutput(content: string, previous: ReadonlySet<string>): string {
  let result = content;
  for (const envelope of extractSuccessfulFileEnvelopes(content).reverse()) {
    if (!previous.has(envelope.full)) {
      continue;
    }
    const start = result.lastIndexOf(envelope.full);
    if (start >= 0) {
      result =
        result.slice(0, start) +
        unchangedMarker(envelope.attributes) +
        result.slice(start + envelope.full.length);
    }
  }
  return result;
}

export function createReadFileDedupMiddleware(): ToolCallLoopMiddleware {
  return {
    name: "evil_jelly_read_file_dedup",
    handler: async (ctx, calls, next): Promise<ToolOutput[]> => {
      const previous = previousSuccessfulEnvelopes(ctx.messages);
      const outputs = await next(calls);
      if (previous.size === 0) {
        return outputs;
      }
      const readCallIds = new Set(
        calls.filter((call) => call.name === READ_FILE_TOOL_NAME).map((call) => call.id),
      );
      return outputs.map((output) =>
        readCallIds.has(output.callId) && typeof output.content === "string"
          ? { ...output, content: deduplicateOutput(output.content, previous) }
          : output,
      );
    },
  };
}

export function equipReadFileDedupMiddleware(): void {
  equipToolCallLoopMiddleware(createReadFileDedupMiddleware());
}
