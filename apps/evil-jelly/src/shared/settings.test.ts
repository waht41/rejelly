import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWorkspaceFsPolicy, setWorkspaceRoot } from "./fs-policy/workspace-fs-policy";
import {
  DOC_MAP_DEFAULT_PATH,
  getSettings,
  initSettings,
  resolveUserSettingsPath,
} from "./settings";

describe("settings resolution", () => {
  let previousWorkspaceRoot: string;
  let homeDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    previousWorkspaceRoot = getWorkspaceFsPolicy().getRoot();
    homeDir = mkdtempSync(join(tmpdir(), "evil-jelly-settings-home-"));
    workspaceDir = mkdtempSync(join(tmpdir(), "evil-jelly-settings-workspace-"));
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    setWorkspaceRoot(workspaceDir);
    initSettings({});
  });

  afterEach(() => {
    setWorkspaceRoot(previousWorkspaceRoot);
    initSettings({});
    vi.restoreAllMocks();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function writeUserSettingsFile(content: string): void {
    mkdirSync(join(homeDir, ".evil-jelly"), { recursive: true });
    writeFileSync(join(homeDir, ".evil-jelly", "settings.jsonc"), content);
  }

  function writeWorkspaceSettingsFile(content: string): void {
    mkdirSync(join(workspaceDir, ".evil-jelly"), { recursive: true });
    writeFileSync(join(workspaceDir, ".evil-jelly", "settings.jsonc"), content);
  }

  it("falls back to built-in defaults when no settings file exists", () => {
    const s = getSettings();
    expect(s.docMap).toBe(DOC_MAP_DEFAULT_PATH);
    expect(s.audit).toEqual({
      concurrency: undefined,
      maxSeeds: undefined,
      ledgerGcDays: undefined,
      disableLedgerGc: false,
    });
    expect(s.skills).toEqual({ enabled: true, overrides: {} });
    expect(s.devtoolMcp).toBe(false);
  });

  it("reads values from workspace .evil-jelly/settings.jsonc", () => {
    writeWorkspaceSettingsFile(`{
      // repo facts
      "audit": { "concurrency": 8, "maxSeeds": 64, "ledgerGcDays": 14 }
    }`);

    expect(getSettings().audit).toEqual({
      concurrency: 8,
      maxSeeds: 64,
      ledgerGcDays: 14,
      disableLedgerGc: false,
    });
  });

  it("reads ~/.evil-jelly/settings.jsonc (JSONC comments allowed)", () => {
    writeUserSettingsFile(`{
      // personal defaults
      "audit": { "concurrency": 4, "maxSeeds": 48, "ledgerGcDays": 21 }
    }`);

    expect(getSettings().audit).toEqual({
      concurrency: 4,
      maxSeeds: 48,
      ledgerGcDays: 21,
      disableLedgerGc: false,
    });
  });

  it("resolves the user settings path through the global directory authority", () => {
    expect(resolveUserSettingsPath()).toBe(join(homeDir, ".evil-jelly", "settings.jsonc"));
  });

  it("resolves each workspace field over its user default", () => {
    writeUserSettingsFile(`{
      "audit": { "concurrency": 4, "maxSeeds": 48, "ledgerGcDays": 21 }
    }`);
    writeWorkspaceSettingsFile(`{
      "audit": { "concurrency": 8, "ledgerGcDays": 14 }
    }`);

    expect(getSettings().audit).toEqual({
      concurrency: 8,
      maxSeeds: 48,
      ledgerGcDays: 14,
      disableLedgerGc: false,
    });
  });

  it("resolves Skill defaults and per-name overrides field by field", () => {
    writeUserSettingsFile(`{
      "skills": {
        "enabled": false,
        "overrides": {
          "user:review": { "enabled": false },
          "project:shared": { "enabled": false }
        }
      }
    }`);
    writeWorkspaceSettingsFile(`{
      "skills": {
        "enabled": true,
        "overrides": {
          "user:review": { "enabled": true },
          "project:local": { "enabled": false }
        }
      }
    }`);

    expect(getSettings().skills).toEqual({
      enabled: true,
      overrides: {
        "user:review": { enabled: true },
        "project:shared": { enabled: false },
        "project:local": { enabled: false },
      },
    });
  });

  it("applies CLI overrides over workspace and user values", () => {
    writeUserSettingsFile(`{
      "audit": { "maxSeeds": 48, "ledgerGcDays": 21 }
    }`);
    writeWorkspaceSettingsFile(`{
      "audit": { "maxSeeds": 40, "ledgerGcDays": 14 }
    }`);
    initSettings({
      docMap: "other/map.jsonc",
      devtoolMcp: true,
      auditMaxSeeds: 32,
      auditLedgerGcDays: 7,
      auditDisableLedgerGc: true,
    });
    const s = getSettings();
    expect(s.docMap).toBe("other/map.jsonc");
    expect(s.devtoolMcp).toBe(true);
    expect(s.audit).toMatchObject({
      maxSeeds: 32,
      ledgerGcDays: 7,
      disableLedgerGc: true,
    });
  });

  it("rejects the removed sync key loudly", () => {
    writeWorkspaceSettingsFile(`{ "sync": { "zhDir": "cn", "enDir": "en" } }`);
    expect(() => getSettings()).toThrow(/failed validation/);
  });

  it("rejects the removed docMap key loudly", () => {
    writeWorkspaceSettingsFile(`{ "docMap": "docs/map.jsonc" }`);
    expect(() => getSettings()).toThrow(/failed validation/);
  });

  it("throws loudly on malformed workspace settings", () => {
    writeWorkspaceSettingsFile("{ nope");
    expect(() => getSettings()).toThrow(/not valid JSON/);
  });

  it("throws loudly on unknown workspace setting keys", () => {
    writeWorkspaceSettingsFile(`{ "docsMap": "typo.jsonc" }`);
    expect(() => getSettings()).toThrow(/failed validation/);
  });

  it("throws loudly on malformed user settings", () => {
    writeUserSettingsFile("{ nope");
    expect(() => getSettings()).toThrow(/not valid JSON/);
  });

  it("throws loudly on unknown user setting keys", () => {
    writeUserSettingsFile(`{ "docsMap": "typo.jsonc" }`);
    expect(() => getSettings()).toThrow(/failed validation/);
  });

  it("rejects plain or malformed Skill override names", () => {
    writeUserSettingsFile(`{
      "skills": { "overrides": { "review": { "enabled": false } } }
    }`);
    expect(() => getSettings()).toThrow(/qualified Skill name/);
  });

  it("rejects unknown Skill override fields", () => {
    writeUserSettingsFile(`{
      "skills": {
        "overrides": { "user:review": { "enabled": false, "future": true } }
      }
    }`);
    expect(() => getSettings()).toThrow(/failed validation/);
  });

  it("throws loudly when a settings path cannot be read", () => {
    mkdirSync(join(homeDir, ".evil-jelly", "settings.jsonc"), { recursive: true });
    expect(() => getSettings()).toThrow(/could not be read/);
  });

  it("caches per workspace root and re-resolves after initSettings", () => {
    expect(getSettings().audit).toEqual({
      concurrency: undefined,
      maxSeeds: undefined,
      ledgerGcDays: undefined,
      disableLedgerGc: false,
    });
    writeWorkspaceSettingsFile(`{ "audit": { "concurrency": 8 } }`);
    // Cached: the file written after first resolution is not picked up...
    expect(getSettings().audit).toEqual({
      concurrency: undefined,
      maxSeeds: undefined,
      ledgerGcDays: undefined,
      disableLedgerGc: false,
    });
    // ...until the cache is reset.
    initSettings({});
    expect(getSettings().audit).toEqual({
      concurrency: 8,
      maxSeeds: undefined,
      ledgerGcDays: undefined,
      disableLedgerGc: false,
    });
  });
});
