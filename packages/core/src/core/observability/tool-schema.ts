/**
 * Serialize tool definitions for telemetry (turn/model-call, draft view model).
 * Only JSON-safe fields; no handler or middleware placeholders.
 */

import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolSchema } from "../domain/event-payload";
import type { ToolDefinition } from "../domain/tool";

/**
 * Maps equipped tools to serializable schemas (Zod parameters → JSON Schema).
 */
export function toolDefinitionsToToolSchemas(tools: ToolDefinition[]): ToolSchema[] {
  return tools.map((tool) => {
    let parameters: ToolSchema["parameters"];
    try {
      parameters = zodToJsonSchema(tool.parameters, {
        $refStrategy: "none",
      }) as ToolSchema["parameters"];
    } catch {
      parameters = {
        $schema: "serialization_error",
        description: "Parameters schema could not be converted",
      };
    }
    const row: ToolSchema = {
      name: tool.name,
      description: tool.description,
      parameters,
    };
    if (tool.middlewares !== undefined) {
      row.middlewares = tool.middlewares.map((m) => ({
        name: m.name,
        ...(m.config !== undefined ? { config: m.config } : {}),
      }));
    }
    return row;
  });
}
