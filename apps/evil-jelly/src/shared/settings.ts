/**
 * Unified runtime settings: the single resolution point for repo-fact configuration.
 * Document-domain repo facts (sync glob pairs + per-doc mappings) live in doc-map.jsonc
 * at its fixed default path; only the CLI `--doc-map` flag relocates it per run.
 *
 * Precedence: CLI flag > workspace `.evil-jelly/settings.jsonc` > built-in default.
 * Env vars are deliberately NOT a layer here — secrets and machine facts (API keys,
 * proxies, endpoints) stay in `.env` (see config.ts), repo facts live in the settings
 * file so they are shared via git, and per-run intent comes from CLI flags.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getWorkspaceFsPolicy } from "./fs-policy/workspace-fs-policy";
import { parseAndValidateJsonc } from "./lib/jsonc";

export const SETTINGS_FILE_REL_PATH = ".evil-jelly/settings.jsonc";
export const DOC_MAP_DEFAULT_PATH = ".evil-jelly/doc-map.jsonc";

const SettingsFileSchema = z
  .object({
    audit: z
      .object({
        /** Per-seed evaluator fan-out concurrency for `evil audit`. */
        concurrency: z.number().int().positive().optional(),
        /** Max candidate seeds per family to send to the LLM evaluator. */
        maxSeeds: z.number().int().positive().optional(),
        /** Delete same-family ledger entries not seen for this many days. */
        ledgerGcDays: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type EvilJellySettingsFile = z.infer<typeof SettingsFileSchema>;

/**
 * CLI overrides (highest precedence). `devtoolMcp` is CLI-only on purpose: connecting
 * the devtool MCP toolset is a per-run capability toggle, not a repo fact, so it has
 * no settings-file counterpart.
 */
export interface SettingsCliOverrides {
  docMap?: string;
  devtoolMcp?: boolean;
  auditMaxSeeds?: number;
  auditLedgerGcDays?: number;
  auditDisableLedgerGc?: boolean;
}

export interface ResolvedSettings {
  /** Workspace-relative doc map path (doc-drift validation); CLI --doc-map or the default. */
  docMap: string;
  /** undefined → the audit feature's own default applies (AUDIT_DEFAULTS.concurrency). */
  audit: {
    concurrency: number | undefined;
    maxSeeds: number | undefined;
    ledgerGcDays: number | undefined;
    disableLedgerGc: boolean;
  };
  /** Whether to connect the devtool MCP toolset this run. */
  devtoolMcp: boolean;
}

let cliOverrides: SettingsCliOverrides = {};
let cache: { root: string; resolved: ResolvedSettings } | undefined;

/**
 * Seed CLI overrides at the composition root (after the workspace root is bound).
 * Also resets the resolution cache, so tests can re-init between cases.
 */
export function initSettings(overrides: SettingsCliOverrides): void {
  cliOverrides = overrides;
  cache = undefined;
}

function readSettingsFile(root: string): EvilJellySettingsFile {
  const filePath = path.join(root, SETTINGS_FILE_REL_PATH);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return {};
  }
  return parseAndValidateJsonc(raw, "Settings", filePath, SettingsFileSchema);
}

/**
 * Resolve settings for the current workspace root (cached per root; a missing file
 * yields defaults, a malformed file throws loudly — fix it, don't skip it).
 */
export function getSettings(): ResolvedSettings {
  const root = getWorkspaceFsPolicy().getRoot();
  if (cache?.root === root) {
    return cache.resolved;
  }
  const file = readSettingsFile(root);
  const resolved: ResolvedSettings = {
    docMap: cliOverrides.docMap ?? DOC_MAP_DEFAULT_PATH,
    audit: {
      concurrency: file.audit?.concurrency,
      maxSeeds: cliOverrides.auditMaxSeeds ?? file.audit?.maxSeeds,
      ledgerGcDays: cliOverrides.auditLedgerGcDays ?? file.audit?.ledgerGcDays,
      disableLedgerGc: cliOverrides.auditDisableLedgerGc ?? false,
    },
    devtoolMcp: cliOverrides.devtoolMcp ?? false,
  };
  cache = { root, resolved };
  return resolved;
}
