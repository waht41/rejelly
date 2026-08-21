import { describe, expect, it } from "vitest";
import { mcpBoundRouteFixture } from "./__tests__/mcpTestFixtures";
import type { McpBoundRoute } from "./contracts";
import {
  fingerprintMcpToolSchema,
  mcpToolGrantForRoute,
  mcpToolGrantMatchesRoute,
} from "./permissions";

function route(inputSchema: McpBoundRoute["inputSchema"]): McpBoundRoute {
  return mcpBoundRouteFixture({
    inputSchema,
    configFingerprint: "a".repeat(64),
  });
}

describe("MCP tool permissions", () => {
  it("fingerprints schemas canonically and invalidates grants on schema drift", () => {
    const original = route({ type: "object", properties: { path: { type: "string" } } });
    const reordered = route({ properties: { path: { type: "string" } }, type: "object" });
    const drifted = route({ type: "object", properties: { path: { type: "number" } } });
    const grant = mcpToolGrantForRoute(original);

    expect(fingerprintMcpToolSchema(reordered)).toBe(fingerprintMcpToolSchema(original));
    expect(mcpToolGrantMatchesRoute(grant, reordered)).toBe(true);
    expect(mcpToolGrantMatchesRoute(grant, drifted)).toBe(false);
  });
});
