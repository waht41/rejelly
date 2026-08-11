import type { AgentSnapshot } from "@rejelly/core";
import { loadSnapshotFromTraceId } from "../../features/replay/snapshot/restore";
import type { EvilJellyHostBindings } from "../../shared/types";

export async function loadStartupSnapshot(
  snapshotTraceId: string | undefined,
  bindings: EvilJellyHostBindings,
): Promise<AgentSnapshot | undefined> {
  if (!snapshotTraceId) {
    return undefined;
  }
  try {
    bindings.logSystemEvent(`Fetching trace [${snapshotTraceId}] from Review endpoint...\n`);
    const snapshot = await loadSnapshotFromTraceId(snapshotTraceId);
    bindings.logSystemEvent(`Restored snapshot from trace: ${snapshotTraceId}\n`);
    return snapshot;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Failed to load/restore snapshot: ${msg}`);
    process.exit(1);
  }
}
