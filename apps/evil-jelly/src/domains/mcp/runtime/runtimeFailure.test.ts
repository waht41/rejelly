import { describe, expect, it } from "vitest";
import {
  captureMcpRuntimeFailure,
  mcpStartupTimeoutError,
  projectMcpRuntimeFailure,
} from "./runtimeFailure";

describe("MCP runtime failure capture", () => {
  it("does not infer a cause from external error text", () => {
    const failure = captureMcpRuntimeFailure(
      new Error("FATAL ERROR: JavaScript heap out of memory"),
    );

    expect(failure).toMatchObject({
      code: "runtime_error",
      messageExcerpt: "FATAL ERROR: JavaScript heap out of memory",
      messageTruncated: false,
    });
  });

  it("uses a specific code only for an internally typed event", () => {
    expect(captureMcpRuntimeFailure(mcpStartupTimeoutError(1_500))).toMatchObject({
      code: "startup_timeout",
      messageExcerpt: "MCP server startup timed out after 1500ms.",
      messageTruncated: false,
    });
  });

  it("projects a bounded excerpt without human-only detail", () => {
    const failure = captureMcpRuntimeFailure(new Error(`head-${"x".repeat(1_000)}-tail`));
    const projection = projectMcpRuntimeFailure(failure);

    expect(projection.messageExcerpt.length).toBeLessThanOrEqual(512);
    expect(projection.messageExcerpt).toContain("head-");
    expect(projection.messageExcerpt).toContain("-tail");
    expect(projection.messageTruncated).toBe(true);
    expect(projection).not.toHaveProperty("detail");
  });
});
