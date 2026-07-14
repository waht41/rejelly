/**
 * Time-travel Example
 *
 * - dump-example: dumpSnapshot on error → run fixed Agent with snapshot.
 * - restore-example: capture events → restoreSnapshot(events) → replay with snapshot.
 */

import type { ExampleModule } from "@shared/types";
import { runDumpExample } from "./dump-example";
import { runRestoreExample } from "./restore-example";

export const meta = {
  name: "Time-travel",
  description: "Snapshot on error or from trace; replay with no extra LLM calls",
  order: 30,
};

export const examples = {
  "dump-example": {
    title: "Dump snapshot",
    description: "Old agent fails → dumpSnapshot() → new agent runs with snapshot, correct result",
    run: runDumpExample,
  },
  "restore-example": {
    title: "Restore snapshot",
    description: "Capture trace events → restoreSnapshot(events) → replay with snapshot",
    run: runRestoreExample,
  },
} satisfies ExampleModule["examples"];
