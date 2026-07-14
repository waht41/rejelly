/**
 * Exporters (导出器)
 *
 * Take a TraceEvent[] and send it to different destinations.
 * For DevTool: write trace to local .jsonl file (one event per line).
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TraceEvent } from "@rejelly/core";

export interface ExportToJsonlOptions {
  /** Output directory. Default: mock-data under script's package (devtool-ui). */
  outDir?: string;
  /** File name without extension (default: trace). */
  filename?: string;
}

/**
 * Write trace events to a local .jsonl file (one JSON object per line).
 * DevTool can load it via file picker (accepts .jsonl / .ndjson).
 *
 * @param events - TraceEvent array from catcher
 * @param filePathOrOptions - Full path to output file, or options (outDir + filename). Omit to use default mock-data dir and filename "trace.jsonl"
 * @returns Resolved output file path
 */
export async function exportToJsonl(
  events: TraceEvent[],
  filePathOrOptions?: string | ExportToJsonlOptions,
): Promise<string> {
  const lines = events.map((e) => JSON.stringify(e));
  const content = lines.join("\n") + (lines.length ? "\n" : "");

  let resolvedPath: string;
  if (typeof filePathOrOptions === "string") {
    resolvedPath = filePathOrOptions;
  } else {
    const opts = filePathOrOptions ?? {};
    const outDir = opts.outDir ?? getDefaultMockDataDir();
    const filename =
      (opts.filename ?? "trace") + (opts.filename?.endsWith(".jsonl") ? "" : ".jsonl");
    resolvedPath = path.join(outDir, filename);
  }

  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, content, "utf-8");
  return resolvedPath;
}

/**
 * Default directory for mock trace files: devtool-ui/mock-data.
 * Resolved relative to this file (scripts/core/exporters.ts) -> scripts -> devtool-ui root.
 */
function getDefaultMockDataDir(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(dir, "..", "..", "mock-data");
}
