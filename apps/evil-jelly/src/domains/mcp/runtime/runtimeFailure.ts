import type {
  McpRuntimeFailure,
  McpRuntimeFailureCode,
  McpRuntimeFailureProjection,
} from "../contracts";

const MCP_FAILURE_EXCERPT_CHARS = 512;

export class McpRuntimeEventError extends Error {
  constructor(
    readonly failureCode: Exclude<McpRuntimeFailureCode, "runtime_error">,
    message: string,
  ) {
    super(message);
    this.name = "McpRuntimeEventError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function excerptMessage(message: string): {
  readonly messageExcerpt: string;
  readonly messageTruncated: boolean;
} {
  if (message.length <= MCP_FAILURE_EXCERPT_CHARS) {
    return { messageExcerpt: message, messageTruncated: false };
  }
  const edgeLength = Math.floor((MCP_FAILURE_EXCERPT_CHARS - 3) / 2);
  return {
    messageExcerpt: `${message.slice(0, edgeLength)}\n…\n${message.slice(-edgeLength)}`,
    messageTruncated: true,
  };
}

export function mcpStartupTimeoutError(timeoutMs: number): Error {
  return new McpRuntimeEventError(
    "startup_timeout",
    `MCP server startup timed out after ${timeoutMs}ms.`,
  );
}

export function mcpStartupCancelledError(): Error {
  return new McpRuntimeEventError("startup_cancelled", "MCP server startup was cancelled.");
}

export function captureMcpRuntimeFailure(error: unknown): McpRuntimeFailure {
  const detail = errorMessage(error);
  return Object.freeze({
    code: error instanceof McpRuntimeEventError ? error.failureCode : "runtime_error",
    ...excerptMessage(detail),
    detail,
  });
}

export function projectMcpRuntimeFailure(failure: McpRuntimeFailure): McpRuntimeFailureProjection {
  return Object.freeze({
    code: failure.code,
    messageExcerpt: failure.messageExcerpt,
    messageTruncated: failure.messageTruncated,
  });
}
