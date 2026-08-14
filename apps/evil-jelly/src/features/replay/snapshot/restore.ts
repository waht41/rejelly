/**
 * Snapshot layer: TraceEvent[] → restoreSnapshot → AgentSnapshot; load from Review API or JSONL file.
 */

import path from "node:path";
import type { AgentSnapshot, TraceEvent } from "@rejelly/core";
import { type RestoreOptions, restoreSnapshot } from "@rejelly/core/debugger";
import { getWorkspaceFsPolicy } from "../../../shared/fs-policy/workspace-fs-policy";
import { fetchTraceEvents } from "../traceClient";
import { parseJsonlTextToObjects } from "./jsonl";
import { jsonlObjectsToTraceEvents } from "./traceEvent";

/**
 * Map absolute snapshot path to path relative to workspace fs policy root.
 * Throws if the path escapes the workspace or equals the root directory.
 */
export function snapshotAbsolutePathToWorkspaceRelative(absolutePath: string): string {
  const policy = getWorkspaceFsPolicy();
  const root = policy.getRoot();
  const resolved = path.resolve(absolutePath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Snapshot file must be under workspace root (${root}). Resolved path: ${resolved}`,
    );
  }
  if (rel.length === 0) {
    throw new Error("Snapshot path cannot be the workspace root directory.");
  }
  return rel;
}

/** Read JSONL via workspace fs policy and produce TraceEvent[]. */
export async function readTraceEventsFromJsonlFile(absolutePath: string): Promise<TraceEvent[]> {
  const policy = getWorkspaceFsPolicy();
  const rel = snapshotAbsolutePathToWorkspaceRelative(absolutePath);
  const content = await policy.readFile(rel);
  const objects = parseJsonlTextToObjects(content);
  return jsonlObjectsToTraceEvents(objects);
}

/** Review traceId → fetch events → restoreSnapshot → injectable AgentSnapshot. */
export async function loadSnapshotFromTraceId(
  traceId: string,
  restoreOptions?: RestoreOptions,
): Promise<AgentSnapshot> {
  const events = await fetchTraceEvents(traceId);
  return restoreSnapshot(events, restoreOptions ?? {});
}

/** JSONL file → restoreSnapshot → injectable AgentSnapshot. */
export async function loadSnapshotFromJsonlFile(
  absolutePath: string,
  restoreOptions?: RestoreOptions,
): Promise<AgentSnapshot> {
  const events = await readTraceEventsFromJsonlFile(absolutePath);
  return restoreSnapshot(events, restoreOptions ?? {});
}
