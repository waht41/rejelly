/**
 * JellyLint pure graph DSL — mirrors jellylint.schema.json and Rust JellyLintFile.
 */

/** Node selector: exact id, glob id (e.g. @core:**), or bracket vars per schema */
export type TargetNode = string;

/** One cascade/sequence dimension: list of levels, each level is non-empty node list */
export type FlowLevelRow = TargetNode[];

export type FlowLevels = FlowLevelRow[] | Record<string, FlowLevelRow[]>;

/** connect: flat map from node to allowed targets */
export type ConnectEdges = Record<string, TargetNode[]>;

/** connect: named groups of edge maps */
export type ConnectNamed = Record<string, ConnectEdges>;

export type ConnectSpec = ConnectEdges | ConnectNamed;

export interface GraphBlock {
  cascade?: FlowLevels;
  sequence?: FlowLevels;
  connect?: ConnectSpec;
}

/**
 * Either a single flat/subgraph block, or named subgraphs (each value is a GraphBlock).
 */
export type GraphSpec = GraphBlock | Record<string, GraphBlock>;

/** Single template or ordered fallback templates */
export type NodePathSpec = string | string[];

export type JellyLintNodes = Record<string, NodePathSpec>;

/** Glob patterns, or `[name]` placeholders (filled from `from` match; cross-edge unification). */
export type RuleMatcher = string | string[];

export interface RuleMatch {
  from?: RuleMatcher;
  to?: RuleMatcher;
}

/**
 * - `error` (default if omitted): forbid when matched (hard gate), regardless of graph.
 * - `warn`: allow with warning when matched.
 * - `off`: allow with no diagnostic when matched.
 */
export type EdgePolicySeverity = "error" | "warn" | "off";

/** When rule evaluation is gated on graph topology (`abstract_topology_allows`). */
export type RuleScope = "all" | "fallback" | "topology_allowed";

export interface RuleSpec {
  name?: string;
  description?: string;
  /**
   * - `all` (default): always evaluate `match`.
   * - `fallback`: only when the graph denies the edge (illegal / binding mismatch).
   * - `topology_allowed`: only when the graph allows the edge (e.g. deprecate legal `@feature` → `@legacy` without turning illegal edges into warn).
   *
   * Rules run in **array order**; the first rule whose `scope` and `match` apply wins for that edge. Put narrow `error` gates before broad `fallback` / `warn` catch-alls.
   */
  scope?: RuleScope;
  match: RuleMatch;
  severity?: EdgePolicySeverity;
  message?: string;
}

export interface JellyLintConfig {
  nodes: JellyLintNodes;
  graph: GraphSpec;
  rules?: RuleSpec[];
}

export default JellyLintConfig;
