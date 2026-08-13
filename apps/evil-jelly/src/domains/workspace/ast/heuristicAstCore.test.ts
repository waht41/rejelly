import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getWorkspaceFsPolicy,
  setWorkspaceRoot,
} from "../../../shared/fs-policy/workspace-fs-policy";
import { parseWorkspaceRelToAst } from "./heuristicAstCore";

describe("heuristic AST workspace behavior", () => {
  let prevRoot: string;
  let tmpDir: string;

  beforeEach(async () => {
    prevRoot = getWorkspaceFsPolicy().getRoot();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-jelly-ast-fs-policy-"));
  });

  afterEach(async () => {
    setWorkspaceRoot(prevRoot);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("parses files inside the workspace root via ast read intent", async () => {
    await fs.mkdir(path.join(tmpDir, "packages", "core", "src"), { recursive: true });
    const rel = path.join("packages", "core", "src", "budget.ts");
    await fs.writeFile(path.join(tmpDir, rel), "export const budget = 1\n", "utf-8");
    setWorkspaceRoot(tmpDir);

    const parsed = await parseWorkspaceRelToAst(rel);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.text).toContain("budget");
  });
});
