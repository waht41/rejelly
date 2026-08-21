export const MCP_SERVER_ID_MAX_CHARS = 64;

export type McpIdentifierValidationResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly value: string; readonly reason: string };

const MCP_SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** Stable identity shared by prompt, Session, configuration, and runtime boundaries. */
export function validateMcpServerId(input: string): McpIdentifierValidationResult {
  const value = input.trim();
  if (value.length === 0) {
    return { ok: false, value, reason: "MCP server id must not be empty." };
  }
  if (value.length > MCP_SERVER_ID_MAX_CHARS) {
    return {
      ok: false,
      value,
      reason: `MCP server id must be at most ${MCP_SERVER_ID_MAX_CHARS} characters.`,
    };
  }
  if (!MCP_SERVER_ID_PATTERN.test(value)) {
    return {
      ok: false,
      value,
      reason:
        "MCP server id must start with a lowercase ASCII letter or digit and contain only a-z, 0-9, dot, underscore, or hyphen.",
    };
  }
  return { ok: true, value };
}
