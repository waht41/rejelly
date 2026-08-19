import { z } from "zod";
import {
  fingerprintMcpServerDefinition,
  type McpDesiredConfig,
  type McpDesiredServer,
  type McpServerDefinition,
  type McpValueSource,
  validateUserMcpServerId,
} from "../contracts";

export const MCP_CONFIGURATION_DEFAULTS = Object.freeze({
  startupTimeoutMs: 10_000,
  toolTimeoutMs: 60_000,
  maxConcurrency: 4,
  auditMaxCallsPerSeed: 4,
  auditMaxResultBytesPerSeed: 64 * 1024,
});

const McpUserServerIdSchema = z.string().superRefine((value, ctx) => {
  const result = validateUserMcpServerId(value);
  if (!result.ok) ctx.addIssue({ code: "custom", message: result.reason });
});

const McpValueSourceSchema = z.union([
  z.object({ value: z.string() }).strict(),
  z.object({ fromEnv: z.string().min(1), prefix: z.string().optional() }).strict(),
]);

const McpStdioTransportSettingsSchema = z
  .object({
    type: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string().min(1), McpValueSourceSchema).optional(),
  })
  .strict();

const McpStreamableHttpTransportSettingsSchema = z
  .object({
    type: z.literal("streamableHttp"),
    url: z.string().url(),
    headers: z.record(z.string().min(1), McpValueSourceSchema).optional(),
  })
  .strict();

export const McpServerSettingsSchema = z
  .object({
    transport: z.discriminatedUnion("type", [
      McpStdioTransportSettingsSchema,
      McpStreamableHttpTransportSettingsSchema,
    ]),
    enabled: z.boolean().optional(),
    startupTimeoutMs: z.number().int().positive().optional(),
    toolTimeoutMs: z.number().int().positive().optional(),
    maxConcurrency: z.number().int().positive().optional(),
    tools: z
      .object({
        allow: z.array(z.string().min(1)).optional(),
        deny: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    use: z
      .object({
        chat: z
          .object({
            exposure: z.enum(["off", "explicit", "always"]).optional(),
            required: z.boolean().optional(),
          })
          .strict()
          .optional(),
        audit: z
          .object({
            exposure: z.enum(["off", "always"]).optional(),
            required: z.boolean().optional(),
            allow: z.array(z.string().min(1)).optional(),
            maxCallsPerSeed: z.number().int().positive().optional(),
            maxResultBytesPerSeed: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const McpSettingsFileSchema = z
  .object({
    servers: z.record(McpUserServerIdSchema, McpServerSettingsSchema).optional(),
  })
  .strict();

export type McpServerSettings = z.infer<typeof McpServerSettingsSchema>;
export type McpSettingsFile = z.infer<typeof McpSettingsFileSchema>;

export function defaultMcpServerDefinition(settings: McpServerSettings): McpServerDefinition {
  const transport =
    settings.transport.type === "stdio"
      ? {
          type: "stdio" as const,
          command: settings.transport.command,
          args: settings.transport.args ?? [],
          cwd: settings.transport.cwd ?? ".",
          env: settings.transport.env ?? {},
        }
      : {
          type: "streamableHttp" as const,
          url: settings.transport.url,
          headers: settings.transport.headers ?? {},
        };
  return {
    transport,
    enabled: settings.enabled ?? true,
    startupTimeoutMs: settings.startupTimeoutMs ?? MCP_CONFIGURATION_DEFAULTS.startupTimeoutMs,
    toolTimeoutMs: settings.toolTimeoutMs ?? MCP_CONFIGURATION_DEFAULTS.toolTimeoutMs,
    maxConcurrency: settings.maxConcurrency ?? MCP_CONFIGURATION_DEFAULTS.maxConcurrency,
    tools: {
      ...(settings.tools?.allow === undefined ? {} : { allow: settings.tools.allow }),
      deny: settings.tools?.deny ?? [],
    },
    use: {
      chat: {
        exposure: settings.use?.chat?.exposure ?? "explicit",
        required: settings.use?.chat?.required ?? false,
      },
      audit: {
        exposure: settings.use?.audit?.exposure ?? "off",
        required: settings.use?.audit?.required ?? false,
        allow: settings.use?.audit?.allow ?? [],
        maxCallsPerSeed:
          settings.use?.audit?.maxCallsPerSeed ?? MCP_CONFIGURATION_DEFAULTS.auditMaxCallsPerSeed,
        maxResultBytesPerSeed:
          settings.use?.audit?.maxResultBytesPerSeed ??
          MCP_CONFIGURATION_DEFAULTS.auditMaxResultBytesPerSeed,
      },
    },
  };
}

export interface ResolveMcpConfigurationOptions {
  readonly user?: McpSettingsFile;
  readonly workspace?: McpSettingsFile;
  readonly dynamic?: readonly McpDesiredServer[];
}

export interface McpRawSettingsLayer {
  readonly path: string;
  readonly value: unknown;
}

export interface McpRawSettingsLayers {
  readonly user: McpRawSettingsLayer;
  readonly workspace: McpRawSettingsLayer;
}

function parseMcpSettingsLayer(
  source: "user" | "workspace",
  layer: McpRawSettingsLayer,
): McpSettingsFile {
  const result = McpSettingsFileSchema.safeParse(layer.value ?? {});
  if (!result.success) {
    throw new Error(
      `MCP ${source} settings ${layer.path} failed validation: ${result.error.message}`,
    );
  }
  return result.data;
}

export function resolveMcpSettingsLayers(
  layers: McpRawSettingsLayers,
  dynamic: readonly McpDesiredServer[] = [],
): McpDesiredConfig {
  return resolveMcpDesiredConfig({
    user: parseMcpSettingsLayer("user", layers.user),
    workspace: parseMcpSettingsLayer("workspace", layers.workspace),
    dynamic,
  });
}

/** Same-id servers are replaced as one definition; fields never deep-merge across scopes. */
export function resolveMcpDesiredConfig(options: ResolveMcpConfigurationOptions): McpDesiredConfig {
  const servers = new Map<string, McpDesiredServer>();
  for (const [id, settings] of Object.entries(options.user?.servers ?? {})) {
    servers.set(id, {
      id,
      definition: defaultMcpServerDefinition(settings),
      source: { kind: "user" },
    });
  }
  for (const [id, settings] of Object.entries(options.workspace?.servers ?? {})) {
    servers.set(id, {
      id,
      definition: defaultMcpServerDefinition(settings),
      source: { kind: "workspace" },
    });
  }
  for (const server of options.dynamic ?? []) {
    servers.set(server.id, server);
  }
  return { servers: [...servers.values()].sort((left, right) => left.id.localeCompare(right.id)) };
}

export function createDevtoolMcpDesiredServer(url: string): McpDesiredServer {
  return {
    id: "evil.devtool",
    source: { kind: "dynamic", sourceId: "cli:--devtool" },
    definition: defaultMcpServerDefinition({
      transport: { type: "streamableHttp", url },
      use: { chat: { exposure: "always" } },
    }),
  };
}

export type McpResolvedValues =
  | { readonly ok: true; readonly values: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly missingEnvironmentVariables: readonly string[] };

export type McpEnvironmentResolver = (name: string) => string | undefined;

/** Resolve refs at the connection boundary. Missing names are safe to report; values are not. */
export function resolveMcpValueSources(
  sources: Readonly<Record<string, McpValueSource>>,
  resolveEnvironment: McpEnvironmentResolver,
): McpResolvedValues {
  const values: Record<string, string> = {};
  const missing = new Set<string>();
  for (const [name, source] of Object.entries(sources)) {
    if ("value" in source) {
      values[name] = source.value;
      continue;
    }
    const value = resolveEnvironment(source.fromEnv);
    if (value === undefined) {
      missing.add(source.fromEnv);
      continue;
    }
    values[name] = `${source.prefix ?? ""}${value}`;
  }
  return missing.size > 0
    ? { ok: false, missingEnvironmentVariables: [...missing].sort() }
    : { ok: true, values };
}

export interface McpTrustGrant {
  readonly serverId: string;
  readonly configFingerprint: string;
}

export type McpTrustDecision =
  | { readonly trusted: true; readonly reason: "non_workspace_source" | "stored_grant" }
  | {
      readonly trusted: false;
      readonly reason: "workspace_approval_required";
      readonly configFingerprint: string;
    };

/** Only workspace definitions need a separately persisted fingerprint grant. */
export function evaluateMcpTrust(
  server: McpDesiredServer,
  grants: readonly McpTrustGrant[],
): McpTrustDecision {
  if (server.source.kind !== "workspace") {
    return { trusted: true, reason: "non_workspace_source" };
  }
  const configFingerprint = fingerprintMcpServerDefinition(server.id, server.definition);
  const trusted = grants.some(
    (grant) => grant.serverId === server.id && grant.configFingerprint === configFingerprint,
  );
  return trusted
    ? { trusted: true, reason: "stored_grant" }
    : { trusted: false, reason: "workspace_approval_required", configFingerprint };
}

function redactSources(
  sources: Readonly<Record<string, McpValueSource>>,
): Record<string, McpValueSource> {
  return Object.fromEntries(
    Object.entries(sources).map(([name, source]) => [
      name,
      "fromEnv" in source
        ? {
            fromEnv: source.fromEnv,
            ...(source.prefix === undefined ? {} : { prefix: source.prefix }),
          }
        : { value: "<redacted>" },
    ]),
  );
}

/** Projection for CLI/status output. It cannot reveal literal or resolved secret values. */
export function projectMcpServerForDisplay(server: McpDesiredServer): object {
  const transport =
    server.definition.transport.type === "stdio"
      ? { ...server.definition.transport, env: redactSources(server.definition.transport.env) }
      : {
          ...server.definition.transport,
          headers: redactSources(server.definition.transport.headers),
        };
  return {
    id: server.id,
    source: server.source,
    definition: { ...server.definition, transport },
  };
}
