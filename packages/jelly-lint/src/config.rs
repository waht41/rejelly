//! JellyLint config from `jellylint.json[c]` (JSON with comments).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::graph::{build_graph, collect_source_roots, GraphSpec, ResolvedGraph, RuleSpec};

/// Loaded `jellylint.json[c]` ready for lint passes.
#[derive(Debug, Clone)]
pub struct ResolvedConfig {
    pub cwd: PathBuf,
    pub graph: ResolvedGraph,
    /// Absolute roots discovered from internal node patterns.
    pub source_roots: Vec<PathBuf>,
    pub startup_warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct JellyLintFile {
    #[serde(default, rename = "nodePolicies")]
    node_policies: BTreeMap<String, NodePolicySpec>,
    #[serde(default)]
    nodes: HashMap<String, NodePathSpec>,
    graph: serde_json::Value,
    #[serde(default)]
    rules: Vec<RuleSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct NodePolicySpec {
    #[serde(default)]
    default: bool,
    exclude: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum PatternSpec {
    Single(String),
    Multi(Vec<String>),
}

impl PatternSpec {
    fn into_patterns(self) -> Vec<String> {
        match self {
            PatternSpec::Single(s) => vec![s],
            PatternSpec::Multi(v) => v,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct NodePathObjectSpec {
    patterns: PatternSpec,
    #[serde(default)]
    policies: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum NodePathSpec {
    Single(String),
    Multi(Vec<String>),
    Object(NodePathObjectSpec),
}

impl NodePathSpec {
    fn into_parts(self) -> (Vec<String>, Vec<String>) {
        match self {
            NodePathSpec::Single(s) => (vec![s], Vec::new()),
            NodePathSpec::Multi(v) => (v, Vec::new()),
            NodePathSpec::Object(spec) => (spec.patterns.into_patterns(), spec.policies),
        }
    }
}

fn is_external_pattern(pattern: &str) -> bool {
    let value = pattern.strip_prefix('!').unwrap_or(pattern);
    value.starts_with("npm:") || value.starts_with("node:")
}

fn expand_node_patterns(
    file_nodes: HashMap<String, NodePathSpec>,
    policies: &BTreeMap<String, NodePolicySpec>,
    source_name: &str,
) -> Result<HashMap<String, Vec<String>>, String> {
    for (name, policy) in policies {
        if name.is_empty() || name.starts_with('!') {
            return Err(format!(
                "{source_name}: node policy names must be non-empty and must not start with `!`: {name:?}"
            ));
        }
        if policy.exclude.is_empty() {
            return Err(format!(
                "{source_name}: node policy {name:?} must contain at least one exclusion"
            ));
        }
        for pattern in &policy.exclude {
            if pattern.is_empty() || pattern.starts_with('!') {
                return Err(format!(
                    "{source_name}: node policy {name:?} exclusion must be a non-negated path pattern: {pattern:?}"
                ));
            }
        }
    }

    let default_policies: HashSet<&str> = policies
        .iter()
        .filter_map(|(name, policy)| policy.default.then_some(name.as_str()))
        .collect();
    let mut nodes = HashMap::with_capacity(file_nodes.len());

    for (node_id, spec) in file_nodes {
        let (mut patterns, references) = spec.into_parts();
        let has_internal_pattern = patterns.iter().any(|pattern| !is_external_pattern(pattern));
        if !has_internal_pattern && !references.is_empty() {
            return Err(format!(
                "{source_name}: external-only node {node_id:?} cannot reference node policies"
            ));
        }

        let mut active: HashSet<&str> = if has_internal_pattern {
            default_policies.clone()
        } else {
            HashSet::new()
        };
        let mut seen: HashMap<&str, bool> = HashMap::new();
        for reference in &references {
            let (disabled, name) = match reference.strip_prefix('!') {
                Some(name) => (true, name),
                None => (false, reference.as_str()),
            };
            if name.is_empty() {
                return Err(format!(
                    "{source_name}: node {node_id:?} contains an empty node policy reference"
                ));
            }
            if !policies.contains_key(name) {
                return Err(format!(
                    "{source_name}: node {node_id:?} references unknown node policy {name:?}"
                ));
            }
            if let Some(previously_disabled) = seen.insert(name, disabled) {
                let problem = if previously_disabled == disabled {
                    "duplicates"
                } else {
                    "both enables and disables"
                };
                return Err(format!(
                    "{source_name}: node {node_id:?} {problem} node policy {name:?}"
                ));
            }
            if disabled {
                active.remove(name);
            } else {
                active.insert(name);
            }
        }

        let mut active_names: Vec<&str> = active.into_iter().collect();
        active_names.sort_unstable();
        for name in active_names {
            patterns.extend(
                policies[name]
                    .exclude
                    .iter()
                    .map(|pattern| format!("!{pattern}")),
            );
        }
        let mut unique = HashSet::new();
        patterns.retain(|pattern| unique.insert(pattern.clone()));
        nodes.insert(node_id, patterns);
    }

    Ok(nodes)
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
struct GraphBlockSpec {
    cascade: Option<FlowSpec>,
    sequence: Option<FlowSpec>,
    connect: Option<ConnectSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum FlowSpec {
    Direct(Vec<Vec<String>>),
    Named(HashMap<String, Vec<Vec<String>>>),
}

impl FlowSpec {
    fn into_named_flows(self) -> HashMap<String, Vec<Vec<String>>> {
        match self {
            FlowSpec::Direct(levels) => HashMap::from([("default".to_string(), levels)]),
            FlowSpec::Named(flows) => flows,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum ConnectSpec {
    Direct(HashMap<String, Vec<String>>),
    Named(HashMap<String, HashMap<String, Vec<String>>>),
}

impl ConnectSpec {
    fn into_named_flows(self) -> HashMap<String, HashMap<String, Vec<String>>> {
        match self {
            ConnectSpec::Direct(edges) => HashMap::from([("default".to_string(), edges)]),
            ConnectSpec::Named(groups) => groups,
        }
    }
}

fn graph_block_to_spec(block: GraphBlockSpec) -> GraphSpec {
    GraphSpec {
        cascade: block
            .cascade
            .map(FlowSpec::into_named_flows)
            .unwrap_or_default(),
        sequence: block
            .sequence
            .map(FlowSpec::into_named_flows)
            .unwrap_or_default(),
        connect: block
            .connect
            .map(ConnectSpec::into_named_flows)
            .unwrap_or_default(),
    }
}

fn parse_graph_specs(
    value: serde_json::Value,
    source_name: &str,
) -> Result<HashMap<String, GraphSpec>, String> {
    let serde_json::Value::Object(obj) = value else {
        return Err(format!("{source_name}: `graph` must be an object"));
    };

    let is_flat_graph =
        obj.contains_key("cascade") || obj.contains_key("sequence") || obj.contains_key("connect");
    if is_flat_graph {
        let block: GraphBlockSpec = serde_json::from_value(serde_json::Value::Object(obj))
            .map_err(|e| format!("{source_name}: parse graph: {e}"))?;
        return Ok(HashMap::from([(
            "default".to_string(),
            graph_block_to_spec(block),
        )]));
    }

    let mut out = HashMap::new();
    for (subgraph_name, subgraph_value) in obj {
        let block: GraphBlockSpec = serde_json::from_value(subgraph_value)
            .map_err(|e| format!("{source_name}: parse graph.{subgraph_name}: {e}"))?;
        out.insert(subgraph_name, graph_block_to_spec(block));
    }
    Ok(out)
}

fn default_jellylint_path(cwd: &Path) -> Option<PathBuf> {
    let candidates = ["jellylint.json", "jellylint.jsonc"];

    for name in candidates {
        let p = cwd.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn strip_json_comments_owned(mut raw: String) -> Result<String, String> {
    json_strip_comments::strip(&mut raw).map_err(|e| format!("strip JSON comments: {e}"))?;
    Ok(raw)
}

pub fn resolve_config(
    cwd: &Path,
    config_override: Option<&Path>,
) -> Result<ResolvedConfig, String> {
    let path = match config_override {
        Some(p) => p.to_path_buf(),
        None => default_jellylint_path(cwd).ok_or_else(|| {
            format!(
                "missing JellyLint config under {} (create jellylint.json or jellylint.jsonc, or pass --config)",
                cwd.display()
            )
        })?,
    };
    if !path.is_file() {
        return Err(format!(
            "missing JellyLint config: {} (create jellylint.json / jellylint.jsonc or pass --config)",
            path.display()
        ));
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let stripped = strip_json_comments_owned(raw)?;
    let file: JellyLintFile =
        serde_json::from_str(&stripped).map_err(|e| format!("parse {}: {e}", path.display()))?;
    let JellyLintFile {
        node_policies,
        nodes: file_nodes,
        graph: file_graph,
        rules,
    } = file;
    let cwd = cwd.to_path_buf();
    let source_name = path.display().to_string();
    let nodes = expand_node_patterns(file_nodes, &node_policies, &source_name)?;
    let graph_specs = parse_graph_specs(file_graph, &source_name)?;
    let graph = build_graph(&cwd, &nodes, &graph_specs, rules, &source_name)?;
    let source_roots = collect_source_roots(&graph);

    Ok(ResolvedConfig {
        cwd,
        startup_warnings: graph.startup_warnings().to_vec(),
        graph,
        source_roots,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn example_jsonc_strips_comments_and_parses() {
        let raw = include_str!("../example.jellylint.jsonc").to_string();
        let stripped = strip_json_comments_owned(raw).expect("strip");
        let file: JellyLintFile = serde_json::from_str(&stripped).expect("parse");
        assert!(!file.nodes.is_empty());
    }

    #[test]
    fn graph_dsl_parses_from_json() {
        let raw = r#"{"nodes":{"@app:[name]":"src/apps/[name]/**/*","@ext:react":"npm:react"},"graph":{"connect":{"@app:[name]":["@ext:react"]}}}"#;
        let file: JellyLintFile = serde_json::from_str(raw).expect("parse");
        let graphs = parse_graph_specs(file.graph, "test").expect("graph parse");
        let graph = graphs.get("default").expect("default graph");
        assert_eq!(file.nodes.len(), 2);
        assert_eq!(graph.connect.get("default").map(|m| m.len()), Some(1));
    }

    #[test]
    fn graph_dsl_parses_node_pattern_array() {
        let raw = r#"{"nodes":{"@page:[page]":["src/pages/[page].*","src/pages/[page]/**/*"]},"graph":{"cascade":[["@page:[page]"]]}}"#;
        let file: JellyLintFile = serde_json::from_str(raw).expect("parse");
        assert_eq!(file.nodes.len(), 1);
    }

    #[test]
    fn graph_dsl_rejects_target_metadata_in_pure_graph() {
        let raw = r#"{
            "nodes": {
                "@feature:[feat]": "src/features/[feat]/**/*",
                "@core:**": "src/core/**/*",
                "@legacy:**": "src/legacy/**/*"
            },
            "graph": {
                "connect": {
                    "@feature:[feat]": [
                        "@core:**",
                        { "node": "@legacy:**", "severity": "warn", "message": "legacy deprecating" }
                    ]
                },
                "cascade": [
                    ["@feature:[feat]"],
                    [{ "node": "@core:**" }]
                ]
            }
        }"#;
        let file: JellyLintFile = serde_json::from_str(raw).expect("parse");
        let parsed = parse_graph_specs(file.graph, "test");
        assert!(parsed.is_err());
    }

    #[test]
    fn rules_parse_with_poly_matchers() {
        let raw = r#"{
            "nodes": {
                "@feature:[feat]": "src/features/[feat]/**/*",
                "@core:engine": "src/core/engine/**/*"
            },
            "graph": {
                "connect": {
                    "@feature:[feat]": ["@core:engine"]
                }
            },
            "rules": [
                {
                    "name": "debt-gate",
                    "description": "temporary migration debt list",
                    "match": {
                        "from": ["@feature:*", "!@feature:demo"],
                        "to": ["@core:*", "src/legacy/**/*"]
                    },
                    "severity": "warn",
                    "message": "tracked by debt issue"
                }
            ]
        }"#;
        let file: JellyLintFile = serde_json::from_str(raw).expect("parse");
        assert_eq!(file.rules.len(), 1);
        assert_eq!(file.rules[0].name.as_deref(), Some("debt-gate"));
    }

    #[test]
    fn graph_dsl_parses_subgraph_with_direct_flow() {
        let raw = r#"{
            "nodes": {
                "@admin:app": "src/admin/app/**/*",
                "@admin:page": "src/admin/page/**/*",
                "@ui:**": "src/ui/**/*"
            },
            "graph": {
                "admin_panel": {
                    "cascade": [
                        ["@admin:app"],
                        ["@admin:page"],
                        ["@ui:**"]
                    ]
                }
            }
        }"#;
        let file: JellyLintFile = serde_json::from_str(raw).expect("parse");
        let graphs = parse_graph_specs(file.graph, "test").expect("graph parse");
        let graph = graphs.get("admin_panel").expect("admin_panel graph");
        assert_eq!(
            graph.cascade.get("default").map(|levels| levels.len()),
            Some(3)
        );
    }

    #[test]
    fn graph_dsl_parses_subgraph_with_named_flow() {
        let raw = r#"{
            "nodes": {
                "@app:**": "src/app/**/*",
                "@page:**": "src/page/**/*",
                "@ui:**": "src/ui/**/*",
                "@store:**": "src/store/**/*",
                "@action:**": "src/action/**/*",
                "@api:**": "src/api/**/*"
            },
            "graph": {
                "frontend_core": {
                    "cascade": {
                        "render_flow": [
                            ["@app:**"],
                            ["@page:**"],
                            ["@ui:**"]
                        ],
                        "state_management_flow": [
                            ["@store:**"],
                            ["@action:**"],
                            ["@api:**"]
                        ]
                    }
                }
            }
        }"#;
        let file: JellyLintFile = serde_json::from_str(raw).expect("parse");
        let graphs = parse_graph_specs(file.graph, "test").expect("graph parse");
        let graph = graphs.get("frontend_core").expect("frontend_core graph");
        assert_eq!(graph.cascade.len(), 2);
        assert_eq!(
            graph.cascade.get("render_flow").map(|levels| levels.len()),
            Some(3)
        );
        assert_eq!(
            graph
                .cascade
                .get("state_management_flow")
                .map(|levels| levels.len()),
            Some(3)
        );
    }

    fn expanded_nodes(raw: &str) -> Result<HashMap<String, Vec<String>>, String> {
        let file: JellyLintFile = serde_json::from_str(raw).expect("parse");
        expand_node_patterns(file.nodes, &file.node_policies, "test")
    }

    #[test]
    fn node_policies_apply_defaults_and_node_set_modifiers() {
        let raw = r#"{
            "nodePolicies": {
                "production": {
                    "default": true,
                    "exclude": ["src/**/__tests__/**/*", "src/**/*.test.*"]
                },
                "generated": {
                    "exclude": ["src/**/*.generated.*", "src/**/*.test.*"]
                }
            },
            "nodes": {
                "@app": {
                    "patterns": "src/app/**/*",
                    "policies": ["generated"]
                },
                "@spec:tests": {
                    "patterns": ["src/**/__tests__/**/*", "src/**/*.test.*"],
                    "policies": ["!production"]
                },
                "@ext:react": "npm:react"
            },
            "graph": {}
        }"#;
        let nodes = expanded_nodes(raw).expect("expand");
        assert_eq!(
            nodes["@app"],
            vec![
                "src/app/**/*",
                "!src/**/*.generated.*",
                "!src/**/*.test.*",
                "!src/**/__tests__/**/*",
            ]
        );
        assert_eq!(
            nodes["@spec:tests"],
            vec!["src/**/__tests__/**/*", "src/**/*.test.*"]
        );
        assert_eq!(nodes["@ext:react"], vec!["npm:react"]);
    }

    #[test]
    fn node_policies_reject_unknown_duplicate_and_conflicting_references() {
        for (policies, expected) in [
            (r#"["missing"]"#, "unknown node policy"),
            (r#"["production", "production"]"#, "duplicates node policy"),
            (
                r#"["production", "!production"]"#,
                "both enables and disables node policy",
            ),
        ] {
            let raw = format!(
                r#"{{
                    "nodePolicies": {{
                        "production": {{ "exclude": ["src/**/*.test.*"] }}
                    }},
                    "nodes": {{
                        "@app": {{ "patterns": "src/app/**/*", "policies": {policies} }}
                    }},
                    "graph": {{}}
                }}"#
            );
            let error = expanded_nodes(&raw).expect_err("invalid policy reference");
            assert!(error.contains(expected), "unexpected error: {error}");
        }
    }

    #[test]
    fn node_policies_reject_invalid_definitions_and_external_references() {
        let invalid_exclusion = r#"{
            "nodePolicies": {
                "production": { "exclude": ["!src/**/*.test.*"] }
            },
            "nodes": { "@app": "src/app/**/*" },
            "graph": {}
        }"#;
        assert!(expanded_nodes(invalid_exclusion)
            .expect_err("invalid exclusion")
            .contains("must be a non-negated path pattern"));

        let external_reference = r#"{
            "nodePolicies": {
                "production": { "exclude": ["src/**/*.test.*"] }
            },
            "nodes": {
                "@ext:react": { "patterns": "npm:react", "policies": ["production"] }
            },
            "graph": {}
        }"#;
        assert!(expanded_nodes(external_reference)
            .expect_err("external policy reference")
            .contains("external-only node"));
    }
}
