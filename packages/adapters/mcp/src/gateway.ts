import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import { McpProtocolError } from "./errors";

export interface McpCatalogClient {
  listTools(params?: { cursor?: string }): Promise<unknown>;
}

export interface McpCallClient {
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
}

export interface McpNativeToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface LoadMcpToolCatalogOptions {
  /** Follow tools/list cursors. Defaults to true. */
  readonly autoPaginate?: boolean;
  /** Reject catalogs larger than this limit. Defaults to 1000. */
  readonly maxItems?: number;
}

export interface McpJsonSchemaValidationIssue {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly message: string;
}

export type McpJsonSchemaValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "invalid_schema" | "invalid_arguments";
      readonly issues: readonly McpJsonSchemaValidationIssue[];
    };

export interface McpNormalizedCallResult {
  readonly content: readonly Readonly<Record<string, unknown>>[];
  readonly isError: boolean;
  readonly structuredContent?: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function normalizeNativeTool(raw: unknown): McpNativeToolDescriptor {
  if (!isRecord(raw) || typeof raw.name !== "string" || raw.name.length === 0) {
    throw new McpProtocolError("tools/list returned a tool without a name", {
      code: "invalid_tool_name",
    });
  }
  if (raw.description !== undefined && typeof raw.description !== "string") {
    throw new McpProtocolError(`Tool "${raw.name}" has an invalid description`, {
      code: "invalid_tool_description",
      toolName: raw.name,
    });
  }
  const inputSchema = raw.inputSchema ?? { type: "object", properties: {} };
  if (!isRecord(inputSchema)) {
    throw new McpProtocolError(`Tool "${raw.name}" has an invalid input schema`, {
      code: "invalid_tool_schema",
      toolName: raw.name,
    });
  }
  try {
    return Object.freeze({
      name: raw.name,
      ...(raw.description === undefined ? {} : { description: raw.description }),
      inputSchema: cloneAndFreeze(inputSchema),
    });
  } catch (cause) {
    throw new McpProtocolError(`Tool "${raw.name}" has an uncloneable input schema`, {
      code: "invalid_tool_schema",
      toolName: raw.name,
      cause,
    });
  }
}

/** Pure protocol normalization used by both tools/list and list-changed notifications. */
export function normalizeMcpToolCatalog(
  tools: readonly unknown[],
): readonly McpNativeToolDescriptor[] {
  const normalized = tools.map(normalizeNativeTool);
  const names = new Set<string>();
  for (const tool of normalized) {
    if (names.has(tool.name)) {
      throw new McpProtocolError(`Duplicate MCP tool name: ${tool.name}`, {
        code: "duplicate_tool_name",
        toolName: tool.name,
      });
    }
    names.add(tool.name);
  }
  return Object.freeze(normalized.sort((left, right) => left.name.localeCompare(right.name)));
}

function parseCatalogPage(raw: unknown): {
  readonly tools: readonly unknown[];
  readonly nextCursor?: string;
} {
  if (Array.isArray(raw)) return { tools: raw };
  if (!isRecord(raw) || !Array.isArray(raw.tools)) {
    throw new McpProtocolError("Unexpected tools/list return shape", {
      code: "invalid_catalog_shape",
    });
  }
  if (raw.nextCursor !== undefined && typeof raw.nextCursor !== "string") {
    throw new McpProtocolError("tools/list returned an invalid cursor", {
      code: "invalid_cursor",
    });
  }
  return {
    tools: raw.tools,
    ...(raw.nextCursor === undefined ? {} : { nextCursor: raw.nextCursor }),
  };
}

/** Load a fresh catalog directly from the client; no equip or epoch cache participates. */
export async function loadMcpToolCatalog(
  client: McpCatalogClient,
  options: LoadMcpToolCatalogOptions = {},
): Promise<readonly McpNativeToolDescriptor[]> {
  const autoPaginate = options.autoPaginate !== false;
  const maxItems = options.maxItems ?? 1000;
  if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
    throw new McpProtocolError("maxItems must be a positive safe integer", {
      code: "invalid_catalog_limit",
    });
  }

  const tools: unknown[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = parseCatalogPage(await client.listTools(cursor ? { cursor } : undefined));
    tools.push(...page.tools);
    if (tools.length > maxItems) {
      throw new McpProtocolError(`MCP catalog exceeds maxItems (${maxItems})`, {
        code: "catalog_limit_exceeded",
      });
    }
    if (!autoPaginate || !page.nextCursor) break;
    if (seenCursors.has(page.nextCursor)) {
      throw new McpProtocolError(`Repeated tools/list cursor: ${page.nextCursor}`, {
        code: "cursor_cycle",
      });
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  return normalizeMcpToolCatalog(tools);
}

function validationIssues(
  errors: ErrorObject[] | null | undefined,
): McpJsonSchemaValidationIssue[] {
  return (errors ?? []).map((error) => ({
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? "JSON Schema validation failed",
  }));
}

/** Validate native MCP arguments against the server's full JSON Schema. */
export function validateMcpToolArguments(
  inputSchema: Readonly<Record<string, unknown>>,
  argumentsValue: Record<string, unknown>,
): McpJsonSchemaValidationResult {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: false,
  });
  let validate: ReturnType<Ajv2020["compile"]>;
  try {
    validate = ajv.compile(inputSchema);
  } catch (error) {
    return {
      ok: false,
      reason: "invalid_schema",
      issues: [
        {
          instancePath: "",
          schemaPath: "",
          keyword: "schema",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
  if (validate(argumentsValue)) return { ok: true };
  return {
    ok: false,
    reason: "invalid_arguments",
    issues: validationIssues(validate.errors),
  };
}

function validateContentBlock(block: unknown, index: number): Record<string, unknown> {
  if (!isRecord(block) || typeof block.type !== "string" || block.type.length === 0) {
    throw new McpProtocolError(`Invalid tools/call content block at index ${index}`, {
      code: "invalid_call_result",
    });
  }
  if (block.type === "text" && typeof block.text !== "string") {
    throw new McpProtocolError(`Invalid text content block at index ${index}`, {
      code: "invalid_call_result",
    });
  }
  if (
    (block.type === "image" || block.type === "audio") &&
    (typeof block.data !== "string" || typeof block.mimeType !== "string")
  ) {
    throw new McpProtocolError(`Invalid ${block.type} content block at index ${index}`, {
      code: "invalid_call_result",
    });
  }
  if (
    block.type === "resource" &&
    (!isRecord(block.resource) || typeof block.resource.uri !== "string")
  ) {
    throw new McpProtocolError(`Invalid resource content block at index ${index}`, {
      code: "invalid_call_result",
    });
  }
  return block;
}

/** Normalize a native tools/call response without converting it into provider content. */
export function normalizeMcpCallResult(raw: unknown): McpNormalizedCallResult {
  if (!isRecord(raw) || !Array.isArray(raw.content)) {
    throw new McpProtocolError("Unexpected tools/call return shape", {
      code: "invalid_call_result",
    });
  }
  if (raw.isError !== undefined && typeof raw.isError !== "boolean") {
    throw new McpProtocolError("tools/call returned an invalid isError flag", {
      code: "invalid_call_result",
    });
  }
  if (raw.structuredContent !== undefined && !isRecord(raw.structuredContent)) {
    throw new McpProtocolError("tools/call returned invalid structuredContent", {
      code: "invalid_call_result",
    });
  }
  const content = raw.content.map(validateContentBlock);
  try {
    return Object.freeze({
      content: cloneAndFreeze(content),
      isError: raw.isError ?? false,
      ...(raw.structuredContent === undefined
        ? {}
        : { structuredContent: cloneAndFreeze(raw.structuredContent) }),
    });
  } catch (cause) {
    throw new McpProtocolError("tools/call returned uncloneable content", {
      code: "invalid_call_result",
      cause,
    });
  }
}

/** Call one native MCP tool using the canonical protocol request shape. */
export async function callMcpTool(
  client: McpCallClient,
  name: string,
  argumentsValue: Record<string, unknown>,
): Promise<McpNormalizedCallResult> {
  return normalizeMcpCallResult(
    await client.callTool({
      name,
      arguments: argumentsValue,
    }),
  );
}
