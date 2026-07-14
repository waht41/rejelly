/**
 * Dev-only env loading for the rejelly monorepo.
 *
 * Policy (deliberately boring for deployment safety):
 * - `loadEnv` is a no-op when NODE_ENV=production — production config must come
 *   from the platform environment (container env / secrets), never from files.
 * - The workspace-root lookup is bounded: it walks up looking for
 *   pnpm-workspace.yaml and stops at the first `.git` boundary, so it never
 *   probes above the repo checkout. Outside the monorepo it finds nothing.
 * - dotenv never overrides vars already present in process.env, so
 *   platform-injected env always wins over any .env file.
 */

import fs from "node:fs";
import path from "node:path";
import { config } from "dotenv";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

const ENV_LOG_ONCE = Symbol.for("rejelly.env.loadLogged");
const PROXY_ONCE = Symbol.for("rejelly.env.proxyConfigured");

type OnceFlags = typeof globalThis & Record<symbol, boolean | undefined>;

/** Walk up from startDir to find the pnpm workspace root; stops at the `.git` boundary. */
export function findWorkspaceRoot(startDir: string = process.cwd()): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    if (fs.existsSync(path.join(dir, ".git"))) {
      return undefined;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * Load `.env` from `dir` (default cwd), then from the workspace root as fallback.
 * Earlier files win for duplicate keys; existing process.env vars are never overridden.
 * Returns the list of files actually loaded.
 */
export function loadEnv(options: { dir?: string } = {}): string[] {
  if (process.env.NODE_ENV === "production") {
    return [];
  }

  const dir = path.resolve(options.dir ?? process.cwd());
  const candidates = [path.join(dir, ".env")];
  const root = findWorkspaceRoot(dir);
  if (root && root !== dir) {
    candidates.push(path.join(root, ".env"));
  }

  const found = candidates.filter((p) => fs.existsSync(p));
  if (found.length > 0) {
    config({ path: found });
    const flags = globalThis as OnceFlags;
    if (!flags[ENV_LOG_ONCE]) {
      flags[ENV_LOG_ONCE] = true;
      console.log(`[rejelly-env] loaded: ${found.join(", ")}`);
    }
  }
  return found;
}

/**
 * Configure undici global dispatcher with an HTTP proxy when USE_PROXY is set.
 * Call after loadEnv so USE_PROXY / PROXY_URL from .env are visible. Idempotent (HMR-safe).
 * Keep proxy behavior in sync with apps/evil-jelly/src/shared/config.ts, which copies this
 * setup without sharing this dev-only env loader's .env semantics.
 */
export function setupProxy(): void {
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

  // 1. Set proxy env vars (EnvHttpProxyAgent reads these)
  process.env.HTTP_PROXY = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;

  // 2. Configure NO_PROXY so local traffic is bypassed
  process.env.NO_PROXY = "localhost,127.0.0.1,::1";

  // 3. EnvHttpProxyAgent respects NO_PROXY automatically
  setGlobalDispatcher(new EnvHttpProxyAgent());

  console.log(`[rejelly-env] Proxy configured: ${proxyUrl} (Bypassing local traffic)`);
}
