import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_SCRATCH_DIR, resolveWorkspaceCwd, WorkspaceFsPolicy } from "./workspace-fs-policy";

function createPolicy(): WorkspaceFsPolicy {
  const root = path.join(os.tmpdir(), `evil-jelly-fs-policy-${Date.now()}-${Math.random()}`);
  return new WorkspaceFsPolicy(root);
}

describe("WorkspaceFsPolicy workspace root", () => {
  it("allows paths under the workspace root", () => {
    const policy = createPolicy();
    const resolved = policy.tryResolve("src/index.ts");
    expect(resolved.ok).toBe(true);
  });

  it("denies path traversal outside workspace root", () => {
    const policy = createPolicy();
    const hit = policy.tryResolve("../outside/secret.txt");
    expect(hit.ok).toBe(false);
  });

  it("denies absolute outside-workspace path", () => {
    const root = path.join(os.tmpdir(), `evil-jelly-fs-policy-${Date.now()}-${Math.random()}`);
    const outsideDir = path.resolve(root, "../shared-zone");
    const policy = new WorkspaceFsPolicy(root);
    const hit = policy.tryResolve(path.join(outsideDir, "README.md"));
    expect(hit.ok).toBe(false);
  });

  it("requires approval for outside reads in normal mode", () => {
    const root = path.join(os.tmpdir(), `evil-jelly-fs-policy-${Date.now()}-${Math.random()}`);
    const outsideDir = path.resolve(root, "../shared-zone");
    const policy = new WorkspaceFsPolicy(root);
    const hit = policy.tryResolve(path.join(outsideDir, "README.md"), {
      intent: "read",
      approvalMode: "normal",
    });

    if (hit.ok) {
      throw new Error("expected outside read to require approval");
    }
    expect(hit.needsApproval).toBe(true);
    expect(hit.mode).toBe("read");
    expect(hit.approveDir).toBe(outsideDir);
  });

  it("allows outside non-sensitive reads in auto mode", () => {
    const root = path.join(os.tmpdir(), `evil-jelly-fs-policy-${Date.now()}-${Math.random()}`);
    const outsideFile = path.resolve(root, "../shared-zone/README.md");
    const policy = new WorkspaceFsPolicy(root);
    const hit = policy.tryResolve(outsideFile, { intent: "read", approvalMode: "auto" });

    expect(hit.ok).toBe(true);
    if (hit.ok) {
      expect(hit.outside).toBe(true);
      expect(hit.displayPath).toBe(outsideFile);
      expect(path.isAbsolute(hit.rel)).toBe(false);
      expect(hit.rel).not.toBe(outsideFile);
    }
  });

  it("resolves cwd from an explicit workspace root", () => {
    const root = path.join(os.tmpdir(), `evil-jelly-fs-policy-${Date.now()}-${Math.random()}`);

    expect(resolveWorkspaceCwd(root)).toBe(root);
    expect(resolveWorkspaceCwd(root, "packages/core")).toBe(path.join(root, "packages/core"));
    expect(() => resolveWorkspaceCwd(root, "../outside")).toThrow("cwd must stay inside");
  });

  it("denies outside sensitive files even in auto mode", () => {
    const root = path.join(os.tmpdir(), `evil-jelly-fs-policy-${Date.now()}-${Math.random()}`);
    const outsideFile = path.resolve(root, "../shared-zone/.env");
    const policy = new WorkspaceFsPolicy(root);
    const hit = policy.tryResolve(outsideFile, { intent: "read", approvalMode: "auto" });

    if (hit.ok) {
      throw new Error("expected sensitive outside read to be denied");
    }
    expect(hit.needsApproval).toBeUndefined();
    expect(hit.error).toContain("sensitive");
  });

  it("requires approval for outside writes even in auto mode", () => {
    const root = path.join(os.tmpdir(), `evil-jelly-fs-policy-${Date.now()}-${Math.random()}`);
    const outsideFile = path.resolve(root, "../shared-zone/new.txt");
    const policy = new WorkspaceFsPolicy(root);
    const hit = policy.tryResolve(outsideFile, { intent: "write", approvalMode: "auto" });

    if (hit.ok) {
      throw new Error("expected outside write to require approval");
    }
    expect(hit.needsApproval).toBe(true);
    expect(hit.mode).toBe("write");
  });

  it("allows approved outside write subtrees", () => {
    const root = path.join(os.tmpdir(), `evil-jelly-fs-policy-${Date.now()}-${Math.random()}`);
    const outsideDir = path.resolve(root, "../shared-zone");
    const outsideFile = path.join(outsideDir, "new.txt");
    const policy = new WorkspaceFsPolicy(root);

    policy.approveOutsideAccess("write", outsideDir);
    const hit = policy.tryResolve(outsideFile, { intent: "write", approvalMode: "normal" });

    expect(hit.ok).toBe(true);
    if (hit.ok) {
      expect(hit.outside).toBe(true);
      expect(hit.abs).toBe(outsideFile);
    }
  });

  it("keeps hidden directories blocked", () => {
    const policy = createPolicy();
    const hiddenGit = policy.tryResolve(".git/config");
    const hiddenNodeModules = policy.tryResolve("node_modules/pkg/index.js");
    const hiddenDist = policy.tryResolve("dist/index.js");
    expect(hiddenGit.ok).toBe(false);
    expect(hiddenNodeModules.ok).toBe(false);
    expect(hiddenDist.ok).toBe(false);
  });

  it("blocks sensitive files", () => {
    const policy = createPolicy();
    const envFile = policy.tryResolve(".env.local");
    const pemFile = policy.tryResolve("keys/server.pem");
    const npmrcFile = policy.tryResolve(".npmrc");
    expect(envFile.ok).toBe(false);
    expect(pemFile.ok).toBe(false);
    expect(npmrcFile.ok).toBe(false);
  });

  it("allows committed env templates while blocking real env files", () => {
    const policy = createPolicy();

    expect(policy.tryResolve(".env.example").ok).toBe(true);
    expect(policy.tryResolve(".env.sample").ok).toBe(true);
    expect(policy.tryResolve(".env.template").ok).toBe(true);
    expect(policy.tryResolve("packages/create/template-basic/.env.example").ok).toBe(true);
    expect(policy.tryResolve(".env.local").ok).toBe(false);
  });

  it("returns an actionable message for sensitive file reads", () => {
    const policy = createPolicy();
    const hit = policy.tryResolve(".env");

    if (hit.ok) {
      throw new Error("expected sensitive read to be denied");
    }
    expect(hit.error).toContain("run_command");
  });

  it("allows the dedicated agent scratch directory inside the state dir", () => {
    const root = path.join(os.tmpdir(), `evil-jelly-fs-policy-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, ".gitignore"), ".evil-jelly/\n", "utf-8");
    const policy = new WorkspaceFsPolicy(root);

    expect(policy.tryResolve(`${AGENT_SCRATCH_DIR}/probe.txt`, { intent: "write" }).ok).toBe(true);
  });

  it("uses root .gitignore as dynamic hidden guard", () => {
    const root = path.join(os.tmpdir(), `evil-jelly-fs-policy-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, ".gitignore"), "secrets/\n*.local\n", "utf-8");
    const policy = new WorkspaceFsPolicy(root);

    const ignoredDir = policy.tryResolve("secrets/token.txt");
    const ignoredFile = policy.tryResolve("config/app.local");
    const allowedFile = policy.tryResolve("src/index.ts");

    expect(ignoredDir.ok).toBe(false);
    expect(ignoredFile.ok).toBe(false);
    expect(allowedFile.ok).toBe(true);
  });

  it("centralizes traversal skip rules for inside and outside directories", () => {
    const root = path.join(os.tmpdir(), `evil-jelly-fs-policy-${Date.now()}-${Math.random()}`);
    const outsideDir = path.resolve(root, "../shared-zone");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, ".gitignore"), "secrets/\n", "utf-8");
    const policy = new WorkspaceFsPolicy(root);
    const inside = policy.tryResolve(".");
    policy.approveOutsideAccess("read", outsideDir);
    const outside = policy.tryResolve(outsideDir, { intent: "read" });

    if (!inside.ok || !outside.ok) {
      throw new Error("expected paths to resolve");
    }

    const dirEntry = (name: string) => ({ name, isDirectory: () => true });
    expect(policy.shouldSkipResolvedEntry(inside, dirEntry("secrets"))).toBe(true);
    expect(policy.shouldSkipResolvedEntry(outside, dirEntry("secrets"))).toBe(false);
    expect(policy.shouldSkipResolvedEntry(outside, dirEntry("node_modules"))).toBe(true);
  });

  it("walks matching workspace files deterministically behind policy guards", async () => {
    const root = path.join(os.tmpdir(), `evil-jelly-fs-policy-${Date.now()}-${Math.random()}`);
    await fsPromises.mkdir(path.join(root, "src"), { recursive: true });
    await fsPromises.mkdir(path.join(root, "ignored"), { recursive: true });
    await fsPromises.mkdir(path.join(root, "dist"), { recursive: true });
    await fsPromises.mkdir(path.join(root, ".hidden"), { recursive: true });
    await fsPromises.writeFile(path.join(root, ".gitignore"), "ignored/\n", "utf-8");
    await Promise.all([
      fsPromises.writeFile(path.join(root, "src", "b.ts"), "export {}\n", "utf-8"),
      fsPromises.writeFile(path.join(root, "src", "a.ts"), "export {}\n", "utf-8"),
      fsPromises.writeFile(path.join(root, "src", "note.md"), "note\n", "utf-8"),
      fsPromises.writeFile(path.join(root, "ignored", "secret.ts"), "export {}\n", "utf-8"),
      fsPromises.writeFile(path.join(root, "dist", "bundle.ts"), "export {}\n", "utf-8"),
      fsPromises.writeFile(path.join(root, ".hidden", "private.ts"), "export {}\n", "utf-8"),
    ]);
    const policy = new WorkspaceFsPolicy(root);

    await expect(
      policy.walkFiles({ maxFiles: 10, includeFile: (rel) => rel.endsWith(".ts") }),
    ).resolves.toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("stops a workspace walk at both file and inspected-entry bounds", async () => {
    const root = path.join(os.tmpdir(), `evil-jelly-fs-policy-${Date.now()}-${Math.random()}`);
    await fsPromises.mkdir(root, { recursive: true });
    await Promise.all(
      ["a.ts", "b.ts", "c.ts"].map((name) =>
        fsPromises.writeFile(path.join(root, name), "export {}\n", "utf-8"),
      ),
    );
    const policy = new WorkspaceFsPolicy(root);

    await expect(policy.walkFiles({ maxFiles: 1 })).resolves.toEqual(["a.ts"]);
    await expect(policy.walkFiles({ maxFiles: 10, maxEntries: 2 })).resolves.toEqual([
      "a.ts",
      "b.ts",
    ]);
  });

  it("creates child resolved paths without callers fabricating policy tokens", () => {
    const policy = createPolicy();
    const parent = policy.tryResolve("src");
    if (!parent.ok) {
      throw new Error("expected path to resolve");
    }

    const child = policy.childResolved(parent, "index.ts");

    expect(child.abs).toBe(path.join(parent.abs, "index.ts"));
    expect(child.rel).toBe(path.join("src", "index.ts"));
    expect(child.displayPath).toBe(path.join("src", "index.ts"));
    expect(child.outside).toBe(false);
  });

  it("exempts the app state dir from the gitignore guard (its normal state is gitignored)", () => {
    const root = path.join(os.tmpdir(), `evil-jelly-fs-policy-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, ".gitignore"), ".evil-jelly/\nsecrets/\n", "utf-8");
    const policy = new WorkspaceFsPolicy(root);

    expect(policy.tryResolve(".evil-jelly/audit/ledger.json").ok).toBe(true);
    expect(policy.tryResolve(".evil-jelly").ok).toBe(true);
    // Other gitignored paths stay blocked, as do sensitive files inside the state dir.
    expect(policy.tryResolve("secrets/token.txt").ok).toBe(false);
    expect(policy.tryResolve(".evil-jelly/.env").ok).toBe(false);
  });

  it("allows AST reads under the workspace root", async () => {
    const root = path.join(os.tmpdir(), `evil-jelly-fs-policy-${Date.now()}-${Math.random()}`);
    await fsPromises.mkdir(path.join(root, "packages"), { recursive: true });
    const relFile = path.join("packages", "core.ts");
    await fsPromises.writeFile(path.join(root, relFile), "export const core = 1\n", "utf-8");
    const policy = new WorkspaceFsPolicy(root);

    await expect(policy.readAstFile(relFile)).resolves.toContain("export const core");
    await expect(policy.readFile(relFile)).resolves.toContain("export const core");
  });

  it("deletes entries only through resolved workspace paths", async () => {
    const root = path.join(os.tmpdir(), `evil-jelly-fs-policy-${Date.now()}-${Math.random()}`);
    await fsPromises.mkdir(path.join(root, "src"), { recursive: true });
    await fsPromises.writeFile(path.join(root, "src", "unused.ts"), "export {}\n", "utf-8");
    const policy = new WorkspaceFsPolicy(root);

    await policy.deleteEntry("src/unused.ts");

    await expect(fsPromises.stat(path.join(root, "src", "unused.ts"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses to delete the workspace root", async () => {
    const root = path.join(os.tmpdir(), `evil-jelly-fs-policy-${Date.now()}-${Math.random()}`);
    await fsPromises.mkdir(root, { recursive: true });
    const policy = new WorkspaceFsPolicy(root);

    await expect(policy.deleteEntry(".")).rejects.toThrow("workspace root");
    await expect(fsPromises.stat(root)).resolves.toBeTruthy();
  });

  it("prunes empty parents without crossing the workspace root", async () => {
    const root = path.join(os.tmpdir(), `evil-jelly-fs-policy-${Date.now()}-${Math.random()}`);
    await fsPromises.mkdir(path.join(root, "a", "b"), { recursive: true });
    const policy = new WorkspaceFsPolicy(root);

    const removed = await policy.pruneEmptyParentsInside(path.join("a", "b"));

    expect(removed).toEqual([path.normalize("a/b"), "a"]);
    await expect(fsPromises.stat(root)).resolves.toBeTruthy();
    await expect(fsPromises.stat(path.join(root, "a"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
