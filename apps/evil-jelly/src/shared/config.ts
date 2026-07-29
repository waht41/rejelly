/**
 * Env loading, OpenAI adapter factory, and Review exporter option resolution.
 */

import fs from "node:fs";
import path from "node:path";
import { createOpenAIAdapter } from "@rejelly/adapter-openai";
import { augmentModel, type ModelAdapter } from "@rejelly/core";
import type { ReviewOptions } from "@rejelly/core/debugger";
import { parse as parseEnv } from "dotenv";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import {
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL_ID,
  MIN_OPENAI_CONTEXT_WINDOW_TOKENS,
} from "./configDefaults";
import { getWorkspaceFsPolicy } from "./fs-policy/workspace-fs-policy";
import { resolveGlobalJellyDir } from "./globalPath";
import { withRetry } from "./lib/withRetry";

const FALLBACK_REVIEW_ENDPOINT = "http://localhost:5789/api/v1/traces";
const PROXY_ONCE = Symbol.for("rejelly.env.proxyConfigured");

/** POST ingest path prefix on devtool-server (traceRoutes); replay GET is `{this}/{traceId}/events`. */
const REVIEW_TRACES_PATH_SUFFIX = "/api/v1/traces";

/**
 * Normalize Review base URL so replay GET matches OpenAPI `GET /api/v1/traces/{traceId}/events`.
 * Accepts full ingest URL or origin only (e.g. http://127.0.0.1:5789).
 */
function normalizeReviewTracesEndpoint(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return FALLBACK_REVIEW_ENDPOINT;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }
  let path = url.pathname.replace(/\/+$/, "");
  if (path === "/") {
    path = "";
  }
  if (path.endsWith(REVIEW_TRACES_PATH_SUFFIX)) {
    return `${url.origin}${path}`;
  }
  if (path === "") {
    return `${url.origin}${REVIEW_TRACES_PATH_SUFFIX}`;
  }
  return `${url.origin}${path}${REVIEW_TRACES_PATH_SUFFIX}`;
}

function hasEnvValue(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function isDeepSeekModelConfig(options: {
  modelId: string;
  provider: string;
  baseURL: string;
}): boolean {
  const modelId = options.modelId.trim().toLowerCase();
  const provider = options.provider.trim().toLowerCase();
  const baseURL = options.baseURL.trim().toLowerCase();

  return provider === "deepseek" || modelId.includes("deepseek") || baseURL.includes("deepseek");
}

function readEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  return parseEnv(raw);
}

type EnvParser<T> = (raw: string | undefined) => T;

/** Non-blank string, or the fallback. */
function str(fallback = ""): EnvParser<string> {
  return (raw) => (hasEnvValue(raw) ? raw : fallback);
}

/** Boolean knob: only the literal "true" enables it. */
function flag(): EnvParser<boolean> {
  return (raw) => raw === "true";
}

/** Fraction strictly between 0 and 1; unset/blank/invalid falls back to undefined. */
function ratio(): EnvParser<number | undefined> {
  return (raw) => {
    if (!hasEnvValue(raw)) {
      return undefined;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 && parsed < 1 ? parsed : undefined;
  };
}

/** Strictly-positive integer; unset/blank/invalid falls back. */
function positiveInt(): EnvParser<number | undefined>;
function positiveInt(fallback: number): EnvParser<number>;
function positiveInt(fallback?: number): EnvParser<number | undefined> {
  return (raw) => {
    if (!hasEnvValue(raw)) {
      return fallback;
    }
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
}

/** Positive integer with a hard lower bound when explicitly configured. */
function contextWindow(): EnvParser<number | undefined> {
  return (raw) => {
    const parsed = positiveInt()(raw);
    if (parsed !== undefined && parsed < MIN_OPENAI_CONTEXT_WINDOW_TOKENS) {
      throw new Error(
        `OPENAI_CONTEXT_WINDOW must be at least ${MIN_OPENAI_CONTEXT_WINDOW_TOKENS} tokens; received ${parsed}.`,
      );
    }
    return parsed;
  };
}

/**
 * Manifest of every env var evil-jelly consumes as plain app config — one line per
 * var: name, type, default. Read via `env.NAME`; adding a var means adding a line
 * here and nothing else (no new export, no biome.json change — its exemption list
 * is categorical, not per-var).
 *
 * Not listed here: vars with consumer-specific resolution chains (web substrate →
 * services/web/webConfig.ts) and OS conventions read at spawn time (SHELL/ComSpec,
 * EDITOR/VISUAL) — those files are the fixed biome exemptions.
 */
const ENV_VARS = {
  OPENAI_API_KEY: str(),
  OPENAI_MODEL_ID: str(DEFAULT_OPENAI_MODEL_ID),
  OPENAI_BASE_URL: str(DEFAULT_OPENAI_BASE_URL),
  OPENAI_PROVIDER: str("openai"),
  /** Real model context window (tokens); drives /status display and auto-compaction. */
  OPENAI_CONTEXT_WINDOW: contextWindow(),
  /** Absolute auto-compact trigger budget (tokens); wins over the ratio below. */
  OPENAI_AUTO_COMPACT_TOKENS: positiveInt(),
  /** Auto-compact trigger as a fraction of the context window; default ratio lives in UnifiedAgent. */
  OPENAI_AUTO_COMPACT_RATIO: ratio(),
  OPENAI_RETRY_MAX_ATTEMPTS: positiveInt(3),
  REJELLY_ENABLE_REVIEW: flag(),
  REJELLY_REVIEW_ENDPOINT: str(FALLBACK_REVIEW_ENDPOINT),
} as const;

type EnvView = { readonly [K in keyof typeof ENV_VARS]: ReturnType<(typeof ENV_VARS)[K]> };

/**
 * Lazy view over process.env — every access re-reads, never snapshots: loadEvilJellyEnv
 * and setupProxy mutate process.env after module load, so a snapshot taken at import
 * time would see pre-load values.
 */
export const env: EnvView = Object.defineProperties(
  {} as EnvView,
  Object.fromEntries(
    (Object.keys(ENV_VARS) as Array<keyof typeof ENV_VARS>).map((name) => [
      name,
      { get: () => ENV_VARS[name](process.env[name]), enumerable: true },
    ]),
  ),
);

type OnceFlags = typeof globalThis & Record<symbol, boolean | undefined>;

/**
 * Keep this local copy in sync with @rejelly/env's setupProxy.
 * Evil Jelly has different .env loading semantics but wants the same LLM API proxy behavior.
 */
function setupProxy(): void {
  const useProxy = process.env.USE_PROXY === "true" || process.env.USE_PROXY === "1";
  if (!useProxy) {
    return;
  }

  const flags = globalThis as OnceFlags;
  if (flags[PROXY_ONCE]) {
    return;
  }
  flags[PROXY_ONCE] = true;

  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.PROXY_URL ||
    "http://127.0.0.1:7890";

  process.env.HTTP_PROXY = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
  process.env.NO_PROXY = "localhost,127.0.0.1,::1";

  setGlobalDispatcher(new EnvHttpProxyAgent());

  console.log(`[evil-jelly] Proxy configured: ${proxyUrl} (Bypassing local traffic)`);
}

/** Global config file: ~/.evil-jelly/.env */
export function resolveGlobalEnvPath(): string {
  return path.join(resolveGlobalJellyDir(), ".env");
}

/** Read values already persisted by `evil init`. */
export function readGlobalEnvValues(): Record<string, string> {
  return readEnvFile(resolveGlobalEnvPath());
}

function quoteEnvValue(raw: string): string {
  if (!/[\s#"'\\]/.test(raw)) {
    return raw;
  }
  const escaped = raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** Merge values into ~/.evil-jelly/.env (existing keys are kept unless overwritten). */
export function saveGlobalEnvValues(values: Record<string, string>): string {
  const filePath = resolveGlobalEnvPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const trimmed = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, value.trim()]),
  );
  const next = { ...readEnvFile(filePath), ...trimmed };
  const lines = Object.entries(next).map(([key, value]) => `${key}=${quoteEnvValue(value)}`);
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");
  return filePath;
}

/** Workspace-local env file: secrets stay out of git (settings.jsonc holds the shareable repo facts). */
export const WORKSPACE_ENV_REL_PATH = ".evil-jelly/.env";

type EnvLayer = "cli" | "shell" | "workspace" | "global";

const ENV_LAYER_LABELS: Record<EnvLayer, string> = {
  cli: "--api-key",
  shell: "the shell environment",
  workspace: WORKSPACE_ENV_REL_PATH,
  global: "~/.evil-jelly/.env",
};

/**
 * Vars that decide WHERE the API key is sent. When one of these resolves from the
 * workspace file while the key comes from a machine-level layer, a repo is routing a
 * key it does not own — worth one loud line (still a legitimate setup, so no abort).
 */
const KEY_ROUTING_VARS = ["OPENAI_BASE_URL", "OPENAI_PROVIDER"] as const;

function warnOnWorkspaceRoutedForeignKey(sources: Map<string, EnvLayer>): void {
  const keySource = sources.get("OPENAI_API_KEY");
  if (keySource === undefined || keySource === "workspace") {
    return;
  }
  for (const varName of KEY_ROUTING_VARS) {
    if (sources.get(varName) === "workspace") {
      console.error(
        `[evil-jelly] Warning: ${varName} comes from ${WORKSPACE_ENV_REL_PATH} while ` +
          `OPENAI_API_KEY comes from ${ENV_LAYER_LABELS[keySource]} — the key will be sent to a ` +
          `workspace-configured endpoint. Keep the key and its endpoint in the same layer if unintended.`,
      );
    }
  }
}

/**
 * Load env with cascading priority (closest to the invocation wins):
 * CLI --api-key > process.env (shell) > workspace .evil-jelly/.env > ~/.evil-jelly/.env.
 *
 * The workspace's plain `.env` is deliberately NOT read: it belongs to the app under
 * development (tests/examples), not to evil the tool. Evil-specific secrets live in the
 * tool's own namespace, mirroring `.evil-jelly/settings.jsonc` for shareable repo facts.
 */
export function loadEvilJellyEnv(options?: { cliApiKey?: string | undefined }): void {
  const sources = new Map<string, EnvLayer>();
  for (const varName of ["OPENAI_API_KEY", ...KEY_ROUTING_VARS]) {
    if (hasEnvValue(process.env[varName])) {
      sources.set(varName, "shell");
    }
  }

  const workspaceEnvPath = path.join(getWorkspaceFsPolicy().getRoot(), WORKSPACE_ENV_REL_PATH);
  const layers: ReadonlyArray<{ name: EnvLayer; values: Record<string, string> }> = [
    { name: "workspace", values: readEnvFile(workspaceEnvPath) },
    { name: "global", values: readEnvFile(resolveGlobalEnvPath()) },
  ];
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer.values)) {
      if (!hasEnvValue(process.env[key]) && hasEnvValue(value)) {
        process.env[key] = value;
        sources.set(key, layer.name);
      }
    }
  }

  const cliApiKey = options?.cliApiKey?.trim();
  if (hasEnvValue(cliApiKey)) {
    process.env.OPENAI_API_KEY = cliApiKey;
    sources.set("OPENAI_API_KEY", "cli");
  }

  warnOnWorkspaceRoutedForeignKey(sources);
  setupProxy();
}

export function exitIfMissingOpenAIKey(): void {
  if (!env.OPENAI_API_KEY.trim()) {
    console.error(
      "Missing OPENAI_API_KEY. Set it in the shell environment, <workspace>/.evil-jelly/.env, " +
        "or ~/.evil-jelly/.env (run `evil init`).",
    );
    process.exit(1);
  }
}

/** Model adapter from current process.env (after loadEvilJellyEnv). */
export function createOpenAIModelFromEnv(): ModelAdapter {
  const apiKey = env.OPENAI_API_KEY;
  const modelId = env.OPENAI_MODEL_ID;
  const baseURL = env.OPENAI_BASE_URL;
  const provider = env.OPENAI_PROVIDER;

  // DeepSeek has a native JSON mode (response_format: json_object) but no strict
  // json_schema; route it there.
  const isDeepSeek = isDeepSeekModelConfig({ modelId, provider, baseURL });

  const adapter = createOpenAIAdapter({
    modelId,
    baseURL,
    provider,
    apiKey,
    ...(isDeepSeek ? { schemaMode: "json_object" as const } : {}),
  });

  return augmentModel(adapter, [
    withRetry({
      maxAttempts: env.OPENAI_RETRY_MAX_ATTEMPTS,
    }),
  ]);
}

export function getReviewEndpointFromEnv(): string {
  return normalizeReviewTracesEndpoint(env.REJELLY_REVIEW_ENDPOINT);
}

export function resolveReviewOptions(
  enableReviewOption: boolean | ReviewOptions | undefined,
): ReviewOptions | null {
  if (!enableReviewOption) {
    return null;
  }
  if (enableReviewOption === true) {
    return {
      endpoint: getReviewEndpointFromEnv(),
    };
  }
  return {
    ...enableReviewOption,
    endpoint: normalizeReviewTracesEndpoint(
      enableReviewOption.endpoint ?? env.REJELLY_REVIEW_ENDPOINT,
    ),
  };
}
