/**
 * Side-effect entry, drop-in replacement for `import "dotenv/config"`:
 * loads cwd .env plus workspace-root .env (dev only).
 */

import { loadEnv } from "./index.js";

loadEnv();
