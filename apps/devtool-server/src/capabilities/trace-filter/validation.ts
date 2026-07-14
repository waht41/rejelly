/**
 * Trace filter AST structural validation.
 *
 * Single implementation shared by the HTTP controller (request validation)
 * and the filter agent (expectValidator on generated ASTs).
 */

import { BUILTIN_FILTER_KEYS, TOOL_EXECUTION_FILTER_FIELDS, type TraceFilterNode } from "./ast";

const FILTER_OPS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "contains", "exists"]);
const MODEL_USAGE_OPS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "exists"]);
const COST_OPS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "exists"]);
const TOOL_EXECUTION_OPS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "exists"]);
const BUILTIN_KEYS = new Set<string>(BUILTIN_FILTER_KEYS);
const TOOL_EXECUTION_FIELDS = new Set<string>(TOOL_EXECUTION_FILTER_FIELDS);

export const MAX_FILTER_DEPTH = 10;
export const MAX_GROUP_SIZE = 20;

function isFilterValue(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/**
 * Validate one AST node. Returns true, or an error message describing the
 * first problem found (suitable for feeding back to an LLM retry loop).
 */
export function validateFilterNode(node: unknown, depth = 1): true | string {
  if (depth > MAX_FILTER_DEPTH) return `filter nesting exceeds max depth ${MAX_FILTER_DEPTH}`;
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return "filter node must be an object";
  }
  const candidate = node as Record<string, unknown>;

  switch (candidate.kind) {
    case "and":
    case "or": {
      if (!Array.isArray(candidate.filters) || candidate.filters.length === 0) {
        return `"${candidate.kind}" node requires a non-empty "filters" array`;
      }
      if (candidate.filters.length > MAX_GROUP_SIZE) {
        return `"${candidate.kind}" group exceeds max size ${MAX_GROUP_SIZE}`;
      }
      for (const child of candidate.filters) {
        const result = validateFilterNode(child, depth + 1);
        if (result !== true) return result;
      }
      return true;
    }
    case "not":
      return validateFilterNode(candidate.filter, depth + 1);
    case "root_attr": {
      if (typeof candidate.key !== "string" || candidate.key.length === 0) {
        return '"root_attr" node requires a non-empty string "key"';
      }
      if (typeof candidate.op !== "string" || !FILTER_OPS.has(candidate.op)) {
        return `"root_attr" op must be one of: ${[...FILTER_OPS].join(", ")}`;
      }
      if (candidate.op === "exists") {
        return candidate.value === undefined ? true : '"exists" op must not carry a "value" field';
      }
      return isFilterValue(candidate.value)
        ? true
        : `"root_attr" value must be string/number/boolean/null (key "${candidate.key}")`;
    }
    case "builtin": {
      if (typeof candidate.key !== "string" || !BUILTIN_KEYS.has(candidate.key)) {
        return `"builtin" key must be one of: ${BUILTIN_FILTER_KEYS.join(", ")}`;
      }
      if (typeof candidate.op !== "string" || !FILTER_OPS.has(candidate.op)) {
        return '"builtin" op must be one of: eq, neq, gt, gte, lt, lte, contains, exists';
      }
      if (candidate.op === "exists") {
        return candidate.value === undefined ? true : '"exists" op must not carry a "value" field';
      }
      return isFilterValue(candidate.value)
        ? true
        : `"builtin" value must be string/number/boolean/null (key "${candidate.key}")`;
    }
    case "model_usage": {
      if (typeof candidate.model !== "string" || candidate.model.length === 0) {
        return '"model_usage" node requires a non-empty string "model"';
      }
      if (typeof candidate.op !== "string" || !MODEL_USAGE_OPS.has(candidate.op)) {
        return '"model_usage" op must be one of: eq, neq, gt, gte, lt, lte, exists';
      }
      if (candidate.op === "exists") {
        if (candidate.field !== undefined || candidate.value !== undefined) {
          return '"model_usage" exists op must not carry "field" or "value" fields';
        }
        return true;
      }
      if (candidate.field !== "count") {
        return '"model_usage" comparison requires field "count"';
      }
      return typeof candidate.value === "number" && Number.isFinite(candidate.value)
        ? true
        : `"model_usage" count comparison requires a finite number value (model "${candidate.model}")`;
    }
    case "cost": {
      if (typeof candidate.unit !== "string" || candidate.unit.length === 0) {
        return '"cost" node requires a non-empty string "unit"';
      }
      if (typeof candidate.op !== "string" || !COST_OPS.has(candidate.op)) {
        return '"cost" op must be one of: eq, neq, gt, gte, lt, lte, exists';
      }
      if (candidate.op === "exists") {
        return candidate.value === undefined
          ? true
          : '"cost" exists op must not carry a "value" field';
      }
      return typeof candidate.value === "number" && Number.isFinite(candidate.value)
        ? true
        : `"cost" comparison requires a finite number value (unit "${candidate.unit}")`;
    }
    case "tool_execution": {
      if (typeof candidate.tool !== "string" || candidate.tool.length === 0) {
        return '"tool_execution" node requires a non-empty string "tool"';
      }
      if (typeof candidate.op !== "string" || !TOOL_EXECUTION_OPS.has(candidate.op)) {
        return '"tool_execution" op must be one of: eq, neq, gt, gte, lt, lte, exists';
      }
      if (candidate.op === "exists") {
        if (candidate.field !== undefined || candidate.value !== undefined) {
          return '"tool_execution" exists op must not carry "field" or "value" fields';
        }
        return true;
      }
      if (typeof candidate.field !== "string" || !TOOL_EXECUTION_FIELDS.has(candidate.field)) {
        return `"tool_execution" comparison field must be one of: ${TOOL_EXECUTION_FILTER_FIELDS.join(
          ", ",
        )}`;
      }
      return typeof candidate.value === "number" && Number.isFinite(candidate.value)
        ? true
        : `"tool_execution" comparison requires a finite number value (tool "${candidate.tool}")`;
    }
    default:
      return `unknown filter kind "${String(
        candidate.kind,
      )}" (expected root_attr/builtin/model_usage/cost/tool_execution/and/or/not)`;
  }
}

export function isValidFilterNode(node: unknown, depth = 1): node is TraceFilterNode {
  return validateFilterNode(node, depth) === true;
}
