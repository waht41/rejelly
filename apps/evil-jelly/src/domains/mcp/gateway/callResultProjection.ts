import { isDeepStrictEqual } from "node:util";
import type { McpNormalizedCallResult } from "@rejelly/adapter-mcp";
import {
  renderPseudoXmlElement,
  renderPseudoXmlEmptyElement,
} from "../../../shared/model/prompt/pseudoXml";
import {
  MCP_CONTRACT_LIMITS,
  type McpCallPolicyResult,
  type McpCallValidationIssue,
} from "../contracts";

type CallResult = McpCallPolicyResult<McpNormalizedCallResult>;

export interface McpCallProjectionOptions {
  readonly outputBytes?: number;
}

interface RenderStats {
  textBlocksTruncated: number;
  omittedBlocks: number;
  structuredContentOmitted: boolean;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function encodedJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch (error) {
    return JSON.stringify({
      projectionError: error instanceof Error ? error.message : String(error),
    });
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function duplicateStructuredText(
  content: readonly Readonly<Record<string, unknown>>[],
  structuredContent: Readonly<Record<string, unknown>>,
): boolean {
  return content.some((block) => {
    if (block.type !== "text" || typeof block.text !== "string") return false;
    try {
      return isDeepStrictEqual(JSON.parse(block.text), structuredContent);
    } catch {
      return false;
    }
  });
}

function renderText(
  tag: string,
  text: string,
  index: number,
  remainingTextBytes: { value: number },
  stats: RenderStats,
): string {
  const originalBytes = byteLength(text);
  const returnedText = truncateUtf8(text, Math.max(0, remainingTextBytes.value));
  const returnedBytes = byteLength(returnedText);
  remainingTextBytes.value = Math.max(0, remainingTextBytes.value - returnedBytes);
  const truncated = returnedBytes < originalBytes;
  if (truncated) stats.textBlocksTruncated += 1;
  return renderPseudoXmlElement(tag, returnedText, {
    index: String(index),
    format: "text",
    ...(truncated
      ? {
          truncated: "true",
          original_bytes: String(originalBytes),
          returned_bytes: String(returnedBytes),
        }
      : {}),
  });
}

function renderContentBlock(
  block: Readonly<Record<string, unknown>>,
  index: number,
  remainingTextBytes: { value: number },
  includeUnknownJson: boolean,
  stats: RenderStats,
): string {
  const type = typeof block.type === "string" ? block.type : "unknown";
  if (type === "text" && typeof block.text === "string") {
    return renderText("text", block.text, index, remainingTextBytes, stats);
  }
  if ((type === "image" || type === "audio") && typeof block.data === "string") {
    return renderPseudoXmlEmptyElement(type, {
      index: String(index),
      ...(typeof block.mimeType === "string" ? { mime_type: block.mimeType } : {}),
      data_omitted: "true",
      encoded_chars: String(block.data.length),
    });
  }
  if (type === "resource" && block.resource && typeof block.resource === "object") {
    const resource = block.resource as Readonly<Record<string, unknown>>;
    const children: string[] = [];
    if (typeof resource.text === "string") {
      children.push(renderText("text", resource.text, index, remainingTextBytes, stats));
    }
    if (typeof resource.blob === "string") {
      children.push(
        renderPseudoXmlEmptyElement("blob", {
          data_omitted: "true",
          encoded_chars: String(resource.blob.length),
        }),
      );
    }
    return renderPseudoXmlElement("resource", children.join("\n"), {
      index: String(index),
      ...(typeof resource.uri === "string" ? { uri: resource.uri } : {}),
      ...(typeof resource.mimeType === "string" ? { mime_type: resource.mimeType } : {}),
    });
  }
  if (!includeUnknownJson) {
    stats.omittedBlocks += 1;
    return renderPseudoXmlEmptyElement("content_block", {
      index: String(index),
      type,
      omitted: "true",
      reason: "output_budget",
      original_bytes: String(byteLength(encodedJson(block))),
    });
  }
  return renderPseudoXmlElement("content_block", encodedJson(block), {
    index: String(index),
    type,
    format: "json",
  });
}

function originalResultBytes(result: McpNormalizedCallResult): number {
  return byteLength(encodedJson(result));
}

function renderCompleted(
  result: Extract<CallResult, { status: "completed" }>,
  options: {
    readonly textBytes: number;
    readonly includeStructuredContent: boolean;
    readonly includeUnknownJson: boolean;
    readonly budgetBytes?: number;
  },
): string {
  const stats: RenderStats = {
    textBlocksTruncated: 0,
    omittedBlocks: 0,
    structuredContentOmitted: false,
  };
  const remainingTextBytes = { value: options.textBytes };
  const content = result.result.content.map((block, index) =>
    renderContentBlock(block, index, remainingTextBytes, options.includeUnknownJson, stats),
  );
  const duplicate =
    result.result.structuredContent !== undefined &&
    duplicateStructuredText(result.result.content, result.result.structuredContent);
  let structuredContent: string | undefined;
  if (result.result.structuredContent !== undefined) {
    if (duplicate) {
      structuredContent = renderPseudoXmlEmptyElement("structured_content", {
        omitted: "true",
        reason: "duplicate_text_content",
      });
    } else if (options.includeStructuredContent) {
      structuredContent = renderPseudoXmlElement(
        "structured_content",
        encodedJson(result.result.structuredContent),
        { format: "json" },
      );
    } else {
      stats.structuredContentOmitted = true;
      structuredContent = renderPseudoXmlEmptyElement("structured_content", {
        omitted: "true",
        reason: "output_budget",
        original_bytes: String(byteLength(encodedJson(result.result.structuredContent))),
      });
    }
  }
  const truncated =
    stats.textBlocksTruncated > 0 || stats.omittedBlocks > 0 || stats.structuredContentOmitted;
  const truncation =
    truncated && options.budgetBytes !== undefined
      ? renderPseudoXmlEmptyElement("truncation", {
          reason: "output_budget",
          original_bytes: String(originalResultBytes(result.result)),
          budget_bytes: String(options.budgetBytes),
          text_blocks_truncated: String(stats.textBlocksTruncated),
          omitted_blocks: String(stats.omittedBlocks),
          structured_content_omitted: String(stats.structuredContentOmitted),
        })
      : undefined;
  return renderPseudoXmlElement(
    "mcp_call_result",
    [
      renderPseudoXmlElement("content", content.join("\n")),
      ...(structuredContent ? [structuredContent] : []),
      ...(truncation ? [truncation] : []),
    ].join("\n"),
    {
      version: "1",
      status: "completed",
      server: result.tool.serverId,
      tool: result.tool.nativeToolName,
      catalog_revision: result.catalogRevision,
      is_error: String(result.result.isError),
      ...(truncated ? { truncated: "true" } : {}),
    },
  );
}

function renderIssues(issues: readonly McpCallValidationIssue[]): string {
  return renderPseudoXmlElement("issues", encodedJson(issues), {
    format: "json",
    count: String(issues.length),
  });
}

function renderRejected(
  result: Extract<CallResult, { status: "rejected" }>,
  outputBytes: number,
): string {
  const fullBody = [
    renderPseudoXmlElement("message", result.message),
    ...(result.issues ? [renderIssues(result.issues)] : []),
  ].join("\n");
  const attributes = {
    version: "1",
    status: "rejected",
    server: result.tool.serverId,
    tool: result.tool.nativeToolName,
    code: result.code,
    ...(result.currentCatalogRevision
      ? { current_catalog_revision: result.currentCatalogRevision }
      : {}),
  };
  const full = renderPseudoXmlElement("mcp_call_result", fullBody, attributes);
  if (byteLength(full) <= outputBytes) return full;
  const message = truncateUtf8(result.message, Math.max(0, outputBytes - 2_048));
  return renderPseudoXmlElement(
    "mcp_call_result",
    [
      renderPseudoXmlElement("message", message, {
        truncated: String(message !== result.message),
        original_bytes: String(byteLength(result.message)),
        returned_bytes: String(byteLength(message)),
      }),
      ...(result.issues
        ? [
            renderPseudoXmlEmptyElement("issues", {
              omitted: "true",
              reason: "output_budget",
              count: String(result.issues.length),
            }),
          ]
        : []),
      renderPseudoXmlEmptyElement("truncation", {
        reason: "output_budget",
        budget_bytes: String(outputBytes),
      }),
    ].join("\n"),
    { ...attributes, truncated: "true" },
  );
}

/** Model-facing projection; policy/runtime results remain structured internally. */
export function projectMcpCallResultForModel(
  result: CallResult,
  options: McpCallProjectionOptions = {},
): string {
  const outputBytes = options.outputBytes ?? MCP_CONTRACT_LIMITS.callResultOutputBytes;
  if (result.status === "rejected") return renderRejected(result, outputBytes);
  const full = renderCompleted(result, {
    textBytes: Number.POSITIVE_INFINITY,
    includeStructuredContent: true,
    includeUnknownJson: true,
  });
  if (byteLength(full) <= outputBytes) return full;

  let low = 0;
  let high = outputBytes;
  let best: string | undefined;
  while (low <= high) {
    const textBytes = Math.floor((low + high) / 2);
    const candidate = renderCompleted(result, {
      textBytes,
      includeStructuredContent: false,
      includeUnknownJson: false,
      budgetBytes: outputBytes,
    });
    if (byteLength(candidate) <= outputBytes) {
      best = candidate;
      low = textBytes + 1;
    } else {
      high = textBytes - 1;
    }
  }
  if (best) return best;
  return renderPseudoXmlElement(
    "mcp_call_result",
    renderPseudoXmlEmptyElement("truncation", {
      reason: "output_budget",
      original_bytes: String(originalResultBytes(result.result)),
      budget_bytes: String(outputBytes),
      omitted_blocks: String(result.result.content.length),
      structured_content_omitted: String(result.result.structuredContent !== undefined),
    }),
    {
      version: "1",
      status: "completed",
      server: result.tool.serverId,
      tool: result.tool.nativeToolName,
      catalog_revision: result.catalogRevision,
      is_error: String(result.result.isError),
      truncated: "true",
    },
  );
}
