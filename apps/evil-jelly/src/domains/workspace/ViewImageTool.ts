/**
 * View an image so the model can actually see it: reads a workspace image file (or accepts an
 * http(s) URL) and returns it as model-visible `toolContent` image content. The adapter send-side
 * then splits this into the provider's vision payload — see docs/en/api/adapter/index.md (multi-modal tool results).
 *
 * SVG is special-cased: vision APIs don't accept SVG (it's vector XML, not a raster format), so
 * instead of producing a broken image part we return the SVG *source* as text — the model reads the
 * markup directly. This mirrors how web ChatGPT/Gemini "read" SVGs at their app layer.
 */

import path from "node:path";
import { type ToolDefinition, toolContent } from "@rejelly/core";
import { z } from "zod";
import { fuzzySearchFiles } from "../../services/fuzzy/FuzzySearchService";
import { getWorkspaceFsPolicy } from "../../shared/fs-policy/workspace-fs-policy";
import { resolveToolFsPath } from "./outsideAccess";

/** Cap on decoded image bytes; base64 grows ~33%, so this stays well under typical vision limits. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Cap on SVG source pulled into context as text (it counts against the read-only intake budget). */
export const MAX_SVG_TEXT_BYTES = 256 * 1024;

/** Supported raster formats and their MIME types (lower-cased extension, no dot). */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const SUPPORTED_EXTS = Object.keys(IMAGE_MIME_BY_EXT).join(", ");

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** SVG by extension, ignoring any URL query/hash (e.g. `icon.svg?v=2`). */
function isSvgPath(value: string): boolean {
  const withoutQuery = value.split(/[?#]/, 1)[0];
  return /\.svg$/i.test(withoutQuery);
}

/**
 * Minimum fuzzy score, relative to needle length, to surface a suggestion. Each matched char scores
 * at least +1, so 2× means matches are "tight" (consecutive / word-boundary / basename bonuses) —
 * a near-perfect hit like a space-only difference clears it easily, while a sparse subsequence match
 * (~1× per char) does not. Keeps noise out; we'd rather suggest nothing than a wrong name.
 */
const SUGGESTION_MIN_SCORE_RATIO = 2;

/**
 * On a not-found path, fuzzy-match sibling files so the model can self-correct instead of guessing
 * again — weak models fabricate names (e.g. inserting spaces into a CJK date like `2026年5月25日`).
 * Spaces are stripped from the needle so a spaced guess still matches the real (unspaced) name.
 * Returns only the single best candidate, and only when it clears the score threshold.
 * Best-effort: returns "" on any failure.
 */
async function suggestSimilarPaths(image: string): Promise<string> {
  try {
    const dir = path.dirname(image);
    const needle = path.basename(image).replace(/\s+/g, "");
    if (needle.length === 0) {
      return "";
    }
    const [best] = await fuzzySearchFiles(needle, dir.length === 0 ? "." : dir, 1, {
      cachePolicy: "refresh",
    });
    if (!best || best.score < needle.length * SUGGESTION_MIN_SCORE_RATIO) {
      return "";
    }
    return `\nDid you mean "${best.path}"? Use the exact name, don't guess.`;
  } catch {
    return "";
  }
}

function svgSourceResult(label: string, source: string): string {
  return (
    `SVG is vector XML, not a raster image vision models can render, so here is its source — ` +
    `reason about the markup directly.\n--- SVG SOURCE: ${label} ---\n${source}`
  );
}

const viewImageParameters = z.object({
  image: z
    .string()
    .describe(
      "Image to view: a file path (png/jpg/jpeg/gif/webp/svg) or an http(s) image URL. " +
        "SVG is returned as source text (vision models can't render it).",
    ),
});

export const ViewImageTool: ToolDefinition<typeof viewImageParameters> = {
  name: "view_image",
  description:
    "Look at an image and see its actual visual content. " +
    "Accepts a file path or an http(s) URL. Workspace-outside local files follow fs access policy. " +
    `Raster formats (${SUPPORTED_EXTS}) are shown as pictures; SVG is returned as source markup. ` +
    "Use this when you need to inspect a screenshot, diagram, or other picture rather than read text.",
  parameters: viewImageParameters,
  handler: async ({ image }) => {
    const policy = getWorkspaceFsPolicy();
    if (isHttpUrl(image)) {
      // SVG can't be a vision payload — fetch and return its source instead of a broken image part.
      if (isSvgPath(image)) {
        try {
          const response = await fetch(image);
          if (!response.ok) {
            return `Failed to fetch SVG ${image}: HTTP ${response.status}.`;
          }
          const source = await response.text();
          if (Buffer.byteLength(source, "utf-8") > MAX_SVG_TEXT_BYTES) {
            return `SVG ${image} is over the ${MAX_SVG_TEXT_BYTES / 1024} KB source limit for this tool.`;
          }
          return svgSourceResult(image, source);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return `Failed to fetch SVG ${image}: ${msg}`;
        }
      }
      // Other remote URLs pass straight to the model; no fetch, no jail check needed.
      return toolContent([{ type: "image", image: { url: image } }]);
    }

    const resolved = await resolveToolFsPath(image, "read");
    if (!resolved.ok) {
      return resolved.error;
    }

    try {
      const stat = await policy.statResolved(resolved);

      // Local SVG → source text (read-as-XML path).
      if (isSvgPath(image)) {
        if (stat.size > MAX_SVG_TEXT_BYTES) {
          return (
            `SVG ${resolved.displayPath} is ${Math.round(stat.size / 1024)} KB, ` +
            `over the ${MAX_SVG_TEXT_BYTES / 1024} KB source limit for this tool.`
          );
        }
        const source = await policy.readResolved(resolved);
        return svgSourceResult(resolved.displayPath, source);
      }

      const ext = path.extname(image).slice(1).toLowerCase();
      const mime = IMAGE_MIME_BY_EXT[ext];
      if (!mime) {
        return `Unsupported image type "${ext || "(none)"}". Supported: ${SUPPORTED_EXTS}, svg.`;
      }

      if (stat.size > MAX_IMAGE_BYTES) {
        return (
          `Image ${resolved.displayPath} is ${Math.round(stat.size / 1024)} KB, ` +
          `over the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit for this tool.`
        );
      }

      const bytes = await policy.readResolvedBinary(resolved);
      const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
      return toolContent([{ type: "image", image: { url: dataUrl } }]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const suggestion =
        (e as NodeJS.ErrnoException).code === "ENOENT" ? await suggestSimilarPaths(image) : "";
      return `Failed to read image ${image}: ${msg}${suggestion}`;
    }
  },
};
