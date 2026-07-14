// Copies runtime assets into devtool-server/dist after tsup has cleaned and
// rebuilt it. The UI builds into its own package dist; migrations are generated
// from schema.ts and must be present beside the bundled server at runtime.
import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = join(__dirname, "..", "..", "devtool-ui", "dist");
const dest = join(__dirname, "..", "dist", "public");

if (!existsSync(src)) {
  console.error(`[copy-assets] UI build not found at ${src}. Build @rejelly/devtool-ui first.`);
  process.exit(1);
}

cpSync(src, dest, { recursive: true });
console.log(`[copy-assets] Copied UI assets -> ${dest}`);

const migrationsSrc = join(__dirname, "..", "src", "db", "migrations");
const migrationsDest = join(__dirname, "..", "dist", "migrations");

if (!existsSync(migrationsSrc)) {
  console.error(
    `[copy-assets] Database migrations not found at ${migrationsSrc}. Run db:generate first.`,
  );
  process.exit(1);
}

cpSync(migrationsSrc, migrationsDest, { recursive: true });
console.log(`[copy-assets] Copied database migrations -> ${migrationsDest}`);
