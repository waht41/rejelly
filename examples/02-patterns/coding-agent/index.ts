/**
 * Coding Agent Example
 *
 * Minimal coding agent: native file/shell tools, approval middleware on
 * mutating tools, and an edit → run → verify loop — all driven by one
 * promptChat call.
 *
 * Each scenario runs in a fresh temp workspace (path is printed) so the agent
 * can never touch your real files. Mutating tools ask y/N in the terminal;
 * answer yes to let the agent proceed, or no to watch it adapt.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExampleModule } from "@shared/types";
import { CodingAgent } from "./coding-agent";

export const meta = {
  name: "Coding Agent",
  description: "Sandboxed edit/run/verify loop with native tools + approval middleware",
  order: 11,
};

/** Create a fresh temp workspace, optionally seeded with files. */
async function makeWorkspace(seedFiles: Record<string, string> = {}): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "rejelly-coding-agent-"));
  for (const [relPath, content] of Object.entries(seedFiles)) {
    const target = path.join(workspace, relPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf-8");
  }
  return workspace;
}

async function runTask(task: string, seedFiles: Record<string, string> = {}) {
  const workspace = await makeWorkspace(seedFiles);
  console.log(`📁 Workspace: ${workspace}`);
  console.log(`📝 Task: ${task}`);
  console.log("-".repeat(60));

  const { summary } = await CodingAgent({ task, workspace });

  console.log(`\n${"=".repeat(60)}`);
  console.log(`✅ Final summary:\n${summary}`);
  console.log(`\n📁 Inspect the result: ${workspace}`);
}

async function exampleScaffold() {
  console.log("=== Coding Agent: scaffold & verify ===\n");
  await runTask(
    "Create fizzbuzz.js: print the numbers 1 to 15, but print Fizz for multiples of 3, " +
      "Buzz for multiples of 5, and FizzBuzz for both. Run it with node and confirm the output is correct.",
  );
}

// A one-line bug (`sum / (values.length - 1)`) that makes test.js fail: the
// agent has to run the test, read the failure, locate the bug, make a minimal
// edit_file fix, and re-run until green.
const BUGGY_STATS = `/** Tiny stats helpers. */

function average(values) {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / (values.length - 1);
}

function max(values) {
  let result = -Infinity;
  for (const value of values) {
    if (value > result) result = value;
  }
  return result;
}

module.exports = { average, max };
`;

const STATS_TEST = `const assert = require("node:assert");
const { average, max } = require("./stats");

assert.strictEqual(average([2, 4, 6]), 4, "average([2,4,6]) should be 4");
assert.strictEqual(average([10]), 10, "average([10]) should be 10");
assert.strictEqual(max([1, 9, 3]), 9, "max([1,9,3]) should be 9");

console.log("All tests passed!");
`;

async function exampleFixBug() {
  console.log("=== Coding Agent: find & fix a bug ===\n");
  await runTask(
    "Run `node test.js` in this workspace. It currently fails. Find the bug, fix it with a " +
      "minimal edit, and re-run the test until it passes.",
    { "stats.js": BUGGY_STATS, "test.js": STATS_TEST },
  );
}

export const examples = {
  scaffold: {
    title: "Scaffold & verify",
    description: "Empty workspace: write fizzbuzz.js, run it with node, confirm output",
    run: exampleScaffold,
  },
  "fix-bug": {
    title: "Find & fix a bug",
    description: "Seeded workspace with a failing test: locate, edit, re-run until green",
    run: exampleFixBug,
  },
} satisfies ExampleModule["examples"];
