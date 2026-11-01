import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent, reborn } from "@rejelly/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OperatorDecision,
  OperatorDecisionSession,
} from "../../../cli/operator-decision/model";
import { createToolApproval } from "../../../cli/tool-approval/createToolApproval";
import {
  getSettings,
  initSettings,
  resolveUserSettingsPath,
} from "../../../shared/configuration/settings";
import { parseJsonc } from "../../../shared/foundation/jsonc";
import { getWorkspaceRoot, setWorkspaceRoot } from "../../../shared/fs-policy/workspace-context";
import { getWorkspaceFiles, WorkspaceFiles } from "../../../shared/fs-policy/workspace-files";
import { setBinding } from "../../../shared/host/context";
import type {
  ToolConfirmationHandler,
  ToolConfirmationResult,
} from "../../../shared/host/toolConfirmationBindings";
import { createTestHostBindings } from "../__tests__/testHostBindings";
import {
  createCreateFileTool,
  createDeleteFileTool,
  createEditFileTool,
} from "../write/WriteTools";
import { AgentFileAccess, equipAgentFileAccess, getAgentFileAccess } from "./agentFileAccess";
import { resolveFileToolPath } from "./resolveFileToolPath";

const Runtime = createAgent<{ run: () => Promise<void> }, void>({
  id: "workspace-permission-runtime-test",
  handler: async ({ run }) => {
    await equipAgentFileAccess();
    await run();
  },
});

describe("external workspace permissions", () => {
  let base: string;
  let project: string;
  let external: string;
  let previousRoot: string;

  beforeEach(() => {
    previousRoot = getWorkspaceRoot();
    base = fs.mkdtempSync(path.join(os.tmpdir(), "evil-permission-test-"));
    project = path.join(base, "project");
    external = path.join(base, "external");
    for (const dir of [project, external, path.join(base, "home")]) fs.mkdirSync(dir);
    vi.spyOn(os, "homedir").mockReturnValue(path.join(base, "home"));
    setWorkspaceRoot(project);
    initSettings({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setWorkspaceRoot(previousRoot);
    initSettings({});
    fs.rmSync(base, { recursive: true, force: true });
  });

  function approvalHost(result: ToolConfirmationResult, mode: "normal" | "auto" = "normal") {
    const requestChoice = vi.fn<OperatorDecisionSession["requestChoice"]>(async () => "reject");
    const surface: OperatorDecisionSession = {
      requestChoice,
      requestManager: async () => {
        throw new Error("Unexpected manager");
      },
      requestConfirm: async () => false,
      requestText: async () => "",
    };
    const decision: OperatorDecision = {
      run: (operation) => operation(surface),
      requestChoice: surface.requestChoice,
      requestManager: surface.requestManager,
    };
    const cliApproval = createToolApproval({ getMode: () => mode, decision });
    const confirmTool = vi.fn<ToolConfirmationHandler>(async (request) =>
      request.type === "fs_outside_access" ? result : cliApproval(request),
    );
    const host = { ...createTestHostBindings({ mode }), confirmTool };
    return { host, confirmTool, requestChoice };
  }

  it("does not turn once, rejection, or unspecified acceptance into a directory grant", async () => {
    for (const result of [
      { action: "accept", scope: "once" },
      { action: "accept" },
      { action: "reject" },
    ] as const) {
      const { host, confirmTool } = approvalHost(result);
      await Runtime({
        run: async () => {
          await setBinding(host);
          const file = path.join(external, "a.md");
          expect((await resolveFileToolPath(file, { kind: "read" })).ok).toBe(
            result.action === "accept",
          );
          await resolveFileToolPath(file, { kind: "read" });
          expect(confirmTool).toHaveBeenCalledTimes(2);
          expect(getAgentFileAccess().writeApproval([file])).toBeUndefined();
        },
      });
    }
    expect(fs.existsSync(resolveUserSettingsPath())).toBe(false);
  });

  it("shares memory grants across turns and children, but not a new run of the same agent", async () => {
    const { host, confirmTool } = approvalHost({
      action: "accept",
      scope: "session",
      fileAccess: "read-write",
    });
    let turn = 0;
    const Router = createAgent({
      id: "workspace-permission-router-test",
      handler: async () => {
        await setBinding(host);
        await equipAgentFileAccess();
        const access = getAgentFileAccess();
        await Runtime({
          run: async () => {
            expect(getAgentFileAccess()).toBe(access);
            const reads = await Promise.all(
              ["a.md", "b.md"].map((name) =>
                resolveFileToolPath(path.join(external, name), { kind: "read" }),
              ),
            );
            expect(reads.every((read) => read.ok)).toBe(true);
            expect((await resolveFileToolPath(external, { kind: "scan" })).ok).toBe(true);
          },
        });
        if (turn++ === 0) return reborn();
      },
    });
    await Router({});
    expect(confirmTool).toHaveBeenCalledTimes(1);
    await Router({});
    expect(confirmTool).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(resolveUserSettingsPath())).toBe(false);
  });

  it("auto-writes granted external files, but reviews mixed/uncovered batches and recursive deletion", async () => {
    const { host, confirmTool, requestChoice } = approvalHost({
      action: "accept",
      scope: "session",
      fileAccess: "read-write",
    });
    await Runtime({
      run: async () => {
        await setBinding(host);
        const file = path.join(external, "new.md");
        const create = createCreateFileTool(host.confirmTool);
        expect(await create.handler({ targets: [{ filePath: file, content: "old" }] })).toContain(
          "Created",
        );
        const edit = createEditFileTool(host.confirmTool);
        expect(
          await edit.handler({
            targets: [{ filePath: file, edits: [{ searchBlock: "old", replaceBlock: "new" }] }],
          }),
        ).toContain("Updated");
        expect(fs.readFileSync(file, "utf8")).toBe("new");
        const remove = createDeleteFileTool(host.confirmTool);
        expect(await remove.handler({ targetPaths: [file] })).toContain("Deleted 1");
        expect(requestChoice).not.toHaveBeenCalled();
        expect(
          confirmTool.mock.calls.filter(([request]) => request.type === "fs_outside_access"),
        ).toHaveLength(1);
        const mixed = await create.handler({
          targets: [
            { filePath: file, content: "external" },
            { filePath: "inside.md", content: "inside" },
          ],
        });
        expect(mixed).toContain("denied");
        expect(fs.existsSync(file)).toBe(false);
        const uncovered = path.join(base, "uncovered", "file.md");
        await expect(
          host.confirmTool({
            type: "fs_write",
            kind: "create",
            filePath: "2 files",
            outsideWorkspace: true,
            targetPaths: [file, uncovered],
            unifiedDiff: "diff",
            proposedContent: "",
          }),
        ).resolves.toEqual({ action: "reject" });
        expect(await remove.handler({ targetPaths: [external] })).toContain("denied");
        expect(fs.existsSync(external)).toBe(true);
        const deleteRequest = confirmTool.mock.calls
          .map(([request]) => request)
          .find((request) => request.type === "fs_write" && request.recursiveDelete);
        expect(deleteRequest).toMatchObject({ outsideWorkspace: true, targetPaths: [external] });
      },
    });
  });

  it("does not let auto mode bypass an outside delete review after allow-once", async () => {
    const { host, requestChoice } = approvalHost({ action: "accept", scope: "once" }, "auto");
    const file = path.join(external, "keep.md");
    fs.writeFileSync(file, "keep");
    await Runtime({
      run: async () => {
        await setBinding(host);
        expect(
          await createDeleteFileTool(host.confirmTool).handler({ targetPaths: [file] }),
        ).toContain("denied");
      },
    });
    expect(requestChoice).toHaveBeenCalledOnce();
    expect(fs.existsSync(file)).toBe(true);
  });

  it("persists always in user JSONC, preserves other settings, and restores only for the exact project", async () => {
    const settingsPath = resolveUserSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      '{\n  // keep my preferences\n  "audit": { "concurrency": 3 }\n}\n',
    );
    const { host, confirmTool } = approvalHost({
      action: "accept",
      scope: "always",
      fileAccess: "read-write",
    });
    await Runtime({
      run: async () => {
        await setBinding(host);
        expect((await resolveFileToolPath(external, { kind: "scan" })).ok).toBe(true);
      },
    });
    expect(confirmTool).toHaveBeenCalledOnce();
    const raw = fs.readFileSync(settingsPath, "utf8");
    expect(raw).toContain("// keep my preferences");
    expect(parseJsonc(raw)).toMatchObject({
      audit: { concurrency: 3 },
      permissions: { projects: expect.any(Object) },
    });
    expect(getSettings().filePermissions).toEqual([{ directory: external, access: "read-write" }]);
    initSettings({});
    await Runtime({
      run: async () => {
        await setBinding(host);
        const file = path.join(external, "persistent.md");
        expect(
          await createCreateFileTool(host.confirmTool).handler({
            targets: [{ filePath: file, content: "saved" }],
          }),
        ).toContain("Created");
      },
    });
    expect(
      confirmTool.mock.calls.filter(([request]) => request.type === "fs_outside_access"),
    ).toHaveLength(1);
    setWorkspaceRoot(path.join(project, "child"));
    expect(getSettings().filePermissions).toEqual([]);
    expect(
      new AgentFileAccess(getWorkspaceFiles()).tryResolve(external, { kind: "read" }, "normal").ok,
    ).toBe(false);
  });

  it.each([
    "normal",
    "auto",
  ] as const)("reviews every user settings mutation in %s mode, including aliases and mixed batches", async (mode) => {
    const settingsPath = resolveUserSettingsPath();
    const home = path.dirname(path.dirname(settingsPath));
    const content = JSON.stringify({
      audit: { concurrency: 1 },
      permissions: {
        projects: {
          [project]: { filesystem: { allow: [{ directory: home, access: "read-write" }] } },
        },
      },
    });
    const { host, confirmTool, requestChoice } = approvalHost({ action: "reject" }, mode);
    await Runtime({
      run: async () => {
        await setBinding(host);
        const access = getAgentFileAccess();
        access.approveExternalAccess("write", home);
        const create = createCreateFileTool(host.confirmTool);
        expect(getSettings().audit.concurrency).toBeUndefined();
        expect(await create.handler({ targets: [{ filePath: settingsPath, content }] })).toContain(
          "denied",
        );
        expect(fs.existsSync(path.dirname(settingsPath))).toBe(false);
        requestChoice.mockResolvedValue("accept");
        expect(await create.handler({ targets: [{ filePath: settingsPath, content }] })).toContain(
          "Created",
        );
        expect(getSettings().audit.concurrency).toBe(1);
        expect(access.writeApproval([settingsPath])).toBeUndefined();

        const aliasRoot = path.join(project, "global-alias");
        fs.symlinkSync(path.dirname(settingsPath), aliasRoot, "junction");
        const alias = path.join(aliasRoot, "settings.jsonc");
        fs.writeFileSync(path.join(project, "inside.md"), "old");
        const edit = createEditFileTool(host.confirmTool);
        const targets = [
          {
            filePath: alias,
            edits: [{ searchBlock: '"concurrency":1', replaceBlock: '"concurrency":2' }],
          },
          { filePath: "inside.md", edits: [{ searchBlock: "old", replaceBlock: "new" }] },
        ];
        requestChoice.mockResolvedValue("reject");
        expect(await edit.handler({ targets })).toContain("denied");
        expect(fs.readFileSync(settingsPath, "utf8")).toBe(content);
        expect(fs.readFileSync(path.join(project, "inside.md"), "utf8")).toBe("old");
        requestChoice.mockResolvedValue("accept");
        expect(await edit.handler({ targets })).toContain("Updated");
        expect(getSettings().audit.concurrency).toBe(2);
        expect(fs.readFileSync(path.join(project, "inside.md"), "utf8")).toBe("new");

        const remove = createDeleteFileTool(host.confirmTool);
        requestChoice.mockResolvedValue("reject");
        expect(await remove.handler({ targetPaths: [alias] })).toContain("denied");
        expect(fs.existsSync(settingsPath)).toBe(true);
        requestChoice.mockResolvedValue("accept");
        expect(await remove.handler({ targetPaths: [alias] })).toContain("Deleted 1");
        expect(fs.existsSync(settingsPath)).toBe(false);
        expect(fs.existsSync(path.dirname(settingsPath))).toBe(true);
        expect(getSettings().audit.concurrency).toBeUndefined();
      },
    });
    expect(confirmTool).toHaveBeenCalledTimes(6);
    for (const [request] of confirmTool.mock.calls) {
      expect(request).toMatchObject({ type: "fs_write", userSettings: true });
    }
    expect(requestChoice).toHaveBeenCalledTimes(6);
    for (const [prompt] of requestChoice.mock.calls) {
      expect(prompt).toMatchObject({
        message: expect.stringContaining("may affect other projects"),
        options: [
          { key: "y", label: "Allow once", value: "accept" },
          { key: "n", label: "Deny", value: "reject" },
        ],
      });
    }
  });

  it("fails closed when always cannot be saved, without leaving a session grant", async () => {
    const settingsPath = resolveUserSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(`${settingsPath}.permissions.lock`, "busy");
    const access = new AgentFileAccess(new WorkspaceFiles(project));
    const result = await access.resolve(external, { kind: "write" }, "normal", async () => ({
      action: "accept",
      scope: "always",
    }));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("busy") });
    expect(access.tryResolve(external, { kind: "write" }, "normal").ok).toBe(false);
    expect(fs.existsSync(settingsPath)).toBe(false);
  });

  it("does not turn a broad directory grant into settings authority when a junction changes", async () => {
    const settingsPath = resolveUserSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, "{}");
    const policy = new WorkspaceFiles(project);
    const access = new AgentFileAccess(policy);
    access.approveExternalAccess("write", base);
    const alias = path.join(external, "alias");
    fs.mkdirSync(alias);
    const resolved = access.tryResolve(
      path.join(alias, "settings.jsonc"),
      { kind: "write" },
      "auto",
    );
    if (!resolved.ok) throw new Error(resolved.error);
    fs.rmdirSync(alias);
    fs.symlinkSync(path.dirname(settingsPath), alias, "junction");
    await expect(policy.writeResolved(resolved, "unreviewed")).rejects.toThrow(
      "explicit user confirmation",
    );
    expect(fs.readFileSync(settingsPath, "utf8")).toBe("{}");

    const reviewed = access.tryResolve(
      path.join(alias, "settings.jsonc"),
      { kind: "write" },
      "auto",
    );
    if (!reviewed.ok) throw new Error(reviewed.error);
    fs.rmdirSync(alias);
    fs.symlinkSync(project, alias, "junction");
    await expect(policy.writeResolved(reviewed, "retargeted")).rejects.toThrow("boundary");
    expect(fs.existsSync(path.join(project, "settings.jsonc"))).toBe(false);
  });

  it("rejects link escapes, protected destinations and a path retargeted during approval", async () => {
    const access = new AgentFileAccess(new WorkspaceFiles(project));
    access.approveExternalAccess("write", external);
    const other = path.join(base, "other");
    fs.mkdirSync(other);
    fs.symlinkSync(other, path.join(external, "escape"), "junction");
    expect(
      access.tryResolve(path.join(external, "escape", "missing.md"), { kind: "write" }, "normal")
        .ok,
    ).toBe(false);
    fs.symlinkSync(other, path.join(project, "escape"), "junction");
    expect(
      access.tryResolve(path.join(project, "escape", "missing.md"), { kind: "write" }, "normal").ok,
    ).toBe(false);
    for (const file of [
      path.join(external, ".git/config"),
      path.join(external, "node_modules/pkg/a.js"),
      path.dirname(resolveUserSettingsPath()),
      path.join(path.dirname(resolveUserSettingsPath()), "sessions", "history.jsonl"),
    ]) {
      expect(access.tryResolve(file, { kind: "write" }, "auto")).toMatchObject({
        ok: false,
        error: expect.stringContaining("Access denied"),
      });
    }
    const policy = new WorkspaceFiles(project);
    const safe = path.join(external, "safe");
    fs.mkdirSync(safe);
    const resolved = access.tryResolve(path.join(safe, "missing.md"), { kind: "write" }, "normal");
    if (!resolved.ok) throw new Error(resolved.error);
    fs.rmdirSync(safe);
    fs.symlinkSync(other, safe, "junction");
    await expect(policy.writeResolved(resolved, "must not escape")).rejects.toThrow(/boundary/);
    expect(fs.existsSync(path.join(other, "missing.md"))).toBe(false);
    const fresh = new AgentFileAccess(policy);
    const pending = path.join(external, "pending");
    fs.mkdirSync(pending);
    const result = await fresh.resolve(
      path.join(pending, "file.md"),
      { kind: "write" },
      "normal",
      async () => {
        fs.rmdirSync(pending);
        fs.symlinkSync(other, pending, "junction");
        return { action: "accept", scope: "session" };
      },
    );
    expect(result.ok).toBe(false);
  });
});
