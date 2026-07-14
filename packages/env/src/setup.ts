/**
 * Side-effect entry: load .env (cwd + workspace root) and configure the HTTP
 * proxy when USE_PROXY is set. Intended for `--import @rejelly/env/setup` so
 * env is ready before the app entry runs, without importing this package in
 * source. Dev-only: loadEnv is a no-op under NODE_ENV=production.
 */

import { loadEnv, setupProxy } from "./index.js";

loadEnv();
setupProxy();
