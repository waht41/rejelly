import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXTENSION_LIMITS } from "../../shared/extensionLimits";
import { loadPluginManifest } from "./manifest";
import type { PluginSourceCandidate } from "./sourceRoots";

describe("plugin manifest loader", () => {
  let fixtureRoot: string;
  let pluginRoot: string;

  beforeEach(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evil-plugin-manifest-"));
    pluginRoot = path.join(fixtureRoot, "plugin");
    await fs.mkdir(pluginRoot);
  });

  afterEach(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  function candidate(): PluginSourceCandidate {
    return {
      kind: "plugin",
      scope: "project",
      directoryName: "plugin",
      directoryPath: pluginRoot,
      manifestPath: path.join(pluginRoot, "plugin.jsonc"),
    };
  }

  async function writeManifest(raw: string | Buffer): Promise<void> {
    await fs.writeFile(path.join(pluginRoot, "plugin.jsonc"), raw);
  }

  it("loads comments and trailing commas while preserving all contributions as opaque values", async () => {
    await writeManifest(`{
      // stable envelope
      "manifestVersion": 1,
      "id": "com.example.plugin",
      "contributions": {
        "skills": { "apiVersion": 1 },
        "future": { "apiVersion": 9, "spec": { "opaque": true } },
      },
    }`);

    const result = await loadPluginManifest(candidate());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.plugin.id).toBe("com.example.plugin");
    expect(result.plugin.manifest.contributions).toEqual({
      skills: { apiVersion: 1 },
      future: { apiVersion: 9, spec: { opaque: true } },
    });
    expect(result.plugin).not.toHaveProperty("skills");
    expect(result.diagnostics).toEqual([]);
    expect(Object.isFrozen(result.plugin.manifest.contributions)).toBe(true);
  });

  it("rejects malformed JSONC and duplicate keys", async () => {
    await writeManifest("{");
    await expect(loadPluginManifest(candidate())).resolves.toMatchObject({
      ok: false,
      diagnostics: [{ code: "plugin.manifest.invalid-jsonc" }],
    });

    await writeManifest(`{
      "manifestVersion": 1,
      "id": "com.example.first",
      "id": "com.example.second",
      "contributions": {}
    }`);
    await expect(loadPluginManifest(candidate())).resolves.toMatchObject({
      ok: false,
      diagnostics: [{ code: "plugin.manifest.invalid-jsonc" }],
    });
  });

  it("rejects unsupported envelopes, excessive depth, and excessive size", async () => {
    await writeManifest(`{"manifestVersion":2,"id":"com.example.plugin","contributions":{}}`);
    await expect(loadPluginManifest(candidate())).resolves.toMatchObject({
      ok: false,
      diagnostics: [{ code: "plugin.manifest.unsupported-version" }],
    });

    let nested = "0";
    for (let index = 0; index < EXTENSION_LIMITS.pluginManifestDepth + 1; index++) {
      nested = `{"nested":${nested}}`;
    }
    await writeManifest(
      `{"manifestVersion":1,"id":"com.example.plugin","contributions":{"future":${nested}}}`,
    );
    await expect(loadPluginManifest(candidate())).resolves.toMatchObject({
      ok: false,
      diagnostics: [{ code: "plugin.manifest.invalid" }],
    });

    await writeManifest(Buffer.alloc(EXTENSION_LIMITS.pluginManifestBytes + 1, 0x20));
    await expect(loadPluginManifest(candidate())).resolves.toMatchObject({
      ok: false,
      diagnostics: [{ code: "plugin.manifest.invalid" }],
    });
  });

  it("treats an omitted contributions block as an empty one", async () => {
    await writeManifest(`{"manifestVersion":1,"id":"com.example.plugin"}`);

    const result = await loadPluginManifest(candidate());

    expect(result).toMatchObject({ ok: true, diagnostics: [] });
    if (result.ok) {
      expect(result.plugin.manifest.contributions).toEqual({});
    }
  });

  it("degrades pathological nesting into a diagnostic instead of an exception", async () => {
    // Nesting that fits in the byte budget can still exhaust the stack inside the JSONC parser and
    // the duplicate-key walk. Every recursive stage must stay behind the loader's result contract.
    const levels = 5_000;
    await writeManifest(
      `{"manifestVersion":1,"id":"com.example.plugin","contributions":{"future":${"[".repeat(levels)}0${"]".repeat(levels)}}}`,
    );

    const result = await loadPluginManifest(candidate());

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.severity).toBe("warning");
  });

  it("does not interpret known-looking contribution payloads", async () => {
    const skills = { apiVersion: 2, spec: { unexpected: true } };
    await writeManifest(
      JSON.stringify({
        manifestVersion: 1,
        id: "com.example.plugin",
        contributions: { skills },
      }),
    );

    const result = await loadPluginManifest(candidate());

    expect(result).toMatchObject({ ok: true, diagnostics: [] });
    if (result.ok) {
      expect(result.plugin.manifest.contributions.skills).toEqual(skills);
    }
  });
});
