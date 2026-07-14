import * as os from "node:os";
import * as path from "node:path";
import { defineConfig } from "vitest/config";

// Each run gets its own on-disk SQLite file. The repo binds a module-singleton
// connection at import time (db/drizzle.ts) and initSchema opens a second one,
// so a shared on-disk file is the simplest way to give both the same database
// without leaking into the real ./.rejelly/devtool.sqlite3.
const TEST_DB_PATH = path.join(os.tmpdir(), `rejelly-devtool-test-${process.pid}-${Date.now()}.db`);

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/__tests__/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    // Inject the DB path before any module reads config/index.ts at import time.
    env: { REJELLY_DEVTOOL_DB_PATH: TEST_DB_PATH },
    // The SQLite connection is a shared module singleton — keep one worker.
    pool: "forks",
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
