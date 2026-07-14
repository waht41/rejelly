/**
 * JSON Schema to Zod converter for MCP tool parameters
 */

import type { JsonSchema } from "@rejelly/core";
import { z } from "zod";

function jsonSchemaPropertyToZod(propSchema: JsonSchema, path?: string): z.ZodTypeAny {
  if (!propSchema || typeof propSchema !== "object") return z.any();
  const type = propSchema.type;
  if (type === "string") {
    if (propSchema.enum && Array.isArray(propSchema.enum)) {
      return z.enum(propSchema.enum as [string, ...string[]]);
    }
    return z.string();
  }
  if (type === "number" || type === "integer") return z.number();
  if (type === "boolean") return z.boolean();
  if (type === "array") {
    const itemsSchema = propSchema.items;
    if (itemsSchema) return z.array(jsonSchemaPropertyToZod(itemsSchema as JsonSchema, path));
    return z.array(z.any());
  }
  if (type === "object" || (!type && propSchema.properties)) {
    const properties = propSchema.properties ?? {};
    const required = propSchema.required ?? [];
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, nestedPropSchema] of Object.entries(properties)) {
      const isRequired = required.includes(key);
      const zodField = jsonSchemaPropertyToZod(
        nestedPropSchema as JsonSchema,
        path ? `${path}.${key}` : key,
      );
      shape[key] = isRequired ? zodField : zodField.optional();
    }
    return z.object(shape);
  }
  return z.any();
}

export function jsonSchemaToZod(jsonSchema: JsonSchema, toolName?: string): z.ZodTypeAny {
  if (!jsonSchema || typeof jsonSchema !== "object") {
    console.warn(
      `[@rejelly/adapter-mcp] Invalid JSON Schema for tool "${toolName ?? "unknown"}". Using z.any().`,
    );
    return z.any();
  }
  const schemaType = jsonSchema.type;
  if (schemaType === "object" || (!schemaType && jsonSchema.properties)) {
    const properties = jsonSchema.properties ?? {};
    const required = jsonSchema.required ?? [];
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, propSchema] of Object.entries(properties)) {
      const isRequired = required.includes(key);
      const zodField = jsonSchemaPropertyToZod(propSchema as JsonSchema, `${toolName}.${key}`);
      shape[key] = isRequired ? zodField : zodField.optional();
    }
    return z.object(shape);
  }
  if (schemaType === "array") {
    const itemsSchema = jsonSchema.items;
    if (itemsSchema) return z.array(jsonSchemaPropertyToZod(itemsSchema as JsonSchema, toolName));
    return z.array(z.any());
  }
  if (schemaType === "string") {
    if (jsonSchema.enum && Array.isArray(jsonSchema.enum)) {
      return z.enum(jsonSchema.enum as [string, ...string[]]);
    }
    return z.string();
  }
  if (schemaType === "number" || schemaType === "integer") return z.number();
  if (schemaType === "boolean") return z.boolean();
  console.warn(
    `[@rejelly/adapter-mcp] Unsupported JSON Schema type "${schemaType}" for tool "${toolName ?? "unknown"}". Using z.any().`,
  );
  return z.any();
}
