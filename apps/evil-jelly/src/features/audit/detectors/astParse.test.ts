import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_HEURISTIC_AST_BYTES } from "../../../domains/workspace/source/heuristicAstLimits";
import { getWorkspaceRoot, setWorkspaceRoot } from "../../../shared/fs-policy/workspace-context";
import { tryParseWorkspaceRel } from "./astParse";

describe("audit workspace AST parsing", () => {
  let previousRoot: string;
  let tempDir: string;
  let root: string;

  beforeEach(async () => {
    previousRoot = getWorkspaceRoot();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-audit-ast-"));
    root = path.join(tempDir, "workspace");
    await fs.mkdir(root);
    setWorkspaceRoot(root);
  });

  afterEach(async () => {
    setWorkspaceRoot(previousRoot);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("reads and parses workspace source through the filesystem policy", async () => {
    const source = "export const budget = 1;\n";
    await fs.writeFile(path.join(root, "budget.ts"), source);

    const parsed = await tryParseWorkspaceRel("budget.ts");

    expect(parsed?.text).toBe(source);
    expect(parsed?.root.kind()).toBe("program");
  });

  it("skips missing, unsupported, oversized, and unapproved outside files", async () => {
    await fs.writeFile(path.join(root, "sample.py"), "budget = 1\n");
    await fs.writeFile(path.join(root, "large.ts"), " ".repeat(MAX_HEURISTIC_AST_BYTES + 1));
    const outside = path.join(tempDir, "outside.ts");
    await fs.writeFile(outside, "export const secret = 1;\n");

    for (const file of ["missing.ts", "sample.py", "large.ts", outside]) {
      expect(await tryParseWorkspaceRel(file), file).toBeNull();
    }
  });
});
