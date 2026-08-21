import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  grantMcpPersistentServerAccess,
  grantMcpPersistentToolAccess,
  grantMcpPersistentToolAccesses,
  grantMcpWorkspaceTrust,
  readMcpPersistentPermissions,
  readMcpTrustGrants,
  resolveMcpTrustPath,
  revokeMcpPersistentPermissions,
  revokeMcpPersistentServerAccess,
  revokeMcpPersistentToolAccesses,
} from "./trustRepository";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): { home: string; workspace: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "evil-mcp-trust-"));
  roots.push(home);
  vi.spyOn(os, "homedir").mockReturnValue(home);
  return { home, workspace: path.join(home, "workspace") };
}

describe("MCP trust repository", () => {
  it("scopes grants to one workspace and replaces drifted fingerprints", () => {
    const { workspace } = fixture();
    grantMcpWorkspaceTrust(workspace, {
      serverId: "docs",
      configFingerprint: "a".repeat(64),
    });
    grantMcpWorkspaceTrust(workspace, {
      serverId: "docs",
      configFingerprint: "b".repeat(64),
    });

    expect(readMcpTrustGrants(workspace)).toEqual([
      { serverId: "docs", configFingerprint: "b".repeat(64) },
    ]);
    expect(readMcpTrustGrants(path.join(workspace, "other"))).toEqual([]);
    expect(fs.statSync(resolveMcpTrustPath()).isFile()).toBe(true);
  });

  it("persists and independently revokes server and tool permissions", () => {
    const { workspace } = fixture();
    const configFingerprint = "a".repeat(64);
    grantMcpPersistentServerAccess(workspace, { serverId: "docs", configFingerprint });
    grantMcpPersistentToolAccess(workspace, {
      serverId: "docs",
      configFingerprint,
      nativeToolName: "read",
      toolSchemaFingerprint: "b".repeat(64),
    });

    expect(readMcpPersistentPermissions(workspace)).toEqual([
      {
        serverId: "docs",
        configFingerprint,
        chatAccess: true,
        tools: [{ nativeToolName: "read", toolSchemaFingerprint: "b".repeat(64) }],
      },
    ]);

    revokeMcpPersistentServerAccess(workspace, "docs");
    expect(readMcpPersistentPermissions(workspace)[0]).toMatchObject({
      chatAccess: false,
      tools: [{ nativeToolName: "read" }],
    });
    revokeMcpPersistentPermissions(workspace, "docs", "read");
    expect(readMcpPersistentPermissions(workspace)[0]).toMatchObject({
      chatAccess: false,
      tools: [],
    });
    revokeMcpPersistentPermissions(workspace, "docs");
    expect(readMcpPersistentPermissions(workspace)[0]).toMatchObject({
      chatAccess: false,
      tools: [],
    });
  });

  it("invalidates persistent permissions when the config fingerprint drifts", () => {
    const { workspace } = fixture();
    grantMcpPersistentServerAccess(workspace, {
      serverId: "docs",
      configFingerprint: "a".repeat(64),
    });
    grantMcpWorkspaceTrust(workspace, {
      serverId: "docs",
      configFingerprint: "b".repeat(64),
    });

    expect(readMcpPersistentPermissions(workspace)).toEqual([
      {
        serverId: "docs",
        configFingerprint: "b".repeat(64),
        chatAccess: false,
        tools: [],
      },
    ]);
  });

  it("grants and revokes multiple tool permissions in one repository update", () => {
    const { workspace } = fixture();
    const configFingerprint = "a".repeat(64);
    grantMcpPersistentToolAccesses(
      workspace,
      ["diagnostics", "references"].map((nativeToolName, index) => ({
        serverId: "typescript",
        configFingerprint,
        nativeToolName,
        toolSchemaFingerprint: String(index + 1).repeat(64),
      })),
    );

    expect(readMcpPersistentPermissions(workspace)[0]?.tools).toHaveLength(2);
    revokeMcpPersistentToolAccesses(workspace, "typescript", ["diagnostics", "references"]);
    expect(readMcpPersistentPermissions(workspace)[0]?.tools).toEqual([]);
  });

  it("reads legacy V1 trust grants as grants without persistent permissions", () => {
    const { workspace } = fixture();
    fs.mkdirSync(path.dirname(resolveMcpTrustPath()), { recursive: true });
    fs.writeFileSync(
      resolveMcpTrustPath(),
      JSON.stringify({
        version: 1,
        grants: [
          {
            workspaceRoot: path.resolve(workspace),
            serverId: "docs",
            configFingerprint: "a".repeat(64),
          },
        ],
      }),
    );

    expect(readMcpTrustGrants(workspace)).toEqual([
      { serverId: "docs", configFingerprint: "a".repeat(64) },
    ]);
    expect(readMcpPersistentPermissions(workspace)).toEqual([
      {
        serverId: "docs",
        configFingerprint: "a".repeat(64),
        chatAccess: false,
        tools: [],
      },
    ]);
  });
});
