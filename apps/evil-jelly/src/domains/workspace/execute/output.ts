import { randomBytes } from "node:crypto";
import path from "node:path";
import { utf8Prefix } from "../../../shared/foundation/string";
import { getWorkspaceFiles } from "../../../shared/fs-policy/workspace-files";
import { renderPseudoXmlElement } from "../../../shared/model/prompt/pseudoXml";
import type { ToolExecutionOutcomeRecord } from "../../../shared/tool-observation/model";
import type { ExecuteShellCommandResult } from "./executeShellCommand";

export const TRUNCATED_FOR_AGENT_MARKER = "\n[evil-jelly: output truncated for preview]\n";
export const MAX_OUTPUT_LINE_BYTES = 16 * 1024;

function utf8Head(buffer: Buffer, maxBytes: number): string {
  if (buffer.length <= maxBytes) return buffer.toString("utf8");
  let end = maxBytes;
  while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

function utf8Tail(buffer: Buffer, maxBytes: number): string {
  if (buffer.length <= maxBytes) return buffer.toString("utf8");
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString("utf8");
}

function truncateLine(line: string, maxBytes: number): string {
  const buffer = Buffer.from(line, "utf8");
  if (buffer.length <= maxBytes) return line;

  const marker = `[evil-jelly: line truncated for preview (${buffer.length} bytes)]`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes >= maxBytes) return utf8Head(Buffer.from(marker, "utf8"), maxBytes);

  const contentBytes = maxBytes - markerBytes;
  const headBytes = Math.floor(contentBytes / 2);
  const tailBytes = contentBytes - headBytes;
  return `${utf8Head(buffer, headBytes)}${marker}${utf8Tail(buffer, tailBytes)}`;
}

export function truncateLongLines(text: string, maxLineBytes = MAX_OUTPUT_LINE_BYTES): string {
  return text.replace(/[^\n]+/g, (line) => {
    const carriageReturn = line.endsWith("\r") ? "\r" : "";
    const content = carriageReturn ? line.slice(0, -1) : line;
    return `${truncateLine(content, maxLineBytes)}${carriageReturn}`;
  });
}

export function truncateOutput(
  text: string,
  maxBytes: number,
  maxLineBytes = MAX_OUTPUT_LINE_BYTES,
): string {
  const lineTruncated = truncateLongLines(text, maxLineBytes);
  const buf = Buffer.from(lineTruncated, "utf8");
  if (buf.length <= maxBytes) {
    return lineTruncated;
  }
  const headBytes = Math.floor(maxBytes / 2);
  const tailBytes = maxBytes - headBytes;
  const head = utf8Head(buf, headBytes);
  const tail = utf8Tail(buf, tailBytes);
  return `${head}${TRUNCATED_FOR_AGENT_MARKER}${tail}`;
}

const MAX_COMMAND_PREVIEW_BYTES = 48_000;
/** Keep saved logs below read_file's 10 MiB source cap and its 32 KiB single-line cap. */
const MAX_SNAPSHOT_LINE_BYTES = 8 * 1024;

function readingSnapshot(text: string): { text: string; wrapped: boolean } {
  let wrapped = false;
  const snapshot = text.replace(/[^\n]+/g, (line) => {
    const bytes = Buffer.from(line, "utf8");
    if (bytes.length <= MAX_SNAPSHOT_LINE_BYTES) return line;
    wrapped = true;
    const parts: string[] = [];
    let start = 0;
    while (start < bytes.length) {
      const part = utf8Head(bytes.subarray(start), MAX_SNAPSHOT_LINE_BYTES);
      parts.push(part);
      start += Buffer.byteLength(part, "utf8");
    }
    return parts.join("\n");
  });
  return { text: snapshot, wrapped };
}

/** One execution outcome shared by host observations and model-facing attributes. */
export function getCommandOutcome(
  result: Pick<ExecuteShellCommandResult, "exitCode" | "error">,
): ToolExecutionOutcomeRecord {
  if (result.error?.code === "EABORTED") {
    return { outcome: "aborted", exitCode: null, failureKind: "user_abort" };
  }
  if (result.error?.code === "ETIMEDOUT") {
    return { outcome: "timed_out", exitCode: null, failureKind: "hard_timeout" };
  }
  return {
    outcome: result.exitCode === 0 ? "succeeded" : "failed",
    exitCode: result.exitCode,
    ...(result.exitCode === 0 ? {} : { failureKind: "nonzero_exit" }),
  };
}

/** A readable filename label, not a shell parser or secret redactor. */
function commandLogPrefix(command: string): string {
  const prefix = command
    .trimStart()
    .slice(0, 40)
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return prefix || "command";
}

/** Save only after execution completes, and only when the inline preview loses content. */
export async function renderCommandOutput(
  result: ExecuteShellCommandResult,
  directory: string,
  command: string,
): Promise<string> {
  const outcome = getCommandOutcome(result);
  const capture = result.capture;
  const captureTruncated = capture.omittedBytes > 0;
  const attributes: Record<string, string> = {
    status: outcome.outcome === "succeeded" ? "ok" : outcome.outcome,
    "exit-code": String(outcome.exitCode),
    ...(outcome.failureKind ? { reason: outcome.failureKind } : {}),
    ...(captureTruncated
      ? {
          "capture-truncated": "true",
          "capture-total-bytes": String(capture.totalBytes),
          "capture-retained-bytes": String(capture.retainedBytes),
          "capture-omitted-bytes": String(capture.omittedBytes),
        }
      : {}),
  };
  const preview = truncateOutput(result.output, MAX_COMMAND_PREVIEW_BYTES);
  const previewTruncated = preview !== result.output;
  const previewAttributes: Record<string, string> = {
    ...(previewTruncated ? { "preview-truncated": "true" } : {}),
  };
  const notices: string[] = [];
  if (outcome.outcome === "failed" && result.error?.message) {
    notices.push(
      renderPseudoXmlElement("tool_notice", utf8Prefix(result.error.message, 1024), {
        reason: "command_error",
      }),
    );
  }

  if (previewTruncated || captureTruncated) {
    const snapshot = readingSnapshot(result.output);
    const snapshotAttributes = {
      content: "snapshot",
      ...(snapshot.wrapped ? { "snapshot-long-lines-wrapped": "true" } : {}),
    };
    try {
      const policy = getWorkspaceFiles();
      const file = path.join(
        directory,
        `${commandLogPrefix(command)}-${randomBytes(8).toString("hex")}.log`,
      );
      await policy.writeNewResolved(
        policy.classifyPath(file),
        renderPseudoXmlElement("command_output", snapshot.text, {
          ...attributes,
          ...snapshotAttributes,
        }),
      );
      previewAttributes["saved-path"] = file;
      if (snapshot.wrapped) previewAttributes["snapshot-long-lines-wrapped"] = "true";
    } catch (error) {
      previewAttributes["save-status"] = "failed";
      notices.push(
        renderPseudoXmlElement(
          "tool_notice",
          `Command output save failed: ${utf8Prefix(error instanceof Error ? error.message : String(error), 1024)}\n` +
            "Only this preview is available; output omitted from the preview was not saved.",
          { reason: "output_save_failed" },
        ),
      );
    }
  }

  return [
    renderPseudoXmlElement("command_output", preview, { ...attributes, ...previewAttributes }),
    ...notices,
  ].join("\n");
}
