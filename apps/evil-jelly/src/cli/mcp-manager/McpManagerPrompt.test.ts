import { renderToString } from "ink";
import { createElement } from "react";
import stripAnsi from "strip-ansi";
import { describe, expect, it, vi } from "vitest";
import { McpManagerPrompt } from "./McpManagerPrompt";

describe("McpManagerPrompt", () => {
  it("renders connection, access, tool count, and keyboard affordances", () => {
    const output = stripAnsi(
      renderToString(
        createElement(McpManagerPrompt, {
          request: {
            rows: [
              {
                serverId: "typescript",
                source: "project",
                exposure: "explicit",
                selected: true,
                persistentAccess: false,
                routable: true,
                connection: "ready",
                toolCount: 12,
              },
              {
                serverId: "github",
                source: "user",
                exposure: "explicit",
                selected: false,
                persistentAccess: false,
                routable: false,
                connection: "untrusted",
                toolCount: 0,
              },
            ],
          },
          onAction: vi.fn(),
        }),
        { columns: 100 },
      ),
    );

    expect(output).toContain("MCP servers");
    expect(output).toContain("▸ ● typescript");
    expect(output).toContain("ready");
    expect(output).toContain("12 tools");
    expect(output).toContain("○ github");
    expect(output).toContain("Enter/Space use or remove");
  });
});
