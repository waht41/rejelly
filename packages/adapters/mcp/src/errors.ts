export type McpProtocolErrorCode =
  | "invalid_catalog_shape"
  | "invalid_tool_name"
  | "invalid_tool_description"
  | "invalid_tool_schema"
  | "duplicate_tool_name"
  | "invalid_cursor"
  | "invalid_catalog_limit"
  | "catalog_limit_exceeded"
  | "cursor_cycle"
  | "invalid_call_result";

export interface McpProtocolErrorPayload {
  readonly code: McpProtocolErrorCode;
  readonly toolName?: string;
  readonly cause?: unknown;
}

/** A malformed MCP protocol value, kept distinct from transport and policy failures. */
export class McpProtocolError extends Error {
  readonly name = "McpProtocolError";
  readonly code: McpProtocolErrorCode;
  declare readonly toolName?: string;
  override readonly cause?: unknown;

  constructor(message: string, payload: McpProtocolErrorPayload) {
    super(message);
    this.code = payload.code;
    if (payload.toolName !== undefined) this.toolName = payload.toolName;
    this.cause = payload.cause;
    Object.setPrototypeOf(this, McpProtocolError.prototype);
  }
}
