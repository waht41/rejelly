use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use globset::{GlobMatcher, GlobSet};
use serde::{Deserialize, Serialize};

pub type FlowLevels = Vec<Vec<String>>;
pub type ConnectEdges = HashMap<String, Vec<String>>;

#[derive(Debug, Clone, Default)]
pub struct GraphSpec {
    pub cascade: HashMap<String, FlowLevels>,
    pub sequence: HashMap<String, FlowLevels>,
    pub connect: HashMap<String, ConnectEdges>,
}

/// Policy outcome when a rule's `match` succeeds.
///
/// Rules are evaluated in **JSON array order**; the **first** matching rule wins (later rules are ignored).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum EdgeSeverity {
    /// Always forbid the edge when this rule matches (hard gate), regardless of graph topology.
    #[default]
    Error,
    /// Allow with warning when this rule matches (debt downgrade, deprecation, etc.).
    Warn,
    /// Allow with no diagnostic when this rule matches (silence).
    Off,
}

/// When a policy rule participates in edge diagnostics relative to graph topology.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RuleScope {
    /// Match regardless of whether the abstract graph allows the edge (legacy default).
    #[default]
    All,
    /// Only when the graph rejects the edge (e.g. debt waiver / downgrade illegal deps).
    Fallback,
    /// Only when the graph allows the edge (e.g. deprecation warnings on legal architecture).
    TopologyAllowed,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum RuleMatchExpr {
    Single(String),
    Multi(Vec<String>),
}

impl RuleMatchExpr {
    pub fn into_patterns(self) -> Vec<String> {
        match self {
            RuleMatchExpr::Single(p) => vec![p],
            RuleMatchExpr::Multi(ps) => ps,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct RuleMatchSpec {
    #[serde(default)]
    pub from: Option<RuleMatchExpr>,
    #[serde(default)]
    pub to: Option<RuleMatchExpr>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RuleSpec {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    pub r#match: RuleMatchSpec,
    #[serde(default)]
    pub scope: RuleScope,
    #[serde(default)]
    pub severity: EdgeSeverity,
    #[serde(default)]
    pub message: Option<String>,
}

/// Physical repo paths under one node template (`nodes["@id"]` entries that map to globs).
#[derive(Debug, Clone)]
pub(super) struct InternalNodePattern {
    pub(super) id_template: String,
    pub(super) is_exclude: bool,
    pub(super) raw_pattern: String,
    pub(super) path_segments: Vec<String>,
    /// Slash-separated literal prefix before any glob/`[`/`**`; empty means no prefix pruning.
    pub(super) literal_rel_prefix: String,
    pub(super) specificity: usize,
    pub(super) source_root: Option<PathBuf>,
}

/// npm / node built-ins matched by import spec only (orthogonal to internal path globs).
#[derive(Debug, Clone)]
pub(super) struct ExternalDependencyPattern {
    pub(super) id_template: String,
    /// npm package name (no `npm:`), or full string like `node:fs` for built-ins.
    pub(super) external_key: String,
}

#[derive(Debug, Clone)]
pub(super) enum TopologySelector {
    Exact(String),
    Pattern(GlobMatcher),
}

#[derive(Debug, Clone)]
pub(super) struct AbstractEdge {
    pub(super) from: TopologySelector,
    pub(super) to: TopologySelector,
}

#[derive(Debug, Clone, Copy)]
pub(super) enum MatchField {
    Node,
    Path,
}

/// Single rule pattern using `[var]` placeholders (same segment rules as node path mapping).
/// Compiled-only; matching uses `matches_path_segments_collect` + `render_id` for injection.
#[derive(Debug, Clone)]
pub(super) struct PolicyTemplateArm {
    pub(super) field: MatchField,
    pub(super) raw: String,
}

/// One positive pattern in source order (glob without placeholders vs template with `[var]`).
#[derive(Debug, Clone)]
pub(super) enum PolicyIncludeArm {
    Glob {
        field: MatchField,
        matcher: GlobMatcher,
    },
    Template(PolicyTemplateArm),
}

/// Matcher side: ordered positive arms, then folded exclude globs / exclude templates.
#[derive(Debug, Clone)]
pub(super) struct PolicyMatcherSide {
    /// Positive patterns in JSON array order; first matching arm wins for bindings / acceptance.
    pub(super) include_arms: Vec<PolicyIncludeArm>,
    pub(super) node_exclude: Option<GlobSet>,
    pub(super) path_exclude: Option<GlobSet>,
    pub(super) node_exclude_templates: Vec<PolicyTemplateArm>,
    pub(super) path_exclude_templates: Vec<PolicyTemplateArm>,
}

#[derive(Debug, Clone)]
pub(super) struct PolicyRule {
    pub(super) name: Option<String>,
    pub(super) from: Option<PolicyMatcherSide>,
    pub(super) to: Option<PolicyMatcherSide>,
    pub(super) scope: RuleScope,
    pub(super) severity: EdgeSeverity,
    pub(super) message: Option<String>,
}

/// Resolved endpoint for edge checks: template id, instantiated id, and captured `[var]` bindings.
#[derive(Debug, Clone)]
pub struct NodeRef {
    pub template_id: String,
    pub concrete_id: String,
    pub bindings: HashMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedGraph {
    pub(super) internal_patterns_by_node: HashMap<String, Vec<InternalNodePattern>>,
    pub(super) external_dependencies: Vec<ExternalDependencyPattern>,
    pub(super) abstract_edges: Vec<AbstractEdge>,
    pub(super) policy_rules: Vec<PolicyRule>,
    pub(super) node_keys: HashSet<String>,
    pub(super) startup_warnings: Vec<String>,
    /// Memoized `resolve_internal_by_rel_path` keyed by normalized relative path (slash-separated).
    pub(super) internal_resolve_cache: Arc<Mutex<HashMap<String, Option<NodeRef>>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EdgeCheckResult {
    Allowed,
    AllowedWithWarn(String),
    Forbidden,
}

#[derive(Debug, Clone)]
pub struct EdgeCheckDetail {
    pub result: EdgeCheckResult,
    pub rule_name: Option<String>,
    pub rule_message: Option<String>,
}
