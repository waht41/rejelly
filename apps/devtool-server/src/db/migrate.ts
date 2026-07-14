/**
 * Database Migration Script
 *
 * Applies Drizzle-generated SQLite migrations.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { ensureDbDirectory, getAbsoluteDbPath } from "../config";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getMigrationsFolder(): string {
  const migrationsFolder = join(__dirname, "migrations");
  if (!existsSync(migrationsFolder)) {
    throw new Error(`Database migrations folder not found: ${migrationsFolder}`);
  }
  return migrationsFolder;
}

/**
 * Run database migrations
 */
export function runMigrations(): void {
  ensureDbDirectory();
  const sqlite = new Database(getAbsoluteDbPath());
  try {
    sqlite.pragma("journal_mode = WAL");
    migrate(drizzle(sqlite), { migrationsFolder: getMigrationsFolder() });
  } finally {
    sqlite.close();
  }
}

// Auto-run migrations if this file is executed directly
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigrations();
}
