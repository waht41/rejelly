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
    expect(output).toContain("Enter details");
  });

  it("renders server actions and a cancellable startup state in the detail panel", () => {
    const row = {
      serverId: "typescript",
      source: "project",
      exposure: "explicit" as const,
      selected: true,
      persistentAccess: false,
      routable: false,
      connection: "pending" as const,
      toolCount: 0,
    };
    const detail = stripAnsi(
      renderToString(
        createElement(McpManagerPrompt, {
          request: { rows: [row], detailServerId: "typescript" },
          onAction: vi.fn(),
        }),
      ),
    );
    const loading = stripAnsi(
      renderToString(
        createElement(McpManagerPrompt, {
          request: {
            rows: [row],
            detailServerId: "typescript",
            activity: { serverId: "typescript", label: "Starting typescript…" },
          },
          onAction: vi.fn(),
        }),
      ),
    );

    expect(detail).toContain("Remove from this session");
    expect(detail).toContain("Reload connection");
    expect(loading).toContain("Starting typescript…");
    expect(loading).toContain("Esc cancel startup");
  });

  it("renders the terminal tool panel with inline batch actions", () => {
    const output = stripAnsi(
      renderToString(
        createElement(McpManagerPrompt, {
          request: {
            rows: [],
            toolPanel: {
              serverId: "typescript",
              rows: [
                {
                  nativeToolName: "find_references",
                  description: "Find symbol references",
                  inputSchema: { type: "object" },
                  approval: "ask",
                  configFingerprint: "a".repeat(64),
                  toolSchemaFingerprint: "b".repeat(64),
                },
                {
                  nativeToolName: "diagnostics",
                  description: "Read diagnostics",
                  inputSchema: { type: "object" },
                  approval: "always",
                  configFingerprint: "a".repeat(64),
                  toolSchemaFingerprint: "c".repeat(64),
                },
              ],
            },
          },
          onAction: vi.fn(),
        }),
      ),
    );

    expect(output).toContain("Tools & approvals");
    expect(output).toContain("1 always · 0 session · 1 ask");
    expect(output).toContain("Tool");
    expect(output).toContain("Access");
    expect(output).toContain("find_references");
    expect(output).toContain("│ ask");
    expect(output).toContain("Enter details · Space select · S session · A always · R revoke");
  });
});
