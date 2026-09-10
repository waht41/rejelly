import {
  equipTraceAttr,
  isContextNotFoundError,
  type Message,
  type ModelAdapter,
  type ModelMiddleware,
  type ModelStreamOptions,
  type StreamEvent,
  type ToolSchema,
} from "@rejelly/core";
import { zodToJsonSchema } from "zod-to-json-schema";

export const MODEL_INPUT_METRICS_TRACE_ATTRIBUTE = "evil_jelly.model_input";

export interface ModelInputMetrics {
  messagesByRole: Record<Message["role"], number>;
  messageChars: number;
  systemPromptChars: number;
  toolResultChars: number;
  toolDefinitionCount: number;
  toolSchemaBytes: number;
  toolDefinitions?: Array<{ name: string; schemaBytes: number }>;
}

function contentChars(content: Message["content"]): number {
  if (content === null) return 0;
  if (typeof content === "string") return content.length;
  try {
    return JSON.stringify(content).length;
  } catch {
    return 0;
  }
}

function projectToolSchemas(options?: ModelStreamOptions): ToolSchema[] {
  return (options?.tools ?? []).map((tool) => {
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
    const schema: ToolSchema = {
      name: tool.name,
      description: tool.description,
      parameters,
    };
    if (tool.middlewares !== undefined) {
      schema.middlewares = tool.middlewares.map((middleware) => ({
        name: middleware.name,
        ...(middleware.config !== undefined ? { config: middleware.config } : {}),
      }));
    }
    return schema;
  });
}

export function projectModelInputMetrics(
  messages: readonly Message[],
  options?: ModelStreamOptions,
): ModelInputMetrics {
  const messagesByRole: Record<Message["role"], number> = {
    system: 0,
    user: 0,
    assistant: 0,
    tool: 0,
  };
  let messageChars = 0;
  let systemPromptChars = 0;
  let toolResultChars = 0;
  for (const message of messages) {
    messagesByRole[message.role] += 1;
    const chars = contentChars(message.content);
    messageChars += chars;
    if (message.role === "system") systemPromptChars += chars;
    if (message.role === "tool") toolResultChars += chars;
  }

  const toolSchemas = projectToolSchemas(options);
  const toolDefinitions = toolSchemas.map((schema) => ({
    name: schema.name,
    schemaBytes: new TextEncoder().encode(JSON.stringify(schema)).byteLength,
  }));
  return {
    messagesByRole,
    messageChars,
    systemPromptChars,
    toolResultChars,
    toolDefinitionCount: toolSchemas.length,
    toolSchemaBytes:
      toolSchemas.length === 0
        ? 0
        : new TextEncoder().encode(JSON.stringify(toolSchemas)).byteLength,
    ...(toolDefinitions.length > 0 ? { toolDefinitions } : {}),
  };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function readModelInputMetrics(
  attributes: Readonly<Record<string, unknown>> | undefined,
): ModelInputMetrics | undefined {
  const value = attributes?.[MODEL_INPUT_METRICS_TRACE_ATTRIBUTE];
  if (typeof value !== "object" || value === null) return undefined;
  const metrics = value as Partial<ModelInputMetrics>;
  const roles = metrics.messagesByRole;
  const toolDefinitions = metrics.toolDefinitions;
  if (
    typeof roles !== "object" ||
    roles === null ||
    !isNonNegativeInteger(roles.system) ||
    !isNonNegativeInteger(roles.user) ||
    !isNonNegativeInteger(roles.assistant) ||
    !isNonNegativeInteger(roles.tool) ||
    !isNonNegativeInteger(metrics.messageChars) ||
    !isNonNegativeInteger(metrics.systemPromptChars) ||
    !isNonNegativeInteger(metrics.toolResultChars) ||
    !isNonNegativeInteger(metrics.toolDefinitionCount) ||
    !isNonNegativeInteger(metrics.toolSchemaBytes) ||
    (toolDefinitions !== undefined &&
      (!Array.isArray(toolDefinitions) ||
        toolDefinitions.some(
          (tool) =>
            typeof tool !== "object" ||
            tool === null ||
            typeof tool.name !== "string" ||
            tool.name.length === 0 ||
            !isNonNegativeInteger(tool.schemaBytes),
        )))
  ) {
    return undefined;
  }
  return metrics as ModelInputMetrics;
}

/** Attach Evil-owned prompt composition metrics to the active Core model-call span. */
export function withModelInputMetrics(): ModelMiddleware {
  return {
    name: "evil_jelly_model_input_metrics",
    wrap(inner: ModelAdapter): ModelAdapter {
      return {
        ...inner,
        stream: async function* (
          messages: Message[],
          options?: ModelStreamOptions,
        ): AsyncGenerator<StreamEvent> {
          const metrics = projectModelInputMetrics(messages, options);
          try {
            equipTraceAttr({ [MODEL_INPUT_METRICS_TRACE_ATTRIBUTE]: metrics }, { target: "local" });
          } catch (error) {
            // A decorated adapter remains usable directly outside an Agent context.
            if (!isContextNotFoundError(error)) throw error;
          }
          yield* inner.stream(messages, options);
        },
      };
    },
  };
}
