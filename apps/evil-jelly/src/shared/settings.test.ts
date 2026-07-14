import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getWorkspaceFsPolicy, setWorkspaceRoot } from "./fs-policy/workspace-fs-policy";
import { DOC_MAP_DEFAULT_PATH, getSettings, initSettings } from "./settings";

describe("settings resolution", () => {
  let prevRoot: string;
  let dir: string;

  beforeEach(() => {
    prevRoot = getWorkspaceFsPolicy().getRoot();
    dir = mkdtempSync(join(tmpdir(), "evil-jelly-settings-"));
    setWorkspaceRoot(dir);
    initSettings({});
  });

  afterEach(() => {
    setWorkspaceRoot(prevRoot);
    initSettings({});
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSettingsFile(content: string): void {
    mkdirSync(join(dir, ".evil-jelly"), { recursive: true });
    writeFileSync(join(dir, ".evil-jelly", "settings.jsonc"), content);
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
    expect(s.devtoolMcp).toBe(false);
  });

  it("reads values from .evil-jelly/settings.jsonc (JSONC comments allowed)", () => {
    writeSettingsFile(`{
      // repo facts
      "audit": { "concurrency": 8, "maxSeeds": 64, "ledgerGcDays": 14 }
    }`);
    const s = getSettings();
    expect(s.docMap).toBe(DOC_MAP_DEFAULT_PATH);
    expect(s.audit).toEqual({
      concurrency: 8,
      maxSeeds: 64,
      ledgerGcDays: 14,
      disableLedgerGc: false,
    });
  });

  it("applies CLI overrides over built-in defaults", () => {
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
    writeSettingsFile(`{ "sync": { "zhDir": "cn", "enDir": "en" } }`);
    expect(() => getSettings()).toThrow(/failed validation/);
  });

  it("rejects the removed docMap key loudly", () => {
    writeSettingsFile(`{ "docMap": "docs/map.jsonc" }`);
    expect(() => getSettings()).toThrow(/failed validation/);
  });

  it("throws loudly on malformed JSON", () => {
    writeSettingsFile("{ nope");
    expect(() => getSettings()).toThrow(/not valid JSON/);
  });

  it("throws loudly on unknown keys", () => {
    writeSettingsFile(`{ "docsMap": "typo.jsonc" }`);
    expect(() => getSettings()).toThrow(/failed validation/);
  });

  it("caches per workspace root and re-resolves after initSettings", () => {
    expect(getSettings().audit).toEqual({
      concurrency: undefined,
      maxSeeds: undefined,
      ledgerGcDays: undefined,
      disableLedgerGc: false,
    });
    writeSettingsFile(`{ "audit": { "concurrency": 8 } }`);
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
