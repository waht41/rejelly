import { createHash } from "node:crypto";
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
  systemPromptSha256?: string;
  systemInstructions?: Array<{ chars: number; sha256: string }>;
  toolResultChars: number;
  toolDefinitionCount: number;
  toolSchemaBytes: number;
  toolSchemaSha256?: string;
  toolDefinitions?: Array<{ name: string; schemaBytes: number; schemaSha256?: string }>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function serializeContent(content: Message["content"]): string {
  try {
    return JSON.stringify(content) ?? "null";
  } catch {
    return "[unserializable]";
  }
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
  const systemContents: Message["content"][] = [];
  const systemInstructions: Array<{ chars: number; sha256: string }> = [];
  for (const message of messages) {
    messagesByRole[message.role] += 1;
    const chars = contentChars(message.content);
    messageChars += chars;
    if (message.role === "system") {
      systemPromptChars += chars;
      systemContents.push(message.content);
      systemInstructions.push({ chars, sha256: sha256(serializeContent(message.content)) });
    }
    if (message.role === "tool") toolResultChars += chars;
  }

  const toolSchemas = projectToolSchemas(options);
  const serializedToolSchemas = JSON.stringify(toolSchemas);
  const toolDefinitions = toolSchemas.map((schema) => {
    const serialized = JSON.stringify(schema);
    return {
      name: schema.name,
      schemaBytes: new TextEncoder().encode(serialized).byteLength,
      schemaSha256: sha256(serialized),
    };
  });
  return {
    messagesByRole,
    messageChars,
    systemPromptChars,
    ...(systemInstructions.length > 0
      ? {
          systemPromptSha256: sha256(JSON.stringify(systemContents)),
          systemInstructions,
        }
      : {}),
    toolResultChars,
    toolDefinitionCount: toolSchemas.length,
    toolSchemaBytes:
      toolSchemas.length === 0 ? 0 : new TextEncoder().encode(serializedToolSchemas).byteLength,
    ...(toolDefinitions.length > 0
      ? { toolSchemaSha256: sha256(serializedToolSchemas), toolDefinitions }
      : {}),
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
  const systemInstructions = metrics.systemInstructions;
  const toolDefinitions = metrics.toolDefinitions;
  const isSha256 = (candidate: unknown): candidate is string =>
    typeof candidate === "string" && /^[a-f0-9]{64}$/.test(candidate);
  if (
    typeof roles !== "object" ||
    roles === null ||
    !isNonNegativeInteger(roles.system) ||
    !isNonNegativeInteger(roles.user) ||
    !isNonNegativeInteger(roles.assistant) ||
    !isNonNegativeInteger(roles.tool) ||
    !isNonNegativeInteger(metrics.messageChars) ||
    !isNonNegativeInteger(metrics.systemPromptChars) ||
    (metrics.systemPromptSha256 !== undefined && !isSha256(metrics.systemPromptSha256)) ||
    (systemInstructions !== undefined &&
      (!Array.isArray(systemInstructions) ||
        systemInstructions.some(
          (instruction) =>
            typeof instruction !== "object" ||
            instruction === null ||
            !isNonNegativeInteger(instruction.chars) ||
            !isSha256(instruction.sha256),
        ))) ||
    !isNonNegativeInteger(metrics.toolResultChars) ||
    !isNonNegativeInteger(metrics.toolDefinitionCount) ||
    !isNonNegativeInteger(metrics.toolSchemaBytes) ||
    (metrics.toolSchemaSha256 !== undefined && !isSha256(metrics.toolSchemaSha256)) ||
    (toolDefinitions !== undefined &&
      (!Array.isArray(toolDefinitions) ||
        toolDefinitions.some(
          (tool) =>
            typeof tool !== "object" ||
            tool === null ||
            typeof tool.name !== "string" ||
            tool.name.length === 0 ||
            !isNonNegativeInteger(tool.schemaBytes) ||
            (tool.schemaSha256 !== undefined && !isSha256(tool.schemaSha256)),
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
