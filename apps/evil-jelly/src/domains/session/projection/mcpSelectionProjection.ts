import type { PreparedSessionReplay } from "./sessionReplay";

/** Recover the latest complete session-level selection set; compaction never participates. */
export function projectMcpSessionSelection(replay: PreparedSessionReplay): readonly string[] {
  let selected: readonly string[] = [];
  for (const event of replay.events) {
    if (event.type === "mcp_selection_changed") {
      selected = [...event.selectedServerIds].sort();
    }
  }
  return Object.freeze(selected);
}
