/**
 * Snapshot Consistency Testing Utilities
 *
 * Provides utilities for snapshot-based testing to ensure state consistency
 */

import type { AgentContext } from "../core/context/type";
import { dumpSnapshot } from "../core/snapshot/dump";
import type { AgentSnapshot } from "../core/snapshot/type";
import { runInTestContext } from "./test-context";
import type { NormalizedSnapshot, SnapshotOptions } from "./type";

export type { NormalizedSnapshot, SnapshotOptions } from "./type";

/**
 * Normalize snapshot by replacing unstable fields with placeholders
 *
 * @param snapshot - Original snapshot
 * @param fieldsToNormalize - Fields to normalize
 * @returns Normalized snapshot
 */
function normalizeSnapshot(
  snapshot: AgentSnapshot,
  fieldsToNormalize: string[] = ["timestamp", "callId", "traceId", "spanId", "processId"],
): NormalizedSnapshot {
  const normalized = JSON.parse(JSON.stringify(snapshot));

  function normalizeObject(obj: any, path: string = ""): void {
    if (obj === null || typeof obj !== "object") {
      return;
    }

    if (Array.isArray(obj)) {
      obj.forEach((item, index) => {
        normalizeObject(item, `${path}[${index}]`);
      });
      return;
    }

    for (const key in obj) {
      const currentPath = path ? `${path}.${key}` : key;
      const value = obj[key];

      // Check if this field should be normalized
      if (fieldsToNormalize.includes(key)) {
        if (key === "timestamp" || key === "processId") {
          obj[key] = `[${key}]`;
        } else if (typeof value === "string") {
          obj[key] = `[${key}]`;
        } else if (typeof value === "number") {
          obj[key] = 0;
        }
      } else {
        normalizeObject(value, currentPath);
      }
    }
  }

  normalizeObject(normalized);

  return normalized as NormalizedSnapshot;
}

/**
 * Run agent and compare snapshot (similar to Jest's toMatchSnapshot)
 *
 * Used to detect if refactoring accidentally changed internal state structure.
 * The snapshot is normalized to remove unstable fields like timestamps and IDs.
 *
 * @param agentRun - Function that runs the agent
 * @param options - Snapshot options
 * @returns Result and normalized snapshot
 *
 * @example
 * const { result, snapshot } = await expectStateSnapshot(
 *   () => MyAgent({ query: 'test' }),
 *   { testName: 'my-test' }
 * )
 * expect(snapshot).toMatchSnapshot('my-test')
 */
export async function expectStateSnapshot<T>(
  agentRun: () => Promise<T>,
  options: SnapshotOptions = {},
): Promise<{ result: T; snapshot: NormalizedSnapshot }> {
  let snapshot: AgentSnapshot;

  // Run agent and capture snapshot
  const result = await runInTestContext(async (_ctx: AgentContext) => {
    const agentResult = await agentRun();
    snapshot = dumpSnapshot();
    return agentResult;
  });

  if (!snapshot!) {
    throw new Error("Failed to capture snapshot");
  }

  // Normalize snapshot
  const normalized = normalizeSnapshot(snapshot, options.normalizeFields);

  return {
    result,
    snapshot: normalized,
  };
}
