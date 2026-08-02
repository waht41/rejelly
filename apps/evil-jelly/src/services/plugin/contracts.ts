import { EXTENSION_LIMITS } from "../../shared/extensionLimits";

/**
 * App-local plugin envelope and provenance contracts.
 *
 * A plugin is distribution metadata, not a runtime superclass. These contracts deliberately
 * contain no permissions, lifecycle hooks, filesystem handles, or agent/equip dependencies.
 */

export const PLUGIN_MANIFEST_VERSION = 1 as const;
/** The only supported manifest filename. Its contents use JSONC syntax. */
export const PLUGIN_MANIFEST_FILE_NAME = "plugin.jsonc" as const;
/** Detected only to produce a migration diagnostic; never parsed as a manifest. */
export const UNSUPPORTED_PLUGIN_MANIFEST_FILE_NAME = "plugin.json" as const;

export type PluginIdValidationResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly value: string; readonly reason: string };

const PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/** Trim and validate a stable, dot-segmented formal plugin id. */
export function validatePluginId(input: string): PluginIdValidationResult {
  const value = input.trim();
  if (value.length === 0) {
    return { ok: false, value, reason: "Plugin id must not be empty." };
  }
  if (value.length > EXTENSION_LIMITS.pluginIdChars) {
    return {
      ok: false,
      value,
      reason: `Plugin id must be at most ${EXTENSION_LIMITS.pluginIdChars} characters.`,
    };
  }
  if (!PLUGIN_ID_PATTERN.test(value)) {
    return {
      ok: false,
      value,
      reason:
        "Plugin id must contain lowercase ASCII dot-separated segments; each segment may contain internal hyphens.",
    };
  }
  return { ok: true, value };
}

/** One independently-versioned contribution block inside a plugin manifest. */
export interface VersionedContribution<TSpec> {
  readonly apiVersion: number;
  readonly spec: TSpec;
}

/** The v1 manifest envelope. Known contribution blocks are validated by their own consumers. */
export interface PluginManifestV1 {
  readonly manifestVersion: typeof PLUGIN_MANIFEST_VERSION;
  readonly id: string;
  readonly contributions: Readonly<Record<string, unknown>>;
}

/** Stable origin for a contribution declared by a formal plugin. */
export interface PluginContributionProvenance {
  readonly kind: "plugin";
  readonly pluginId: string;
  readonly contributionKind: string;
  readonly contributionId: string;
}

/** Stable-enough origin for a bare contribution directory without a plugin manifest. */
export interface LooseContributionProvenance {
  readonly kind: "loose";
  readonly scope: "user" | "project";
  /** Opaque id derived by the source resolver; never expose its backing absolute path. */
  readonly sourceId: string;
  readonly contributionKind: string;
  readonly contributionId: string;
}

/** Immutable origin identity carried from discovery through catalog and tool results. */
export type ContributionProvenance = PluginContributionProvenance | LooseContributionProvenance;

/** Return the namespace used to qualify contribution-local names. */
export function contributionOwnerId(provenance: ContributionProvenance): string {
  return provenance.kind === "plugin" ? provenance.pluginId : provenance.sourceId;
}

/** Build the globally unambiguous name of a contribution. */
export function qualifiedContributionName(provenance: ContributionProvenance): string {
  return `${contributionOwnerId(provenance)}:${provenance.contributionId}`;
}

export type ExtensionLoadDiagnosticSeverity = "warning" | "error";

/** Stable machine-readable codes for non-fatal extension loading failures. */
export type ExtensionLoadDiagnosticCode =
  | "plugin.source.missing"
  | "plugin.source.duplicate"
  | "plugin.source.escape"
  | "plugin.source.invalid"
  | "plugin.manifest.invalid-jsonc"
  | "plugin.manifest.invalid"
  | "plugin.manifest.unsupported-filename"
  | "plugin.manifest.unsupported-version"
  | "plugin.id.mismatch"
  | "plugin.id.duplicate"
  | "plugin.contribution.invalid"
  | "plugin.contribution.unsupported"
  | "skill.frontmatter.invalid"
  | "skill.invalid"
  | "skill.duplicate"
  | "skill.limit-exceeded"
  | "skill.resource.escape"
  | "skill.resource.invalid";

/**
 * A bounded, non-fatal problem discovered while loading extensions.
 *
 * Diagnostics are emitted by the composition root, never injected into model conversation
 * history. `source` is host-facing diagnostic context and may contain a local path.
 */
export interface ExtensionLoadDiagnostic {
  readonly severity: ExtensionLoadDiagnosticSeverity;
  readonly code: ExtensionLoadDiagnosticCode;
  readonly message: string;
  readonly source?: string;
  readonly provenance?: ContributionProvenance;
}
