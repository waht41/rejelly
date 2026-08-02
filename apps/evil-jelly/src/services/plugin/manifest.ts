import fs from "node:fs/promises";
import { type Node as JsonNode, parseTree } from "jsonc-parser";
import { z } from "zod";
import { EXTENSION_LIMITS } from "../../shared/extensionLimits";
import { parseJsonc } from "../../shared/lib/jsonc";
import {
  type ExtensionLoadDiagnostic,
  PLUGIN_MANIFEST_FILE_NAME,
  PLUGIN_MANIFEST_VERSION,
  type PluginManifestV1,
  validatePluginId,
} from "./contracts";
import { resolveContainedPath } from "./pathBoundary";
import type { PluginSourceCandidate } from "./sourceRoots";

const manifestEnvelopeSchema = z
  .object({
    manifestVersion: z.number().int(),
    id: z.string(),
    contributions: z.record(z.string(), z.unknown()),
  })
  .passthrough();

/** Host-only validated plugin descriptor. Paths never enter model-facing records. */
export interface PluginDescriptor {
  readonly id: string;
  readonly source: PluginSourceCandidate;
  readonly manifest: PluginManifestV1;
}

export type PluginManifestLoadResult =
  | {
      readonly ok: true;
      readonly plugin: PluginDescriptor;
      readonly diagnostics: readonly ExtensionLoadDiagnostic[];
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly ExtensionLoadDiagnostic[];
    };

function diagnostic(
  code: ExtensionLoadDiagnostic["code"],
  message: string,
  source: string,
): ExtensionLoadDiagnostic {
  return { severity: "warning", code, message, source };
}

function invalidManifest(
  source: PluginSourceCandidate,
  code: "plugin.manifest.invalid-jsonc" | "plugin.manifest.invalid",
  message: string,
): PluginManifestLoadResult {
  return {
    ok: false,
    diagnostics: Object.freeze([diagnostic(code, message, source.manifestPath)]),
  };
}

function jsonDepth(value: unknown): number {
  let maximum = 0;
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.value === null || typeof current.value !== "object") {
      continue;
    }
    const depth = current.depth + 1;
    maximum = Math.max(maximum, depth);
    if (maximum > EXTENSION_LIMITS.pluginManifestDepth) {
      return maximum;
    }
    const children = Array.isArray(current.value) ? current.value : Object.values(current.value);
    for (const child of children) {
      stack.push({ value: child, depth });
    }
  }
  return maximum;
}

function findDuplicateJsonKey(node: JsonNode | undefined): string | undefined {
  if (!node) {
    return undefined;
  }
  if (node.type === "object") {
    const keys = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value;
      if (typeof key === "string") {
        if (keys.has(key)) {
          return key;
        }
        keys.add(key);
      }
      const nested = findDuplicateJsonKey(property.children?.[1]);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  }
  for (const child of node.children ?? []) {
    const nested = findDuplicateJsonKey(child);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function deepFreezeJson(value: unknown): unknown {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      deepFreezeJson(child);
    }
    Object.freeze(value);
  }
  return value;
}

/** Read and validate only the plugin envelope; contribution values remain opaque. */
export async function loadPluginManifest(
  source: PluginSourceCandidate,
): Promise<PluginManifestLoadResult> {
  const containedManifest = await resolveContainedPath(
    source.directoryPath,
    PLUGIN_MANIFEST_FILE_NAME,
    "file",
  );
  if (!containedManifest.ok) {
    return invalidManifest(
      source,
      "plugin.manifest.invalid",
      `Plugin manifest failed its path boundary: ${containedManifest.message}`,
    );
  }

  let buffer: Buffer;
  try {
    const stat = await fs.stat(containedManifest.realPath);
    if (stat.size > EXTENSION_LIMITS.pluginManifestBytes) {
      return invalidManifest(
        source,
        "plugin.manifest.invalid",
        `Plugin manifest exceeds ${EXTENSION_LIMITS.pluginManifestBytes} bytes.`,
      );
    }
    buffer = await fs.readFile(containedManifest.realPath);
  } catch (error: unknown) {
    return invalidManifest(
      source,
      "plugin.manifest.invalid",
      `Plugin manifest could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (buffer.byteLength > EXTENSION_LIMITS.pluginManifestBytes) {
    return invalidManifest(
      source,
      "plugin.manifest.invalid",
      `Plugin manifest exceeds ${EXTENSION_LIMITS.pluginManifestBytes} bytes.`,
    );
  }

  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return invalidManifest(source, "plugin.manifest.invalid-jsonc", "Manifest is not valid UTF-8.");
  }

  let parsedJson: unknown;
  try {
    parsedJson = parseJsonc(raw);
  } catch (error: unknown) {
    return invalidManifest(
      source,
      "plugin.manifest.invalid-jsonc",
      `Manifest is not valid JSONC: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Depth is bounded before the recursive duplicate-key walk. jsonDepth is iterative, so the
  // cheap check runs first and deep-but-parseable manifests never reach a recursive stage.
  if (jsonDepth(parsedJson) > EXTENSION_LIMITS.pluginManifestDepth) {
    return invalidManifest(
      source,
      "plugin.manifest.invalid",
      `Manifest object depth exceeds ${EXTENSION_LIMITS.pluginManifestDepth}.`,
    );
  }
  const duplicateKey = findDuplicateJsonKey(
    parseTree(raw, [], { allowTrailingComma: true, disallowComments: false }),
  );
  if (duplicateKey) {
    return invalidManifest(
      source,
      "plugin.manifest.invalid-jsonc",
      `Manifest contains duplicate key ${JSON.stringify(duplicateKey)}.`,
    );
  }

  const envelope = manifestEnvelopeSchema.safeParse(parsedJson);
  if (!envelope.success) {
    return invalidManifest(
      source,
      "plugin.manifest.invalid",
      `Manifest envelope failed validation: ${envelope.error.message}`,
    );
  }
  if (envelope.data.manifestVersion !== PLUGIN_MANIFEST_VERSION) {
    return {
      ok: false,
      diagnostics: Object.freeze([
        diagnostic(
          "plugin.manifest.unsupported-version",
          `Unsupported manifestVersion ${envelope.data.manifestVersion}; expected ${PLUGIN_MANIFEST_VERSION}.`,
          source.manifestPath,
        ),
      ]),
    };
  }
  const pluginId = validatePluginId(envelope.data.id);
  if (!pluginId.ok) {
    return invalidManifest(source, "plugin.manifest.invalid", pluginId.reason);
  }

  const contributionEntries = Object.entries(envelope.data.contributions);
  if (contributionEntries.length > EXTENSION_LIMITS.contributionKindsPerPlugin) {
    return invalidManifest(
      source,
      "plugin.manifest.invalid",
      `Manifest declares more than ${EXTENSION_LIMITS.contributionKindsPerPlugin} contribution kinds.`,
    );
  }

  const contributions = envelope.data.contributions;
  deepFreezeJson(contributions);
  const manifest: PluginManifestV1 = Object.freeze({
    manifestVersion: PLUGIN_MANIFEST_VERSION,
    id: pluginId.value,
    contributions,
  });
  const plugin: PluginDescriptor = Object.freeze({
    id: pluginId.value,
    source,
    manifest,
  });
  return Object.freeze({
    ok: true,
    plugin,
    diagnostics: Object.freeze([]),
  });
}
