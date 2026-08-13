import path from "node:path";
import type { SettingsCliOverrides } from "../../shared/configuration/settings";

export interface CommonParsedArgs {
  /** OPENAI_API_KEY override from CLI; highest priority. */
  cliApiKey: string | undefined;
  /** `--env` profile name or path: one file per endpoint identity, outranking the shell. */
  envFile: string | undefined;
  review: boolean;
  /** Resolved absolute path when --workspace is set (agent workspace fs policy root). */
  workspace: string | undefined;
  /** Per-invocation settings overrides (seeded into initSettings at the composition root). */
  settings: SettingsCliOverrides;
}

export function failArgs(message: string): never {
  console.error(message);
  process.exit(1);
}

export function resolveOptionalPath(raw: unknown, baseDir = process.cwd()): string | undefined {
  if (raw === undefined || raw === null || String(raw).trim().length === 0) {
    return undefined;
  }
  return path.resolve(baseDir, String(raw).trim());
}

export function resolveOptionalString(raw: unknown, trim = true): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const value = trim ? String(raw).trim() : String(raw);
  return value.length > 0 ? value : undefined;
}
