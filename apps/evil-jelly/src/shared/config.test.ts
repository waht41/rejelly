import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const undiciMock = vi.hoisted(() => ({
  EnvHttpProxyAgent: vi.fn(function EnvHttpProxyAgent() {}),
  setGlobalDispatcher: vi.fn(),
}));

vi.mock("undici", () => undiciMock);

import { loadEvilJellyEnv, resolveGlobalEnvPath, saveGlobalEnvValues } from "./config";
import { getWorkspaceFsPolicy, setWorkspaceRoot } from "./fs-policy/workspace-fs-policy";
import { resolveGlobalJellyDir } from "./globalPath";

const createdDirs: string[] = [];
const trackedEnvKeys = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_PROVIDER",
  "OPENAI_MODEL_ID",
  "USE_PROXY",
  "PROXY_URL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
];
const proxyOnce = Symbol.for("rejelly.env.proxyConfigured");
const originalWorkspaceRoot = getWorkspaceFsPolicy().getRoot();
const originalEnv: Record<string, string | undefined> = Object.fromEntries(
  trackedEnvKeys.map((key) => [key, process.env[key]]),
);

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

/** Temp workspace with `.evil-jelly/.env` holding the given lines; bound as fs-policy root. */
function createWorkspaceWithEnv(content: string): string {
  const dir = createTempDir("evil-jelly-ws-");
  fs.mkdirSync(path.join(dir, ".evil-jelly"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".evil-jelly", ".env"), content, "utf-8");
  setWorkspaceRoot(dir);
  return dir;
}

function writeGlobalEnv(homeDir: string, content: string): void {
  fs.mkdirSync(path.join(homeDir, ".evil-jelly"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".evil-jelly", ".env"), content, "utf-8");
}

function restoreTrackedEnv() {
  for (const key of trackedEnvKeys) {
    const originalValue = originalEnv[key];
    if (originalValue === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = originalValue;
  }
}

beforeEach(() => {
  const homeDir = createTempDir("evil-jelly-home-");
  vi.spyOn(os, "homedir").mockReturnValue(homeDir);
  undiciMock.EnvHttpProxyAgent.mockClear();
  undiciMock.setGlobalDispatcher.mockClear();
  delete (globalThis as typeof globalThis & Record<symbol, boolean | undefined>)[proxyOnce];
});

afterEach(() => {
  setWorkspaceRoot(originalWorkspaceRoot);
  vi.restoreAllMocks();
  delete (globalThis as typeof globalThis & Record<symbol, boolean | undefined>)[proxyOnce];
  restoreTrackedEnv();
  for (const dir of createdDirs.splice(0, createdDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadEvilJellyEnv", () => {
  it("loads from workspace .evil-jelly/.env when process env is missing", () => {
    createWorkspaceWithEnv("OPENAI_API_KEY=workspace-key\n");
    delete process.env.OPENAI_API_KEY;

    loadEvilJellyEnv();

    expect(process.env.OPENAI_API_KEY).toBe("workspace-key");
  });

  it("does NOT read the workspace's plain .env (it belongs to the app under development)", () => {
    const dir = createTempDir("evil-jelly-ws-");
    fs.writeFileSync(path.join(dir, ".env"), "OPENAI_API_KEY=app-key\n", "utf-8");
    setWorkspaceRoot(dir);
    delete process.env.OPENAI_API_KEY;

    loadEvilJellyEnv();

    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });

  it("prefers workspace .evil-jelly/.env over ~/.evil-jelly/.env", () => {
    createWorkspaceWithEnv("OPENAI_API_KEY=workspace-key\n");
    const homeDir = createTempDir("evil-jelly-home-");
    writeGlobalEnv(homeDir, "OPENAI_API_KEY=global-key\n");
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    delete process.env.OPENAI_API_KEY;

    loadEvilJellyEnv();

    expect(process.env.OPENAI_API_KEY).toBe("workspace-key");
  });

  it("falls back to ~/.evil-jelly/.env for keys the workspace file does not define", () => {
    createWorkspaceWithEnv("OPENAI_MODEL_ID=ws-model\n");
    const homeDir = createTempDir("evil-jelly-home-");
    writeGlobalEnv(homeDir, "OPENAI_API_KEY=global-key\n");
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL_ID;

    loadEvilJellyEnv();

    expect(process.env.OPENAI_API_KEY).toBe("global-key");
    expect(process.env.OPENAI_MODEL_ID).toBe("ws-model");
  });

  it("keeps process env value over file values", () => {
    createWorkspaceWithEnv("OPENAI_API_KEY=workspace-key\n");
    process.env.OPENAI_API_KEY = "env-key";

    loadEvilJellyEnv();

    expect(process.env.OPENAI_API_KEY).toBe("env-key");
  });

  it("uses CLI api key as final override", () => {
    createWorkspaceWithEnv("OPENAI_API_KEY=workspace-key\n");
    process.env.OPENAI_API_KEY = "env-key";

    loadEvilJellyEnv({ cliApiKey: "cli-key" });

    expect(process.env.OPENAI_API_KEY).toBe("cli-key");
  });

  it("warns when the workspace file routes a key from another layer", () => {
    createWorkspaceWithEnv("OPENAI_BASE_URL=https://elsewhere.example/v1\n");
    const homeDir = createTempDir("evil-jelly-home-");
    writeGlobalEnv(homeDir, "OPENAI_API_KEY=global-key\n");
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    loadEvilJellyEnv();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("OPENAI_BASE_URL comes from .evil-jelly/.env"),
    );
  });

  it("does not warn when key and endpoint come from the same workspace file", () => {
    createWorkspaceWithEnv(
      "OPENAI_API_KEY=workspace-key\nOPENAI_BASE_URL=https://mine.example/v1\n",
    );
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    loadEvilJellyEnv();

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("does not warn when the endpoint comes from the global file for a workspace key", () => {
    createWorkspaceWithEnv("OPENAI_API_KEY=workspace-key\n");
    const homeDir = createTempDir("evil-jelly-home-");
    writeGlobalEnv(homeDir, "OPENAI_BASE_URL=https://mine.example/v1\n");
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    loadEvilJellyEnv();

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("configures the LLM API proxy after loading layered env", () => {
    createWorkspaceWithEnv("USE_PROXY=true\nPROXY_URL=http://127.0.0.1:7891\n");
    delete process.env.USE_PROXY;
    delete process.env.PROXY_URL;
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.NO_PROXY;

    loadEvilJellyEnv();

    expect(process.env.HTTP_PROXY).toBe("http://127.0.0.1:7891");
    expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:7891");
    expect(process.env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
    expect(undiciMock.EnvHttpProxyAgent).toHaveBeenCalledTimes(1);
    expect(undiciMock.setGlobalDispatcher).toHaveBeenCalledTimes(1);
  });

  it("does not configure a proxy when USE_PROXY is disabled", () => {
    createWorkspaceWithEnv("PROXY_URL=http://127.0.0.1:7891\n");
    delete process.env.USE_PROXY;
    delete process.env.PROXY_URL;

    loadEvilJellyEnv();

    expect(undiciMock.EnvHttpProxyAgent).not.toHaveBeenCalled();
    expect(undiciMock.setGlobalDispatcher).not.toHaveBeenCalled();
  });
});

describe("saveGlobalEnvValues", () => {
  it("writes values into ~/.evil-jelly/.env", () => {
    const homeDir = createTempDir("evil-jelly-home-");
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);

    const outputPath = saveGlobalEnvValues({ OPENAI_API_KEY: "sk-test-key" });
    const fileContent = fs.readFileSync(outputPath, "utf-8");

    expect(outputPath).toBe(resolveGlobalEnvPath());
    expect(outputPath).toBe(path.join(resolveGlobalJellyDir(), ".env"));
    expect(fileContent).toContain("OPENAI_API_KEY=sk-test-key");
  });

  it("merges new values with existing keys (evil init --base-url)", () => {
    const homeDir = createTempDir("evil-jelly-home-");
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);

    saveGlobalEnvValues({ OPENAI_API_KEY: "sk-old-key", OPENAI_MODEL_ID: "gpt-5.6-luna" });
    const outputPath = saveGlobalEnvValues({
      OPENAI_API_KEY: "sk-new-key",
      OPENAI_BASE_URL: "https://mine.example/v1",
    });
    const fileContent = fs.readFileSync(outputPath, "utf-8");

    expect(fileContent).toContain("OPENAI_API_KEY=sk-new-key");
    expect(fileContent).toContain("OPENAI_BASE_URL=https://mine.example/v1");
    expect(fileContent).toContain("OPENAI_MODEL_ID=gpt-5.6-luna");
  });
});
