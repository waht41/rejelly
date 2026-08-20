import { createHash } from "node:crypto";
import { z } from "zod";
import {
  MCP_SERVER_ID_MAX_CHARS,
  type McpIdentifierValidationResult,
  validateMcpServerId,
} from "../../shared/model/mcp/serverIdentity";

export const MCP_CONTRACT_LIMITS = Object.freeze({
  serverIdChars: MCP_SERVER_ID_MAX_CHARS,
  toolNameChars: 256,
  catalogRevisionChars: 128,
  referenceQueryChars: 512,
  referenceServerIds: 32,
  referenceMaxResults: 20,
  gatewayArgumentsBytes: 256 * 1024,
  gatewayArgumentsDepth: 32,
});

export const MCP_RESERVED_SERVER_ID_PREFIX = "evil.";

export function isReservedMcpServerId(serverId: string): boolean {
  return serverId.startsWith(MCP_RESERVED_SERVER_ID_PREFIX);
}

/** User/workspace settings cannot shadow built-in dynamic definitions. */
export function validateUserMcpServerId(input: string): McpIdentifierValidationResult {
  const result = validateMcpServerId(input);
  if (!result.ok || !isReservedMcpServerId(result.value)) return result;
  return {
    ok: false,
    value: result.value,
    reason: `MCP server ids starting with ${MCP_RESERVED_SERVER_ID_PREFIX} are reserved.`,
  };
}

export interface McpLiteralValueSource {
  readonly value: string;
}

/** A secret-safe reference: the resolved environment value never belongs to this contract. */
export interface McpEnvironmentValueSource {
  readonly fromEnv: string;
  readonly prefix?: string;
}

export type McpValueSource = McpLiteralValueSource | McpEnvironmentValueSource;

export interface McpStdioTransportDefinition {
  readonly type: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, McpValueSource>>;
}

export interface McpStreamableHttpTransportDefinition {
  readonly type: "streamableHttp";
  readonly url: string;
  readonly headers: Readonly<Record<string, McpValueSource>>;
}

export type McpTransportDefinition =
  | McpStdioTransportDefinition
  | McpStreamableHttpTransportDefinition;

export interface McpToolFilter {
  /** Omitted means all native tools; an empty list means none. */
  readonly allow?: readonly string[];
  /** Applied after allow. */
  readonly deny: readonly string[];
}

export type McpChatExposure = "off" | "explicit" | "always";
export type McpAuditExposure = "off" | "always";

export interface McpChatUsePolicy {
  readonly exposure: McpChatExposure;
  readonly required: boolean;
}

export interface McpAuditUsePolicy {
  readonly exposure: McpAuditExposure;
  readonly required: boolean;
  /** Exact native MCP names; Audit never trusts server readOnlyHint as authorization. */
  readonly allow: readonly string[];
  readonly maxCallsPerSeed: number;
  readonly maxResultBytesPerSeed: number;
}

export interface McpServerUsePolicies {
  readonly chat: McpChatUsePolicy;
  readonly audit: McpAuditUsePolicy;
}

/** Fully defaulted, secret-unresolved server intent consumed by the runtime manager. */
export interface McpServerDefinition {
  readonly transport: McpTransportDefinition;
  readonly enabled: boolean;
  readonly startupTimeoutMs: number;
  readonly toolTimeoutMs: number;
  readonly maxConcurrency: number;
  readonly tools: McpToolFilter;
  readonly use: McpServerUsePolicies;
}

export type McpConsumer = keyof McpServerUsePolicies;

function filterAllows(filter: McpToolFilter, nativeToolName: string): boolean {
  const allowed = filter.allow === undefined || filter.allow.includes(nativeToolName);
  return allowed && !filter.deny.includes(nativeToolName);
}

/** Consumer policy may only narrow the server-wide tool security ceiling. */
export function isMcpToolAllowed(
  server: McpServerDefinition,
  consumer: McpConsumer,
  nativeToolName: string,
): boolean {
  if (!server.enabled || server.use[consumer].exposure === "off") return false;
  if (!filterAllows(server.tools, nativeToolName)) return false;
  return consumer === "chat" || server.use.audit.allow.includes(nativeToolName);
}

export type McpConfigSource =
  | { readonly kind: "builtin" }
  | { readonly kind: "user" }
  | { readonly kind: "workspace" }
  | { readonly kind: "dynamic"; readonly sourceId: string };

export interface McpDesiredServer {
  readonly id: string;
  readonly definition: McpServerDefinition;
  readonly source: McpConfigSource;
}

export interface McpDesiredConfig {
  /** Set semantics; array order carries no precedence or identity. */
  readonly servers: readonly McpDesiredServer[];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function normalizedValueSources(
  sources: Readonly<Record<string, McpValueSource>>,
): Record<string, McpValueSource> {
  return Object.fromEntries(
    Object.entries(sources)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, source]) => [
        name,
        "fromEnv" in source
          ? { fromEnv: source.fromEnv, ...(source.prefix ? { prefix: source.prefix } : {}) }
          : { value: source.value },
      ]),
  );
}

/** Canonical projection contains references and policy, never resolved environment values. */
function fingerprintProjection(serverId: string, server: McpServerDefinition): object {
  const transport = transportFingerprintProjection(server.transport);
  return {
    id: serverId,
    transport,
    enabled: server.enabled,
    startupTimeoutMs: server.startupTimeoutMs,
    toolTimeoutMs: server.toolTimeoutMs,
    maxConcurrency: server.maxConcurrency,
    tools: {
      ...(server.tools.allow === undefined ? {} : { allow: sortedUnique(server.tools.allow) }),
      deny: sortedUnique(server.tools.deny),
    },
    use: {
      chat: {
        exposure: server.use.chat.exposure,
        required: server.use.chat.required,
      },
      audit: {
        exposure: server.use.audit.exposure,
        required: server.use.audit.required,
        allow: sortedUnique(server.use.audit.allow),
        maxCallsPerSeed: server.use.audit.maxCallsPerSeed,
        maxResultBytesPerSeed: server.use.audit.maxResultBytesPerSeed,
      },
    },
  };
}

function transportFingerprintProjection(transport: McpTransportDefinition): object {
  return transport.type === "stdio"
    ? {
        type: transport.type,
        command: transport.command,
        args: [...transport.args],
        cwd: transport.cwd,
        env: normalizedValueSources(transport.env),
      }
    : {
        type: transport.type,
        url: transport.url,
        headers: normalizedValueSources(transport.headers),
      };
}

export function fingerprintMcpServerDefinition(
  serverId: string,
  server: McpServerDefinition,
): string {
  return createHash("sha256")
    .update(JSON.stringify(fingerprintProjection(serverId, server)))
    .digest("hex");
}

/** Transport-only fingerprint: policy/default changes can publish a new binding without reconnect. */
export function fingerprintMcpConnectionDefinition(
  serverId: string,
  server: McpServerDefinition,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({ id: serverId, transport: transportFingerprintProjection(server.transport) }),
    )
    .digest("hex");
}

export interface McpToolIdentity {
  readonly serverId: string;
  readonly nativeToolName: string;
}

export interface McpBoundRoute {
  readonly identity: McpToolIdentity;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, McpJsonValue>>;
  readonly configFingerprint: string;
  readonly catalogRevision: string;
}

export interface McpBoundNativeTool {
  readonly nativeToolName: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, McpJsonValue>>;
}

export type McpServerRuntimeStatus = "disabled" | "untrusted" | "pending" | "ready" | "failed";

export interface McpServerRuntimeState {
  readonly serverId: string;
  readonly configFingerprint: string;
  readonly status: McpServerRuntimeStatus;
  readonly catalogRevision?: string;
  readonly error?: string;
}

export interface McpRuntimeSnapshot {
  readonly generation: number;
  readonly desiredFingerprint: string;
  /** Set semantics; presentation ordering is a projection. */
  readonly servers: readonly McpServerRuntimeState[];
}

export interface McpSelectedServerBinding {
  readonly serverId: string;
  readonly configFingerprint: string;
  readonly status: McpServerRuntimeStatus;
  readonly catalogRevision?: string;
  /** Set semantics; tool ordering is only a presentation concern. */
  readonly tools: readonly McpBoundNativeTool[];
}

/** Ephemeral policy snapshot for one adapter dispatch and its resulting tool batch. */
export interface McpDispatchBinding {
  readonly bindingId: string;
  readonly generation: number;
  /** Canonical selected-server fact; array order never determines routing. */
  readonly servers: readonly McpSelectedServerBinding[];
  /** Lookup projection over servers; any cache is disposable and never authoritative. */
  route(identity: McpToolIdentity): McpBoundRoute | undefined;
}

export type McpJsonValue =
  | null
  | boolean
  | number
  | string
  | McpJsonValue[]
  | { [key: string]: McpJsonValue };

function isMcpJsonValue(value: unknown): value is McpJsonValue {
  const active = new WeakSet<object>();
  const stack: Array<{ readonly value: unknown; readonly exit?: true }> = [{ value }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const current = frame.value;
    if (current === null || typeof current === "string" || typeof current === "boolean") continue;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return false;
      continue;
    }
    if (typeof current !== "object") return false;
    if (frame.exit) {
      active.delete(current);
      continue;
    }
    if (active.has(current)) return false;
    if (!Array.isArray(current)) {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) return false;
    }
    active.add(current);
    stack.push({ value: current, exit: true });
    for (const child of Array.isArray(current) ? current : Object.values(current)) {
      stack.push({ value: child });
    }
  }
  return true;
}

// Provider schemas intentionally expose arbitrary JSON values as opaque. The selected native
// tool's full JSON Schema remains authoritative and is validated by McpCallPolicy immediately
// before invocation.
const mcpJsonValueSchema = z.custom<McpJsonValue>(isMcpJsonValue, {
  message: "Expected a JSON value",
});

const gatewayServerIdSchema = z
  .string()
  .min(1)
  .max(MCP_CONTRACT_LIMITS.serverIdChars)
  .refine((value) => validateMcpServerId(value).ok);

export const MCP_REFERENCE_TOOL_NAME = "mcp_reference";
export const MCP_CALL_TOOL_NAME = "mcp_call";

export const MCP_REFERENCE_TOOL_DESCRIPTION =
  "Find configured MCP tools and return their current descriptions, input schemas, callability, and catalog revisions.";
export const MCP_CALL_TOOL_DESCRIPTION =
  "Call one previously referenced MCP tool using its structured identity, catalog revision, and JSON object arguments.";

export const mcpReferenceInputSchema = z
  .object({
    query: z.string().min(1).max(MCP_CONTRACT_LIMITS.referenceQueryChars),
    serverIds: z
      .array(gatewayServerIdSchema)
      .max(MCP_CONTRACT_LIMITS.referenceServerIds)
      .optional(),
    maxResults: z.number().int().min(1).max(MCP_CONTRACT_LIMITS.referenceMaxResults).optional(),
  })
  .strict();

export const mcpCallInputSchema = z
  .object({
    tool: z
      .object({
        serverId: gatewayServerIdSchema,
        nativeToolName: z.string().min(1).max(MCP_CONTRACT_LIMITS.toolNameChars),
      })
      .strict(),
    catalogRevision: z.string().min(1).max(MCP_CONTRACT_LIMITS.catalogRevisionChars),
    arguments: z.record(z.string(), mcpJsonValueSchema),
  })
  .strict();

export type McpReferenceInput = z.infer<typeof mcpReferenceInputSchema>;
export type McpCallInput = z.infer<typeof mcpCallInputSchema>;

export interface McpReferenceMatch extends McpBoundRoute {
  /** False means discoverable but not selected for calls in this dispatch. */
  readonly callable: boolean;
}

export interface McpReferenceResult {
  readonly type: "mcp_reference_v1";
  readonly matches: readonly McpReferenceMatch[];
  readonly pendingServerIds?: readonly string[];
}

export type McpCallRejectionCode =
  | "tool_unavailable"
  | "catalog_changed"
  | "approval_denied"
  | "call_failed"
  | "arguments_too_large"
  | "arguments_too_deep"
  | "call_budget_exceeded"
  | "result_too_large"
  | "invalid_tool_schema"
  | "invalid_arguments";

export interface McpCallValidationIssue {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly message: string;
}

export type McpCallPolicyResult<TCallResult> =
  | {
      readonly type: "mcp_call_result_v1";
      readonly status: "completed";
      readonly tool: McpToolIdentity;
      readonly catalogRevision: string;
      readonly result: TCallResult;
    }
  | {
      readonly type: "mcp_call_result_v1";
      readonly status: "rejected";
      readonly tool: McpToolIdentity;
      readonly code: McpCallRejectionCode;
      readonly message: string;
      readonly currentCatalogRevision?: string;
      readonly issues?: readonly McpCallValidationIssue[];
    };
