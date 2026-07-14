/**
 * MCP Example - Entry Point
 *
 * Demonstrates using Model Context Protocol (MCP) with Rejelly
 * equipResource + equipMCP; child agents use expectResource for shared client
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExampleModule } from "@shared/types";
import { ParentAgent, ParentWithChildAgent } from "./mcp-agent";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const meta = {
  name: "MCP Integration",
  description: "equipMCP with external MCP Client and equipResource",
  order: 20,
};

async function example1() {
  console.log("=== Example 1: Basic MCP Usage (Stdio Transport) ===\n");
  console.log("This example uses the filesystem MCP server to read files.\n");
  try {
    const result = await ParentAgent({
      task: "Read the README.md file from the examples directory and summarize it",
      filePath: path.resolve(__dirname, "./README.md"),
    });
    console.log("Result:", result);
  } catch (error) {
    console.error("Error:", error);
  }
}

async function example2() {
  console.log("\n=== Example 2: Parent-Child Pattern (expectResource) ===\n");
  console.log(
    "Parent exposes MCP via equipResource; Child uses expectResource<MCPClientAdapter>.\n",
  );
  try {
    const result = await ParentWithChildAgent({
      task: "Read the package.json file and tell me what scripts are available",
      filePath: path.resolve(__dirname, "../package.json"),
    });
    console.log("Result:", result);
  } catch (error) {
    console.error("Error:", error);
  }
}

export const examples = {
  "basic-mcp": {
    title: "Basic MCP (Stdio Transport)",
    description: "Connect to MCP server via stdio, auto-register tools",
    run: example1,
  },
  "parent-child": {
    title: "Parent-Child with expectResource",
    description: "Parent exposes MCP; Child uses expectResource for the same client",
    run: example2,
  },
} satisfies ExampleModule["examples"];
