import type { ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { createDevtoolMcpServer } from "../../mcp/register";

function sendMcpError(reply: ServerResponse, statusCode: number, message: string) {
  reply.writeHead(statusCode, { "Content-Type": "application/json" });
  reply.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32603,
        message,
      },
      id: null,
    }),
  );
}

export async function mcpRoutes(fastify: FastifyInstance) {
  fastify.route<{ Body: unknown }>({
    method: ["GET", "POST", "DELETE"],
    url: "/",
    async handler(request, reply) {
      const server = await createDevtoolMcpServer({});
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      reply.hijack();

      let closed = false;
      const cleanup = async () => {
        if (closed) return;
        closed = true;
        await transport.close();
        await server.close();
      };

      reply.raw.on("close", () => {
        cleanup().catch((error: unknown) => {
          fastify.log.error(error, "Error closing MCP transport");
        });
      });

      try {
        await server.connect(transport);
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch (error) {
        fastify.log.error(error, "Error handling MCP request");
        if (!reply.raw.headersSent) {
          sendMcpError(reply.raw, 500, "Internal server error");
        } else if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      }
    },
  });
}
