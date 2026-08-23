import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const undiciMock = vi.hoisted(() => ({
  EnvHttpProxyAgent: vi.fn(function EnvHttpProxyAgent() {}),
  setGlobalDispatcher: vi.fn(),
}));

vi.mock("undici", () => undiciMock);

import { getWorkspaceFsPolicy, setWorkspaceRoot } from "../fs-policy/workspace-fs-policy";
import { resolveGlobalJellyDir } from "../globalPath";
import { env, loadEvilJellyEnv, resolveGlobalEnvPath, saveGlobalEnvValues } from "./env";

const createdDirs: string[] = [];
const trackedEnvKeys = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_PROVIDER",
  "OPENAI_MODEL_ID",
  "OPENAI_CONTEXT_WINDOW",
  "OPENAI_AUTO_COMPACT_TOKENS",
  "OPENAI_AUTO_COMPACT_RATIO",
  "OPENAI_REASONING_EFFORT",
  "OPENAI_RETRY_MAX_ATTEMPTS",
  "REJELLY_ENABLE_REVIEW",
  "REJELLY_REVIEW_ENDPOINT",
  "WEB_PROXY_URL",
  "WEB_USE_PROXY",
  "WEB_USER_AGENT",
  "WEB_TIMEOUT_MS",
  "WEB_MAX_FETCH_BYTES",
  "WEB_SEARCH_PROVIDER",
  "WEB_SEARCH_LLM_BASE_URL",
  "WEB_SEARCH_LLM_API_KEY",
  "WEB_SEARCH_LLM_MODEL",
  "USE_PROXY",
  "PROXY_URL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "GITHUB_TOKEN",
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

/** Write a named `--env` profile beside the global file under the mocked home dir. */
function writeEnvProfile(homeDir: string, name: string, content: string): string {
  const dir = path.join(homeDir, ".evil-jelly");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.env`);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

/** Temp home dir bound as `os.homedir()`, so ~/.evil-jelly resolves inside it. */
function useHomeDir(): string {
  const homeDir = createTempDir("evil-jelly-home-");
  vi.spyOn(os, "homedir").mockReturnValue(homeDir);
  return homeDir;
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

describe("loadEvilJellyEnv with --env", () => {
  it("resolves a bare name to ~/.evil-jelly/<name>.env and outranks the shell", () => {
    const homeDir = useHomeDir();
    writeEnvProfile(homeDir, "luna", "OPENAI_API_KEY=luna-key\nOPENAI_MODEL_ID=luna-model\n");
    createWorkspaceWithEnv("OPENAI_MODEL_ID=workspace-model\n");
    process.env.OPENAI_MODEL_ID = "shell-model";

    loadEvilJellyEnv({ envFile: "luna" });

    // The whole point of the flag: an exported model id must not survive an explicit profile.
    expect(process.env.OPENAI_MODEL_ID).toBe("luna-model");
    expect(process.env.OPENAI_API_KEY).toBe("luna-key");
  });

  it("allows --api-key to override the profile", () => {
    const homeDir = useHomeDir();
    writeEnvProfile(homeDir, "luna", "OPENAI_API_KEY=luna-key\n");
    createWorkspaceWithEnv("");

    loadEvilJellyEnv({ envFile: "luna", cliApiKey: "cli-key" });

    expect(process.env.OPENAI_API_KEY).toBe("cli-key");
  });

  it("inherits shell config but skips workspace and global env files", () => {
    const homeDir = useHomeDir();
    writeEnvProfile(homeDir, "luna", "OPENAI_API_KEY=luna-key\n");
    writeGlobalEnv(homeDir, "WEB_TIMEOUT_MS=9000\nUSE_PROXY=true\nPROXY_URL=http://global:7890\n");
    createWorkspaceWithEnv("OPENAI_BASE_URL=https://workspace.example/v1\n");
    process.env.OPENAI_MODEL_ID = "shell-model";
    process.env.WEB_SEARCH_PROVIDER = "llm";
    process.env.GITHUB_TOKEN = "integration-secret";
    delete process.env.OPENAI_BASE_URL;
    delete process.env.WEB_TIMEOUT_MS;
    delete process.env.USE_PROXY;
    delete process.env.PROXY_URL;

    loadEvilJellyEnv({ envFile: "luna" });

    expect(process.env.OPENAI_MODEL_ID).toBe("shell-model");
    expect(process.env.OPENAI_BASE_URL).toBeUndefined();
    expect(process.env.WEB_TIMEOUT_MS).toBeUndefined();
    expect(process.env.WEB_SEARCH_PROVIDER).toBe("llm");
    expect(process.env.USE_PROXY).toBeUndefined();
    expect(process.env.PROXY_URL).toBeUndefined();
    expect(process.env.GITHUB_TOKEN).toBe("integration-secret");
    expect(undiciMock.EnvHttpProxyAgent).not.toHaveBeenCalled();
  });

  it("lets profile proxy values override the same shell variables", () => {
    const homeDir = useHomeDir();
    writeEnvProfile(
      homeDir,
      "luna",
      "OPENAI_API_KEY=luna-key\nUSE_PROXY=true\nHTTPS_PROXY=http://profile:7891\n",
    );
    process.env.HTTPS_PROXY = "http://shell:7892";

    loadEvilJellyEnv({ envFile: "luna" });

    expect(process.env.HTTP_PROXY).toBe("http://profile:7891");
    expect(process.env.HTTPS_PROXY).toBe("http://profile:7891");
    expect(undiciMock.EnvHttpProxyAgent).toHaveBeenCalledTimes(1);
  });

  it("inherits proxy configuration from the shell", () => {
    const homeDir = useHomeDir();
    writeEnvProfile(homeDir, "luna", "OPENAI_API_KEY=luna-key\n");
    process.env.USE_PROXY = "true";
    process.env.HTTPS_PROXY = "http://shell:7892";

    loadEvilJellyEnv({ envFile: "luna" });

    expect(process.env.HTTP_PROXY).toBe("http://shell:7892");
    expect(process.env.HTTPS_PROXY).toBe("http://shell:7892");
    expect(undiciMock.EnvHttpProxyAgent).toHaveBeenCalledTimes(1);
  });

  it("accepts a path instead of a profile name", () => {
    useHomeDir();
    const dir = createTempDir("evil-jelly-profile-");
    const filePath = path.join(dir, "custom.env");
    fs.writeFileSync(filePath, "OPENAI_API_KEY=path-key\n", "utf-8");
    createWorkspaceWithEnv("");

    loadEvilJellyEnv({ envFile: filePath });

    expect(process.env.OPENAI_API_KEY).toBe("path-key");
  });

  it("fails on an unknown profile and names the ones that exist", () => {
    const homeDir = useHomeDir();
    writeEnvProfile(homeDir, "luna", "OPENAI_API_KEY=luna-key\n");
    writeEnvProfile(homeDir, "ds-max", "OPENAI_API_KEY=ds-key\n");
    // The default file shares the directory but is the unnamed identity, not a profile.
    writeGlobalEnv(homeDir, "OPENAI_API_KEY=global-key\n");
    createWorkspaceWithEnv("");

    expect(() => loadEvilJellyEnv({ envFile: "typo" })).toThrow("Known profiles: ds-max, luna.");
  });

  it("requires every explicit profile to carry its own key", () => {
    const homeDir = useHomeDir();
    writeEnvProfile(homeDir, "luna", "OPENAI_MODEL_ID=luna-model\n");
    writeGlobalEnv(homeDir, "OPENAI_API_KEY=global-key\n");
    createWorkspaceWithEnv("");
    process.env.OPENAI_API_KEY = "shell-key";

    expect(() => loadEvilJellyEnv({ envFile: "luna" })).toThrow(
      /does not set OPENAI_API_KEY.*do not borrow API keys from the shell or default env files/,
    );
  });

  it("accepts a keyless profile when --api-key supplies the key", () => {
    const homeDir = useHomeDir();
    writeEnvProfile(homeDir, "luna", "OPENAI_MODEL_ID=luna-model\n");

    loadEvilJellyEnv({ envFile: "luna", cliApiKey: "cli-key" });

    expect(process.env.OPENAI_API_KEY).toBe("cli-key");
    expect(process.env.OPENAI_MODEL_ID).toBe("luna-model");
  });

  it("accepts routing vars when the profile carries its own key", () => {
    const homeDir = useHomeDir();
    writeEnvProfile(
      homeDir,
      "luna",
      "OPENAI_API_KEY=luna-key\nOPENAI_BASE_URL=https://elsewhere.example/v1\n",
    );
    createWorkspaceWithEnv("");
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;

    loadEvilJellyEnv({ envFile: "luna" });

    expect(process.env.OPENAI_BASE_URL).toBe("https://elsewhere.example/v1");
  });
});

describe("OPENAI_CONTEXT_WINDOW", () => {
  it("rejects an explicitly configured window below 32k", () => {
    process.env.OPENAI_CONTEXT_WINDOW = "31999";

    expect(() => env.OPENAI_CONTEXT_WINDOW).toThrow(
      "OPENAI_CONTEXT_WINDOW must be at least 32000 tokens",
    );
  });

  it("accepts a 32k context window", () => {
    process.env.OPENAI_CONTEXT_WINDOW = "32000";

    expect(env.OPENAI_CONTEXT_WINDOW).toBe(32000);
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
