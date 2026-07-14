/**
 * Drizzle ORM Database Connection (opened lazily).
 *
 * The SQLite connection is created on the first property access of `db`, not at
 * import time. That way the resolved db path (REJELLY_DEVTOOL_DB_PATH / --db) is
 * read only once the entry has finished writing it — no import-order coupling —
 * and merely importing this module (e.g. for `--help`) never touches the disk.
 */

import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { ensureDbDirectory, getAbsoluteDbPath } from "../config";
import * as schema from "./schema";

type DevtoolDb = BetterSQLite3Database<typeof schema>;

let instance: DevtoolDb | undefined;

function connection(): DevtoolDb {
  if (!instance) {
    ensureDbDirectory();
    const sqlite = new Database(getAbsoluteDbPath());
    // Enable WAL mode for concurrent read/write performance
    sqlite.pragma("journal_mode = WAL");
    instance = drizzle(sqlite, { schema });
  }
  return instance;
}

// Lazy proxy: every access resolves (opening it on first use) the real
// connection. Methods are bound to the real instance so drizzle's internal
// private fields keep working when called through the proxy.
export const db: DevtoolDb = new Proxy({} as DevtoolDb, {
  get(_target, prop) {
    const real = connection();
    const value = Reflect.get(real, prop, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
});

// Export schema for use in repositories
export { schema };
