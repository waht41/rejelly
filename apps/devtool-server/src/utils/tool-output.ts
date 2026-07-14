import { type ContentPart, isToolContent } from "@rejelly/core";

/**
 * Render a tool result's structured `output` to a compact string view for
 * display / search / length.
 *
 * The trace event carries only `output` now (the former
 * `ToolExecutionResult.rawOutput` string mirror was dropped to avoid doubling
 * the payload); consumers derive the string view here so the rendering policy
 * lives in one place.
 *
 * Multimodal tool content (`toolContent([...])`) is summarized to text plus
 * media placeholders — image/video bytes (e.g. `data:...;base64,...`) are never
 * inlined, to keep traces small and avoid leaking large blobs. Plain JSON
 * outputs are stringified as-is; we do not heuristically deep-scan arbitrary
 * bags for base64 (see ISSUE-0020).
 */
export function renderToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output == null) return "";
  if (isToolContent(output)) {
    return output.$rejellyContent.map(renderContentPart).join("\n");
  }
  try {
    return JSON.stringify(output) ?? "";
  } catch {
    return String(output);
  }
}

function renderContentPart(part: ContentPart): string {
  // Parts come from a deserialized trace event, so treat the shape defensively.
  const p = part as {
    type?: string;
    text?: string;
    image?: { url?: string };
    video?: { url?: string };
  };
  switch (p.type) {
    case "text":
      return typeof p.text === "string" ? p.text : "";
    case "image":
      return `[image ${describeMediaUrl(p.image?.url ?? "")}]`;
    case "video":
      return `[video ${describeMediaUrl(p.video?.url ?? "")}]`;
    default:
      return `[${p.type ?? "unknown"}]`;
  }
}

/** Public URLs pass through; data URLs collapse to their meta + byte count, never the bytes. */
function describeMediaUrl(url: string): string {
  if (!url.startsWith("data:")) return url;
  const comma = url.indexOf(",");
  const meta = comma === -1 ? url.slice(0, 64) : url.slice(0, comma);
  const bytes = comma === -1 ? url.length : url.length - comma - 1;
  return `${meta}, ${bytes} bytes`;
}
