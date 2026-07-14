/**
 * JSON Schema to TypeScript (with JSDoc) conversion utilities
 */

/**
 * Convert a JSON Schema object to a TypeScript interface string with JSDoc comments.
 * Extracts description, minimum, maximum, minLength, maxLength, pattern into JSDoc.
 *
 * @param schema - JSON Schema object (e.g. from promptAgent:start or structured output)
 * @param name - Interface name (default: 'Output')
 * @returns TypeScript interface source string
 */
export function jsonSchemaToTsWithJSDoc(schema: any, name = "Output"): string {
  // Extract JSDoc block from schema node (description + constraints)
  const extractJSDoc = (node: any) => {
    const comments: string[] = [];
    if (node.description) comments.push(node.description);
    if (node.minimum !== undefined) comments.push(`@minimum ${node.minimum}`);
    if (node.maximum !== undefined) comments.push(`@maximum ${node.maximum}`);
    if (node.minLength !== undefined) comments.push(`@minLength ${node.minLength}`);
    if (node.maxLength !== undefined) comments.push(`@maxLength ${node.maxLength}`);
    if (node.pattern) comments.push(`@pattern ${node.pattern}`);

    if (comments.length === 0) return "";
    if (comments.length === 1) return `  /** ${comments[0]} */\n`;
    return `  /**\n${comments.map((c) => `   * ${c}`).join("\n")}\n   */\n`;
  };

  // Recursively parse schema node into TypeScript type string
  const parseType = (node: any, indent = "  "): string => {
    if (!node) return "any";

    switch (node.type) {
      case "string":
        return "string";
      case "number":
      case "integer":
        return "number";
      case "boolean":
        return "boolean";
      case "array":
        return `${parseType(node.items, indent)}[]`;
      case "object": {
        if (!node.properties) return "Record<string, any>";
        const props = Object.entries(node.properties).map(([key, val]: [string, any]) => {
          const isRequired = node.required?.includes(key);
          const jsdoc = extractJSDoc(val);
          const field = `${key}${isRequired ? "" : "?"}: ${parseType(val, `${indent}  `)};`;
          return `${jsdoc}${indent}${field}`;
        });
        return `{\n${props.join("\n")}\n${indent.slice(0, -2)}}`;
      }
      default:
        // Handle anyOf, enum, etc. (e.g. from Zod or complex schemas)
        if (node.enum) return node.enum.map((e: any) => `"${e}"`).join(" | ");
        return "any";
    }
  };

  return `interface ${name} ${parseType(schema)}`;
}
