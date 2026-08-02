import type { ExtensionLoadDiagnostic } from "./contracts";
import { loadPluginManifest, type PluginDescriptor } from "./manifest";
import type { PluginSourceCandidate } from "./sourceRoots";

export interface DiscoveredPluginCatalog {
  readonly plugins: readonly PluginDescriptor[];
  readonly diagnostics: readonly ExtensionLoadDiagnostic[];
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePluginSources(left: PluginSourceCandidate, right: PluginSourceCandidate): number {
  if (left.scope !== right.scope) {
    return left.scope === "user" ? -1 : 1;
  }
  return (
    compareCodeUnits(left.directoryName, right.directoryName) ||
    compareCodeUnits(left.directoryPath, right.directoryPath)
  );
}

function duplicateIdDiagnostic(plugin: PluginDescriptor): ExtensionLoadDiagnostic {
  return {
    severity: "warning",
    code: "plugin.id.duplicate",
    message:
      `Plugin id ${plugin.id} is declared by multiple roots; ` +
      "every conflicting copy was skipped.",
    source: plugin.source.manifestPath,
  };
}

/**
 * Report contribution kinds this host cannot consume.
 *
 * The raw value stays in the descriptor so a forward-compatible manifest survives a round trip,
 * but the plugin must be reported as only partially loaded rather than silently accepted.
 */
function unsupportedKindDiagnostics(
  plugin: PluginDescriptor,
  knownContributionKinds: ReadonlySet<string>,
): ExtensionLoadDiagnostic[] {
  return Object.keys(plugin.manifest.contributions)
    .filter((kind) => !knownContributionKinds.has(kind))
    .sort(compareCodeUnits)
    .map((kind) => ({
      severity: "warning" as const,
      code: "plugin.contribution.unsupported" as const,
      message:
        `Plugin ${plugin.id} declares contribution kind ${JSON.stringify(kind)}, which this ` +
        "version cannot consume; the plugin was loaded without it.",
      source: plugin.source.manifestPath,
    }));
}

/**
 * Load formal manifests and reject duplicate identities before any consumer runs.
 *
 * `knownContributionKinds` is supplied by the composition root because only it knows which
 * consumers exist. This module dispatches contributions; it never interprets their contents.
 */
export async function loadPluginCatalog(
  sources: readonly PluginSourceCandidate[],
  knownContributionKinds: readonly string[],
): Promise<DiscoveredPluginCatalog> {
  const diagnostics: ExtensionLoadDiagnostic[] = [];
  const loadedPlugins: PluginDescriptor[] = [];
  for (const source of [...sources].sort(comparePluginSources)) {
    try {
      const loaded = await loadPluginManifest(source);
      diagnostics.push(...loaded.diagnostics);
      if (loaded.ok) {
        loadedPlugins.push(loaded.plugin);
      }
    } catch (error: unknown) {
      diagnostics.push({
        severity: "warning",
        code: "plugin.manifest.invalid",
        message:
          "Plugin manifest loader failed and the plugin was skipped: " +
          (error instanceof Error ? error.message : String(error)),
        source: source.manifestPath,
      });
    }
  }

  const byId = new Map<string, PluginDescriptor[]>();
  for (const plugin of loadedPlugins) {
    const group = byId.get(plugin.id) ?? [];
    group.push(plugin);
    byId.set(plugin.id, group);
  }
  const knownKinds = new Set(knownContributionKinds);
  const plugins: PluginDescriptor[] = [];
  for (const pluginId of [...byId.keys()].sort(compareCodeUnits)) {
    const group = byId.get(pluginId)!;
    if (group.length === 1) {
      const plugin = group[0]!;
      plugins.push(plugin);
      diagnostics.push(...unsupportedKindDiagnostics(plugin, knownKinds));
    } else {
      diagnostics.push(...group.map(duplicateIdDiagnostic));
    }
  }

  return Object.freeze({
    plugins: Object.freeze(plugins),
    diagnostics: Object.freeze(diagnostics),
  });
}
