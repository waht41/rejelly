/**
 * Env loading and Review exporter option resolution.
 */

import fs from "node:fs";
import path from "node:path";
import type { ReviewOptions } from "@rejelly/core/debugger";
import { parse as parseEnv } from "dotenv";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { getWorkspaceFsPolicy } from "../fs-policy/workspace-fs-policy";
import { resolveGlobalJellyDir } from "../globalPath";
import {
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL_ID,
  MIN_OPENAI_CONTEXT_WINDOW_TOKENS,
} from "./modelDefaults";

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
 * domains/web/webConfig.ts) and OS conventions read at spawn time (SHELL/ComSpec,
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
  /** Thinking budget for reasoning models (e.g. DeepSeek `max`); unset sends nothing. */
  OPENAI_REASONING_EFFORT: str(),
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

/** Read values already persisted in an env file; a missing file reads as empty. */
export function readEnvValues(filePath: string): Record<string, string> {
  return readEnvFile(filePath);
}

/** Read values already persisted by `evil init`. */
export function readGlobalEnvValues(): Record<string, string> {
  return readEnvValues(resolveGlobalEnvPath());
}

/**
 * Resolve `--env <name|path>`. A bare name (no separator, no `.env` suffix) is a profile
 * beside the global file, `~/.evil-jelly/<name>.env`; anything else is a filesystem path.
 * Naming a profile is the expected use — one file per endpoint identity, so key, model,
 * proxy, and web-search substrate switch together and can never be half-applied. The default
 * `.env` sits in the same directory on purpose: it is the identity used when none is named.
 */
export function resolveEnvProfilePath(nameOrPath: string): string {
  const raw = nameOrPath.trim();
  if (!/[\\/]/.test(raw) && !raw.endsWith(".env")) {
    return path.join(resolveGlobalJellyDir(), `${raw}.env`);
  }
  return path.resolve(raw);
}

/**
 * Profile names available to `--env`, for error messages and future pickers. `.env` is the
 * unnamed default rather than a profile, so it is excluded — otherwise it would list as one
 * with an empty name.
 */
export function listEnvProfileNames(): string[] {
  const dir = resolveGlobalJellyDir();
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name !== ".env" && name.endsWith(".env"))
    .map((name) => name.slice(0, -".env".length))
    .sort();
}

function quoteEnvValue(raw: string): string {
  if (!/[\s#"'\\]/.test(raw)) {
    return raw;
  }
  const escaped = raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** Merge values into an env file (existing keys are kept unless overwritten). */
export function saveEnvValues(filePath: string, values: Record<string, string>): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const trimmed = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, value.trim()]),
  );
  const next = { ...readEnvFile(filePath), ...trimmed };
  const lines = Object.entries(next).map(([key, value]) => `${key}=${quoteEnvValue(value)}`);
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");
  return filePath;
}

/** Merge values into ~/.evil-jelly/.env. */
export function saveGlobalEnvValues(values: Record<string, string>): string {
  return saveEnvValues(resolveGlobalEnvPath(), values);
}

/** Workspace-local Evil Jelly env file; keep secrets and machine-specific values out of git. */
export const WORKSPACE_ENV_REL_PATH = ".evil-jelly/.env";

type EnvLayer = "cli" | "envFile" | "shell" | "workspace" | "global";

const ENV_LAYER_LABELS: Record<EnvLayer, string> = {
  cli: "--api-key",
  envFile: "--env",
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

/** Read a `--env` profile, failing loudly instead of silently running the default identity. */
function readEnvProfile(filePath: string, requested: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    const names = listEnvProfileNames();
    throw new Error(
      `--env ${requested}: no env file at ${filePath}.` +
        (names.length > 0
          ? ` Known profiles: ${names.join(", ")}.`
          : ` Create one there, or pass a path.`),
    );
  }
  return readEnvFile(filePath);
}

/**
 * A profile that redirects the endpoint must carry its own key. Vars absent from the profile
 * fall through to the layers below — deliberate, so shared knobs (timeouts, review, audit)
 * stay in one place — but for the routing vars that fall-through means sending the previous
 * provider's key to a new endpoint. Cheap to get wrong and impossible to take back, so this
 * one aborts where the workspace equivalent only warns.
 */
function assertSelfContainedRouting(values: Record<string, string>, filePath: string): void {
  const routing = KEY_ROUTING_VARS.filter((name) => hasEnvValue(values[name]));
  if (routing.length === 0 || hasEnvValue(values.OPENAI_API_KEY)) {
    return;
  }
  throw new Error(
    `${filePath} sets ${routing.join(" and ")} without OPENAI_API_KEY. An env profile that ` +
      `redirects the endpoint must carry its own key, otherwise the key from a lower layer ` +
      `is sent to it. Add OPENAI_API_KEY to the profile.`,
  );
}

/**
 * Load env with cascading priority (closest to the invocation wins):
 * CLI --api-key > --env <profile> > process.env (shell) > workspace .evil-jelly/.env >
 * ~/.evil-jelly/.env.
 *
 * `--env` outranks the shell on purpose, unlike the other file layers: it is per-run intent,
 * not a machine fact, and a profile silently losing its model id to an exported OPENAI_MODEL_ID
 * is the exact failure the flag exists to prevent. Vars it does not set still fall through.
 *
 * The workspace's plain `.env` is deliberately NOT read: it belongs to the app under
 * development (tests/examples), not to evil the tool. Evil-specific values live in the tool's
 * own `.evil-jelly/.env` namespace; non-secret preferences use settings.jsonc files.
 */
export function loadEvilJellyEnv(options?: {
  cliApiKey?: string | undefined;
  envFile?: string | undefined;
}): void {
  const sources = new Map<string, EnvLayer>();
  for (const varName of ["OPENAI_API_KEY", ...KEY_ROUTING_VARS]) {
    if (hasEnvValue(process.env[varName])) {
      sources.set(varName, "shell");
    }
  }

  const requestedProfile = options?.envFile?.trim();
  if (hasEnvValue(requestedProfile)) {
    const profilePath = resolveEnvProfilePath(requestedProfile);
    const values = readEnvProfile(profilePath, requestedProfile);
    assertSelfContainedRouting(values, profilePath);
    for (const [key, value] of Object.entries(values)) {
      if (hasEnvValue(value)) {
        process.env[key] = value;
        sources.set(key, "envFile");
      }
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
