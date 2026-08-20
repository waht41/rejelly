import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { grantMcpWorkspaceTrust, readMcpTrustGrants, resolveMcpTrustPath } from "./trustRepository";

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
});
