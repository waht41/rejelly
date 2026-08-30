import fs from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseJsonc } from "../../../shared/foundation/jsonc";
import {
  addMcpServerSettings,
  readMcpSettingsScope,
  removeMcpServerSettings,
  resolveMcpSettingsPath,
  setMcpServerEnabled,
} from "./settingsRepository";

describe("MCP settings file repository", () => {
  let home: string;
  let workspace: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(tmpdir(), "evil-mcp-home-"));
    workspace = fs.mkdtempSync(path.join(tmpdir(), "evil-mcp-workspace-"));
    vi.spyOn(os, "homedir").mockReturnValue(home);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("atomically adds and toggles a server while preserving unrelated JSONC", () => {
    const filePath = resolveMcpSettingsPath("project", workspace);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      `{
  // keep this preference
  "skills": { "enabled": false }
}\n`,
    );

    addMcpServerSettings("project", workspace, "docs", {
      transport: { type: "stdio", command: "docs-mcp" },
    });
    setMcpServerEnabled("project", workspace, "docs", false);

    const raw = fs.readFileSync(filePath, "utf8");
    expect(raw).toContain("// keep this preference");
    expect(readMcpSettingsScope("project", workspace).servers?.docs).toMatchObject({
      enabled: false,
      transport: { type: "stdio", command: "docs-mcp" },
    });
    expect(fs.readdirSync(path.dirname(filePath)).some((name) => name.endsWith(".tmp"))).toBe(
      false,
    );
  });

  it("removes only the explicitly selected scope", () => {
    addMcpServerSettings("user", workspace, "docs", {
      transport: { type: "stdio", command: "user-docs" },
    });
    addMcpServerSettings("project", workspace, "docs", {
      transport: { type: "stdio", command: "project-docs" },
    });

    removeMcpServerSettings("project", workspace, "docs");

    expect(readMcpSettingsScope("project", workspace).servers?.docs).toBeUndefined();
    expect(readMcpSettingsScope("user", workspace).servers?.docs?.transport).toMatchObject({
      command: "user-docs",
    });
  });

  it("does not fall through to another scope when the selected server is absent", () => {
    addMcpServerSettings("user", workspace, "docs", {
      transport: { type: "stdio", command: "user-docs" },
    });

    expect(() => removeMcpServerSettings("project", workspace, "docs")).toThrow(
      /other scope was not changed/,
    );
    expect(readMcpSettingsScope("user", workspace).servers?.docs).toBeDefined();
  });

  it("rejects project mutations when the home workspace aliases user settings", () => {
    expect(() => resolveMcpSettingsPath("project", home)).toThrow(
      /Project MCP settings are unavailable/,
    );
    expect(resolveMcpSettingsPath("user", home)).toBe(
      path.join(home, ".evil-jelly", "settings.jsonc"),
    );
  });

  it("rejects reserved ids and reports a malformed server path", () => {
    expect(() =>
      addMcpServerSettings("user", workspace, "evil.devtool", {
        transport: { type: "stdio", command: "shadow" },
      }),
    ).toThrow(/reserved/);

    const filePath = resolveMcpSettingsPath("project", workspace);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      `{ "mcp": { "servers": { "broken": { "transport": { "type": "stdio" } } } } }`,
    );
    expect(() => readMcpSettingsScope("project", workspace)).toThrow(/broken/);
    expect(() => parseJsonc(fs.readFileSync(filePath, "utf8"))).not.toThrow();
  });
});
