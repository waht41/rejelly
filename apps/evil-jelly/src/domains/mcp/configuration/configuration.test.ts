import { describe, expect, it } from "vitest";
import { fingerprintMcpServerDefinition } from "../contracts";
import {
  createDevtoolMcpDesiredServer,
  defaultMcpServerDefinition,
  evaluateMcpTrust,
  projectMcpServerForDisplay,
  resolveMcpDesiredConfig,
  resolveMcpValueSources,
} from "./configuration";

describe("MCP configuration", () => {
  it("defaults a server definition at one boundary", () => {
    expect(
      defaultMcpServerDefinition({
        transport: { type: "stdio", command: "mcp-server" },
      }),
    ).toEqual({
      transport: { type: "stdio", command: "mcp-server", args: [], cwd: ".", env: {} },
      enabled: true,
      startupTimeoutMs: 10_000,
      toolTimeoutMs: 60_000,
      maxConcurrency: 4,
      tools: { deny: [] },
      use: {
        chat: { exposure: "explicit", required: false },
        audit: {
          exposure: "off",
          required: false,
          allow: [],
          maxCallsPerSeed: 4,
          maxResultBytesPerSeed: 65_536,
        },
      },
    });
  });

  it("replaces same-id user settings with the complete workspace definition", () => {
    const config = resolveMcpDesiredConfig({
      user: {
        servers: {
          docs: {
            transport: { type: "stdio", command: "user-command" },
            startupTimeoutMs: 123,
          },
        },
      },
      workspace: {
        servers: {
          docs: { transport: { type: "stdio", command: "workspace-command" } },
        },
      },
    });

    expect(config.servers).toHaveLength(1);
    expect(config.servers[0]).toMatchObject({
      id: "docs",
      source: { kind: "workspace" },
      definition: { transport: { command: "workspace-command" }, startupTimeoutMs: 10_000 },
    });
  });

  it("resolves literal and environment sources without changing the source contract", () => {
    const sources = {
      Authorization: { fromEnv: "TOKEN", prefix: "Bearer " },
      Accept: { value: "application/json" },
    } as const;
    expect(
      resolveMcpValueSources(sources, (name) => (name === "TOKEN" ? "secret" : undefined)),
    ).toEqual({
      ok: true,
      values: { Authorization: "Bearer secret", Accept: "application/json" },
    });
    expect(sources.Authorization).toEqual({ fromEnv: "TOKEN", prefix: "Bearer " });
    expect(resolveMcpValueSources(sources, () => undefined)).toEqual({
      ok: false,
      missingEnvironmentVariables: ["TOKEN"],
    });
  });

  it("requires a matching fingerprint grant only for workspace definitions", () => {
    const workspaceServer = resolveMcpDesiredConfig({
      workspace: {
        servers: { docs: { transport: { type: "stdio", command: "docs" } } },
      },
    }).servers[0]!;
    expect(evaluateMcpTrust(workspaceServer, [])).toMatchObject({
      trusted: false,
      reason: "workspace_approval_required",
    });
    const fingerprint = fingerprintMcpServerDefinition(
      workspaceServer.id,
      workspaceServer.definition,
    );
    expect(
      evaluateMcpTrust(workspaceServer, [
        { serverId: workspaceServer.id, configFingerprint: fingerprint },
      ]),
    ).toEqual({ trusted: true, reason: "stored_grant" });

    const dynamic = createDevtoolMcpDesiredServer("http://localhost:4710/mcp");
    expect(evaluateMcpTrust(dynamic, [])).toEqual({
      trusted: true,
      reason: "non_workspace_source",
    });
  });

  it("redacts literal values from the CLI projection", () => {
    const server = resolveMcpDesiredConfig({
      user: {
        servers: {
          remote: {
            transport: {
              type: "streamableHttp",
              url: "https://example.test/mcp",
              headers: {
                Authorization: { value: "Bearer secret" },
                Token: { fromEnv: "MCP_TOKEN" },
              },
            },
          },
        },
      },
    }).servers[0]!;

    const text = JSON.stringify(projectMcpServerForDisplay(server));
    expect(text).not.toContain("Bearer secret");
    expect(text).toContain("<redacted>");
    expect(text).toContain("MCP_TOKEN");
  });
});
