/**
 * Initialize database schema.
 *
 * Kept as the stable startup/test entry point; the actual DDL lives in
 * Drizzle-generated migration SQL under ./migrations.
 */

import { runMigrations } from "./migrate";

export function initSchema(): void {
  runMigrations();
}
