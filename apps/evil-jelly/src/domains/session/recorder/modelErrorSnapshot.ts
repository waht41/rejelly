import type { ModelCallEndEvent } from "@rejelly/core";
import { MODEL_CALL_ERROR_LIMITS, type ModelCallErrorSnapshot } from "../model/sessionEvents";

type ModelErrorInfo = NonNullable<ModelCallEndEvent["error"]>;
const MAX_SOURCE_CHARS = 16_384;
const SECRET_KEY =
  /^(?:api[-_]?key|key|(?:access|refresh|auth|id)[-_]?token|token|password|secret|client[-_]?secret|signature|sig)$/i;

function redactDiagnosticText(text: string): string {
  return text
    .replace(/https?:\/\/[^\s<>"']+/gi, (value) => {
      try {
        const url = new URL(value);
        let changed = false;
        if (url.username || url.password) {
          url.username = "[REDACTED]";
          url.password = "";
          changed = true;
        }
        for (const key of new Set(url.searchParams.keys())) {
          if (!SECRET_KEY.test(key)) continue;
          url.searchParams.set(key, "[REDACTED]");
          changed = true;
        }
        return changed ? url.toString() : value;
      } catch {
        return "[invalid URL omitted]";
      }
    })
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(
      /(\b(?:authorization|proxy-authorization|set-cookie|cookie)\b["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(\b(?:api[-_]?key|x-api-key|(?:access|refresh|auth|id)[-_]?token|token|password|secret|client[-_]?secret)\b["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}&\]]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
}

/** Keep only bounded diagnostic scalars and causes; SDK payloads and stacks never enter Session. */
export function modelErrorSnapshot(error: ModelErrorInfo): ModelCallErrorSnapshot {
  const seen = new Set<ModelErrorInfo>();
  const project = (source: ModelErrorInfo, depth: number): ModelCallErrorSnapshot => {
    seen.add(source);
    let truncated = false;
    const text = (value: string, limit: number): string => {
      const redacted = redactDiagnosticText(value.slice(0, MAX_SOURCE_CHARS));
      if (value.length > MAX_SOURCE_CHARS || redacted.length > limit) truncated = true;
      return redacted.slice(0, limit);
    };
    const scalar = (value: unknown, limit: number): string | undefined =>
      typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
        ? text(String(value), limit)
        : undefined;
    const details = source.details;
    const code = scalar(details?.code, MODEL_CALL_ERROR_LIMITS.code);
    const requestId = scalar(
      details?.request_id ?? details?.requestID ?? details?.requestId ?? details?._request_id,
      MODEL_CALL_ERROR_LIMITS.requestId,
    );
    const status = details?.status;
    const snapshot: ModelCallErrorSnapshot = {
      name: text(source.name, MODEL_CALL_ERROR_LIMITS.name),
      message: text(source.message, MODEL_CALL_ERROR_LIMITS.message),
      ...(code !== undefined ? { code } : {}),
      ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
        ? { status }
        : {}),
      ...(requestId !== undefined ? { requestId } : {}),
    };
    if (source.cause) {
      if (depth + 1 >= MODEL_CALL_ERROR_LIMITS.depth || seen.has(source.cause)) truncated = true;
      else snapshot.cause = project(source.cause, depth + 1);
    }
    if (truncated) snapshot.truncated = true;
    return snapshot;
  };
  return project(error, 0);
}
