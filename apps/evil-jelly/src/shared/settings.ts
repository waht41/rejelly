/**
 * Unified runtime settings: the single resolution point for non-secret configuration.
 * Document-domain repo facts (sync glob pairs + per-doc mappings) live in doc-map.jsonc
 * at its fixed default path; only the CLI `--doc-map` flag relocates it per run.
 *
 * Precedence: CLI flag > workspace `.evil-jelly/settings.jsonc` > user
 * `~/.evil-jelly/settings.jsonc` > built-in default. Fields are resolved explicitly rather
 * than through a generic deep merge so a feature can define safer composition rules when needed.
 * Env vars are deliberately NOT a layer here — secrets and machine facts (API keys,
 * proxies, endpoints) stay in `.env` (see config.ts), non-secret preferences live in settings
 * files, repository facts live in domain files, and per-run intent comes from CLI flags.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getErrnoCode } from "./foundation/errno";
import { parseAndValidateJsonc } from "./foundation/jsonc";
import { getWorkspaceFsPolicy } from "./fs-policy/workspace-fs-policy";
import { resolveGlobalJellyDir } from "./globalPath";

export const SETTINGS_FILE_REL_PATH = ".evil-jelly/settings.jsonc";
export const DOC_MAP_DEFAULT_PATH = ".evil-jelly/doc-map.jsonc";

/** User-level, non-secret settings shared by all workspaces. */
export function resolveUserSettingsPath(): string {
  return path.join(resolveGlobalJellyDir(), "settings.jsonc");
}

const QualifiedSkillNameSchema = z
  .string()
  .regex(
    /^(user|project):[a-z0-9][a-z0-9._-]{0,63}$/,
    "Expected a qualified Skill name such as user:review or project:review.",
  );

const SkillOverrideSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

const SkillsSettingsSchema = z
  .object({
    /** Master switch for all local Skills. */
    enabled: z.boolean().optional(),
    /** Per-qualified-name enablement; workspace entries replace matching user defaults. */
    overrides: z.record(QualifiedSkillNameSchema, SkillOverrideSchema).optional(),
  })
  .strict();

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
    skills: SkillsSettingsSchema.optional(),
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
  /** Local Skill availability after user/workspace settings precedence is applied. */
  skills: {
    enabled: boolean;
    overrides: Readonly<Record<string, { readonly enabled: boolean }>>;
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

function readSettingsFile(filePath: string): EvilJellySettingsFile {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (error: unknown) {
    if (getErrnoCode(error) === "ENOENT") {
      return {};
    }
    throw new Error(
      `Settings ${filePath} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseAndValidateJsonc(raw, "Settings", filePath, SettingsFileSchema);
}

/**
 * Resolve settings for the current user and workspace (cached per workspace root; missing files
 * yield defaults, malformed files throw loudly — fix them, don't skip them).
 */
export function getSettings(): ResolvedSettings {
  const root = getWorkspaceFsPolicy().getRoot();
  if (cache?.root === root) {
    return cache.resolved;
  }
  const userFile = readSettingsFile(resolveUserSettingsPath());
  const workspaceFile = readSettingsFile(path.join(root, SETTINGS_FILE_REL_PATH));
  const resolved: ResolvedSettings = {
    docMap: cliOverrides.docMap ?? DOC_MAP_DEFAULT_PATH,
    audit: {
      concurrency: workspaceFile.audit?.concurrency ?? userFile.audit?.concurrency,
      maxSeeds:
        cliOverrides.auditMaxSeeds ?? workspaceFile.audit?.maxSeeds ?? userFile.audit?.maxSeeds,
      ledgerGcDays:
        cliOverrides.auditLedgerGcDays ??
        workspaceFile.audit?.ledgerGcDays ??
        userFile.audit?.ledgerGcDays,
      disableLedgerGc: cliOverrides.auditDisableLedgerGc ?? false,
    },
    skills: {
      enabled: workspaceFile.skills?.enabled ?? userFile.skills?.enabled ?? true,
      overrides: Object.freeze({
        ...userFile.skills?.overrides,
        ...workspaceFile.skills?.overrides,
      }),
    },
    devtoolMcp: cliOverrides.devtoolMcp ?? false,
  };
  cache = { root, resolved };
  return resolved;
}
