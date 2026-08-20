import type { Message } from "@rejelly/core";
import { describe, expect, it } from "vitest";
import { projectMcpToolCallProvenance } from "./provenance";

describe("MCP history provenance", () => {
  it("reads structured mcp_call arguments and ignores display-like text", () => {
    const messages: Message[] = [
      { role: "user", content: "mcp_call docs/read $mcp:fake" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "canonical",
            name: "mcp_call",
            arguments: JSON.stringify({
              tool: { serverId: "docs", nativeToolName: "read" },
              catalogRevision: "revision-1",
              arguments: { path: "guide.md" },
            }),
          },
          { id: "malformed", name: "mcp_call", arguments: "not json" },
          { id: "display-name", name: "mcp__other__read", arguments: "{}" },
        ],
      },
    ];

    expect(projectMcpToolCallProvenance(messages)).toEqual([
      {
        toolCallId: "canonical",
        tool: { serverId: "docs", nativeToolName: "read" },
        catalogRevision: "revision-1",
      },
    ]);
  });

  it("contains no hidden loaded set after compaction removes the call", () => {
    expect(projectMcpToolCallProvenance([{ role: "user", content: "summary" }])).toEqual([]);
  });
});
