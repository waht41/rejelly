/**
 * JSON Schema display helpers (TS interface vs JSON) for trace inspector and tools UI.
 */

import { jsonSchemaToTsWithJSDoc } from "@shared/lib/jsonSchema";

export type SchemaViewMode = "ts" | "json";

/** Valid TypeScript identifier for generated interface name (from tool name, etc.) */
export function tsInterfaceNameForTool(toolName: string): string {
  const s = toolName.replace(/[^a-zA-Z0-9_]/g, "_");
  if (s.length === 0) return "ToolParameters";
  return /^[0-9]/.test(s) ? `T_${s}` : s;
}

/** Format schema for display: TS interface or JSON string */
export function formatSchemaForDisplay(
  schema: unknown,
  viewMode: SchemaViewMode,
  interfaceName = "JSONSchema",
): string {
  if (viewMode === "json") {
    return typeof schema === "string" ? schema : JSON.stringify(schema, null, 2);
  }
  const s =
    typeof schema === "string"
      ? (() => {
          try {
            return JSON.parse(schema) as unknown;
          } catch {
            return schema;
          }
        })()
      : schema;
  return typeof s === "object" && s !== null
    ? jsonSchemaToTsWithJSDoc(s as any, interfaceName)
    : String(schema);
}
