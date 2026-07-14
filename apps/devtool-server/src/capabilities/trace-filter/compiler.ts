import {
  and,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  not,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type {
  BuiltinFilter,
  BuiltinFilterKey,
  CostFilter,
  ModelUsageFilter,
  RootAttrFilter,
  ToolExecutionFilter,
  ToolExecutionFilterField,
  TraceFilterNode,
  TraceFilterValue,
} from "./ast";

type TraceAttrColumns = {
  valueType: SQLiteColumn;
  valueText: SQLiteColumn;
  valueNum: SQLiteColumn;
};

export type TraceFilterCompilerDeps = {
  builtinColumns: Record<BuiltinFilterKey, SQLiteColumn>;
  rootAttrs: TraceAttrColumns;
  rootAttrExists: (key: string, valueCondition?: SQL) => SQL;
  modelUsageJson: SQLiteColumn;
  costJson: SQLiteColumn;
  toolExecutionsJson: SQLiteColumn;
};

function encodeAttrValue(value: TraceFilterValue): {
  valueType: string;
  valueText: string | null;
  valueNum: number | null;
} {
  if (value === null) return { valueType: "null", valueText: null, valueNum: null };
  if (typeof value === "boolean")
    return { valueType: "boolean", valueText: String(value), valueNum: null };
  if (typeof value === "number")
    return { valueType: "number", valueText: String(value), valueNum: value };
  return { valueType: "string", valueText: value, valueNum: null };
}

const ORDERING_OPS = { gt, gte, lt, lte } as const;

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function createTraceFilterCompiler(deps: TraceFilterCompilerDeps) {
  function attrValueEq(value: TraceFilterValue): SQL {
    const encoded = encodeAttrValue(value);
    const conditions = [eq(deps.rootAttrs.valueType, encoded.valueType)];
    // value_text is NULL by construction for "null" type, so valueType match suffices.
    if (encoded.valueType === "number") {
      conditions.push(eq(deps.rootAttrs.valueNum, encoded.valueNum!));
    } else if (encoded.valueText !== null) {
      conditions.push(eq(deps.rootAttrs.valueText, encoded.valueText));
    }
    return and(...conditions)!;
  }

  function compileRootAttrFilter(node: RootAttrFilter): SQL {
    const { key, op } = node;
    if (op === "exists") {
      return deps.rootAttrExists(key);
    }

    const value = node.value;
    if (value === undefined) {
      throw new Error(`Unsupported trace filter: "${op}" on root attribute requires a value`);
    }

    switch (op) {
      case "eq":
        return deps.rootAttrExists(key, attrValueEq(value));
      case "neq":
        // Semantics: the attribute exists and holds a different value.
        return deps.rootAttrExists(key, not(attrValueEq(value)));
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        const cmp = ORDERING_OPS[op];
        if (typeof value === "number") {
          return deps.rootAttrExists(
            key,
            and(eq(deps.rootAttrs.valueType, "number"), cmp(deps.rootAttrs.valueNum, value))!,
          );
        }
        if (typeof value === "string") {
          return deps.rootAttrExists(
            key,
            and(eq(deps.rootAttrs.valueType, "string"), cmp(deps.rootAttrs.valueText, value))!,
          );
        }
        throw new Error(`Unsupported trace filter: "${op}" requires a number or string value`);
      }
      case "contains": {
        if (typeof value !== "string") {
          throw new Error('Unsupported trace filter: "contains" requires a string value');
        }
        const pattern = `%${escapeLikePattern(value)}%`;
        return deps.rootAttrExists(
          key,
          and(
            eq(deps.rootAttrs.valueType, "string"),
            sql`${deps.rootAttrs.valueText} LIKE ${pattern} ESCAPE '\\'`,
          )!,
        );
      }
      default:
        throw new Error(`Unsupported trace filter: operator "${op}"`);
    }
  }

  function compileBuiltinFilter(node: BuiltinFilter): SQL {
    const column = deps.builtinColumns[node.key];
    if (!column) {
      throw new Error(`Unsupported trace filter: unknown builtin key "${node.key}"`);
    }

    const { op } = node;
    if (op === "exists") {
      return isNotNull(column);
    }

    const { value } = node;
    switch (op) {
      case "eq":
        return value === null ? isNull(column) : eq(column, value);
      case "neq":
        // SQL semantics: NULL rows do not match "neq"; use eq null / not for NULL handling.
        return value === null ? isNotNull(column) : ne(column, value);
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        if (typeof value !== "number" && typeof value !== "string") {
          throw new Error(`Unsupported trace filter: "${op}" requires a number or string value`);
        }
        return ORDERING_OPS[op](column, value);
      }
      case "contains": {
        if (typeof value !== "string") {
          throw new Error('Unsupported trace filter: "contains" requires a string value');
        }
        const pattern = `%${escapeLikePattern(value)}%`;
        return sql`${column} LIKE ${pattern} ESCAPE '\\'`;
      }
      default:
        throw new Error(`Unsupported trace filter: operator "${op}"`);
    }
  }

  function compileModelUsageCountCondition(
    op: Exclude<ModelUsageFilter["op"], "exists">,
    value: number,
  ) {
    const count = sql`CAST(json_extract(model_usage.value, '$.count') AS REAL)`;
    switch (op) {
      case "eq":
        return sql`${count} = ${value}`;
      case "neq":
        return sql`${count} != ${value}`;
      case "gt":
        return sql`${count} > ${value}`;
      case "gte":
        return sql`${count} >= ${value}`;
      case "lt":
        return sql`${count} < ${value}`;
      case "lte":
        return sql`${count} <= ${value}`;
      default:
        throw new Error(`Unsupported trace filter: model_usage operator "${op}"`);
    }
  }

  function compileModelUsageFilter(node: ModelUsageFilter): SQL {
    const countCondition =
      node.op === "exists" ? undefined : compileModelUsageCountCondition(node.op, node.value);

    return sql`EXISTS (
      SELECT 1
      FROM json_each(${deps.modelUsageJson}) AS model_usage
      WHERE model_usage.key = ${node.model}
      ${countCondition ? sql`AND ${countCondition}` : sql``}
    )`;
  }

  function compileCostValueCondition(op: Exclude<CostFilter["op"], "exists">, value: number) {
    const costValue = sql`CAST(cost_usage.value AS REAL)`;
    switch (op) {
      case "eq":
        return sql`${costValue} = ${value}`;
      case "neq":
        return sql`${costValue} != ${value}`;
      case "gt":
        return sql`${costValue} > ${value}`;
      case "gte":
        return sql`${costValue} >= ${value}`;
      case "lt":
        return sql`${costValue} < ${value}`;
      case "lte":
        return sql`${costValue} <= ${value}`;
      default:
        throw new Error(`Unsupported trace filter: cost operator "${op}"`);
    }
  }

  function compileCostFilter(node: CostFilter): SQL {
    const valueCondition =
      node.op === "exists" ? undefined : compileCostValueCondition(node.op, node.value);

    return sql`EXISTS (
      SELECT 1
      FROM json_each(${deps.costJson}) AS cost_usage
      WHERE cost_usage.key = ${node.unit}
      ${valueCondition ? sql`AND ${valueCondition}` : sql``}
    )`;
  }

  function getToolExecutionFieldPath(field: ToolExecutionFilterField): string {
    switch (field) {
      case "callCount":
      case "successCount":
      case "failureCount":
      case "totalOutputChars":
        return `$.${field}`;
      default:
        throw new Error(`Unsupported trace filter: tool_execution field "${field}"`);
    }
  }

  function compileToolExecutionValueCondition(
    field: ToolExecutionFilterField,
    op: Exclude<ToolExecutionFilter["op"], "exists">,
    value: number,
  ) {
    const toolExecutionValue = sql`CAST(json_extract(tool_execution.value, ${getToolExecutionFieldPath(
      field,
    )}) AS REAL)`;
    switch (op) {
      case "eq":
        return sql`${toolExecutionValue} = ${value}`;
      case "neq":
        return sql`${toolExecutionValue} != ${value}`;
      case "gt":
        return sql`${toolExecutionValue} > ${value}`;
      case "gte":
        return sql`${toolExecutionValue} >= ${value}`;
      case "lt":
        return sql`${toolExecutionValue} < ${value}`;
      case "lte":
        return sql`${toolExecutionValue} <= ${value}`;
      default:
        throw new Error(`Unsupported trace filter: tool_execution operator "${op}"`);
    }
  }

  function compileToolExecutionFilter(node: ToolExecutionFilter): SQL {
    const valueCondition =
      node.op === "exists"
        ? undefined
        : compileToolExecutionValueCondition(node.field, node.op, node.value);

    return sql`EXISTS (
      SELECT 1
      FROM json_each(${deps.toolExecutionsJson}) AS tool_execution
      WHERE tool_execution.key = ${node.tool}
      ${valueCondition ? sql`AND ${valueCondition}` : sql``}
    )`;
  }

  return function compileTraceFilterNode(node: TraceFilterNode): SQL {
    switch (node.kind) {
      case "and": {
        if (node.filters.length === 0) {
          throw new Error('Unsupported trace filter: empty "and" group');
        }
        return and(...node.filters.map(compileTraceFilterNode))!;
      }
      case "or": {
        if (node.filters.length === 0) {
          throw new Error('Unsupported trace filter: empty "or" group');
        }
        return or(...node.filters.map(compileTraceFilterNode))!;
      }
      case "not":
        return not(compileTraceFilterNode(node.filter));
      case "root_attr":
        return compileRootAttrFilter(node);
      case "builtin":
        return compileBuiltinFilter(node);
      case "model_usage":
        return compileModelUsageFilter(node);
      case "cost":
        return compileCostFilter(node);
      case "tool_execution":
        return compileToolExecutionFilter(node);
      default:
        throw new Error(
          `Unsupported trace filter: unknown kind "${String((node as { kind?: unknown }).kind)}"`,
        );
    }
  };
}
