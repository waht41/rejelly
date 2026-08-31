import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkspaceCwd } from "./workspace-context";

describe("workspace context", () => {
  it("resolves workspace-scoped cwd and refuses escapes", () => {
    const root = path.join(os.tmpdir(), `evil-jelly-workspace-context-${Date.now()}`);

    expect(resolveWorkspaceCwd(root)).toBe(root);
    expect(resolveWorkspaceCwd(root, "packages/core")).toBe(path.join(root, "packages/core"));
    expect(() => resolveWorkspaceCwd(root, "../outside")).toThrow("cwd must stay inside");
  });
});
