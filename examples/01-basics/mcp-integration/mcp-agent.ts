/**
 * MCP Agent Examples
 *
 * Demonstrates external MCP client (official SDK) + equipResource + equipMCP
 */

import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { equipMCP, type MCPClientAdapter } from "@rejelly/adapter-mcp";
import {
  createAgent,
  equipInstruction,
  equipResource,
  equipSystem,
  expectResource,
  promptAgent,
} from "@rejelly/core";
import { getModel } from "@shared/runtime-model";
import { z } from "zod";

const model = getModel();

/**
 * Result schema for Agent responses
 */
const ResultSchema = z.object({
  summary: z.string().describe("Summary of the task result"),
  details: z.string().optional().describe("Additional details if any"),
});

async function createFilesystemMcpClient(rootDir: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", rootDir],
  });
  const client = new Client({ name: "reagent-mcp-example", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

/**
 * Parent Agent — connects MCP outside the handler lifecycle, registers tools via equipMCP
 */
export const ParentAgent = createAgent({
  id: "mcp_parent",
  model,
  handler: async (props: { task: string; filePath?: string }) => {
    equipSystem("You are a helpful assistant that can read and analyze files using MCP tools.");

    const root = path.dirname(props.filePath || process.cwd());

    const mcpClient = await equipResource(`mcp:filesystem`, {
      create: async () => createFilesystemMcpClient(root),
      destroy: async (c) => {
        await c.close();
      },
      deps: [root],
      expose: true,
    });

    const kit = await equipMCP(mcpClient, {
      clientId: "filesystem",
      namespace: "filesystem",
      enableResources: true,
    });
    kit.inject({ injectResourceTools: true });

    equipInstruction(`
Task: ${props.task}
${props.filePath ? `File path: ${props.filePath}` : ""}

You have access to MCP tools that can read files. Use them to complete the task.
Registered tool names use the prefix "filesystem_" (e.g. filesystem_read_file).
    `);

    const result = await promptAgent(ResultSchema);
    return result;
  },
});

/**
 * Child Agent — uses expectResource('mcp:filesystem') to reuse parent's exposed client
 */
export const ChildAgent = createAgent({
  id: "mcp_child",
  model,
  handler: async (props: { task: string; filePath?: string }) => {
    equipSystem("You are a helpful assistant that analyzes file contents.");

    const mcpClient = expectResource<MCPClientAdapter>("mcp:filesystem");

    if (props.filePath) {
      try {
        const fileUri = `file://${props.filePath}`;
        const resource = await mcpClient.readResource({ uri: fileUri });

        const fileContent = resource.contents
          .map((c) => {
            if ("text" in c && c.text !== undefined) return c.text;
            if ("blob" in c && c.blob !== undefined) return `[Blob: ${c.mimeType ?? "unknown"}]`;
            return JSON.stringify(c);
          })
          .join("\n");

        equipInstruction(`
Task: ${props.task}

File content:
${fileContent}
        `);
      } catch (error) {
        equipInstruction(`
Task: ${props.task}

Note: Failed to read file: ${error instanceof Error ? error.message : String(error)}
Please use the available MCP tools to read the file instead.
        `);
      }
    } else {
      equipInstruction(`Task: ${props.task}`);
    }

    const result = await promptAgent(ResultSchema);
    return result;
  },
});

/**
 * Parent Agent that calls Child Agent
 */
export const ParentWithChildAgent = createAgent({
  id: "mcp_parent_with_child",
  model,
  handler: async (props: { task: string; filePath?: string }) => {
    equipSystem("You are a coordinator that delegates tasks to specialized agents.");

    const root = path.dirname(props.filePath || process.cwd());

    const mcpClient = await equipResource(`mcp:filesystem`, {
      create: async () => createFilesystemMcpClient(root),
      destroy: async (c) => {
        await c.close();
      },
      deps: [root],
      expose: true,
    });

    const kit = await equipMCP(mcpClient, {
      clientId: "filesystem",
      namespace: "filesystem",
      enableResources: true,
    });
    kit.inject({ injectResourceTools: true });

    const childResult = await ChildAgent({
      task: props.task,
      filePath: props.filePath,
    });

    return {
      summary: `Parent agent coordinated the task. Child agent result: ${childResult.summary}`,
      details: childResult.details,
    };
  },
});
