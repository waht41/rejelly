export interface TraceFilterAttrCatalogEntry {
  key: string;
  valueType: string;
  count: number;
  samples: string | null;
}

export interface TraceFilterModelCatalogEntry {
  model: string;
  traceCount: number;
  callCount: number;
}

export interface TraceFilterCostCatalogEntry {
  unit: string;
  traceCount: number;
  totalValue: number;
}

export interface TraceFilterToolExecutionCatalogEntry {
  tool: string;
  traceCount: number;
  callCount: number;
  successCount: number;
  failureCount: number;
  totalOutputChars: number;
}

export interface TraceFilterCatalog {
  attributes: TraceFilterAttrCatalogEntry[];
  models: TraceFilterModelCatalogEntry[];
  costs: TraceFilterCostCatalogEntry[];
  toolExecutions: TraceFilterToolExecutionCatalogEntry[];
}

export const EMPTY_TRACE_FILTER_CATALOG: TraceFilterCatalog = {
  attributes: [],
  models: [],
  costs: [],
  toolExecutions: [],
};

export function createTraceFilterCatalog({
  attributes = [],
  models = [],
  costs = [],
  toolExecutions = [],
}: Partial<TraceFilterCatalog> = {}): TraceFilterCatalog {
  return {
    attributes,
    models,
    costs,
    toolExecutions,
  };
}
