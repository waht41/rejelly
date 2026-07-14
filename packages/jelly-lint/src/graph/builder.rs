use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use globset::{Glob, GlobSet, GlobSetBuilder};

use super::data::{
    AbstractEdge, ExternalDependencyPattern, FlowLevels, GraphSpec, InternalNodePattern, MatchField,
    PolicyIncludeArm, PolicyMatcherSide, PolicyRule, PolicyTemplateArm, ResolvedGraph, RuleMatchExpr,
    RuleSpec, TopologySelector,
};
use super::error::GraphBuildError;
use super::overlap::detect_internal_pattern_overlaps;

type BuildResult<T> = Result<T, GraphBuildError>;

pub fn build_graph(
    cwd: &Path,
    nodes: &HashMap<String, Vec<String>>,
    graphs: &HashMap<String, GraphSpec>,
    rules: Vec<RuleSpec>,
    source_name: &str,
) -> Result<ResolvedGraph, String> {
    GraphBuilder::new(cwd, nodes, graphs, rules)
        .build()
        .map_err(|e| format!("{source_name}: {}", e.message()))
}

/// Validates `nodes` object keys (`@...`).
pub(super) fn validate_node_id(id: &str) -> BuildResult<()> {
    if !id.starts_with('@') || id.len() < 2 {
        return Err(GraphBuildError::InvalidNodeId { node_id: id.to_string() });
    }
    for c in id.chars() {
        let ok = c.is_ascii_alphanumeric()
            || c == '@'
            || c == ':'
            || c == '_'
            || c == '-'
            || c == '['
            || c == ']';
        if !ok {
            return Err(GraphBuildError::InvalidNodeIdChar {
                node_id: id.to_string(),
                invalid_char: c,
            });
        }
    }
    Ok(())
}

/// Topology selectors defer existence checks: unknown keys remain exact strings matched at runtime.
pub(super) fn compile_topology_selector(
    selector: &str,
    field_path: &str,
) -> Result<TopologySelector, GraphBuildError> {
    if selector.trim_start().starts_with('!') {
        return Err(GraphBuildError::NegationSelectorNotSupported {
            field_path: field_path.to_string(),
            selector: selector.to_string(),
        });
    }
    let is_glob = selector.contains('*') || selector.contains('?');
    if !is_glob {
        return Ok(TopologySelector::Exact(selector.to_string()));
    }
    let matcher = Glob::new(selector)
        .map_err(|reason| GraphBuildError::InvalidNodeSelector {
            field_path: field_path.to_string(),
            selector: selector.to_string(),
            reason: reason.to_string(),
        })?
        .compile_matcher();
    Ok(TopologySelector::Pattern(matcher))
}

pub(super) fn compile_abstract_edges(
    graphs: &HashMap<String, GraphSpec>,
) -> BuildResult<Vec<AbstractEdge>> {
    let mut edges: Vec<AbstractEdge> = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();

    for (domain_name, graph) in graphs {
        for (flow_name, levels) in &graph.cascade {
            let field_ctx = format!("graph.{domain_name}.cascade.{flow_name}");
            append_flow_edges(&mut edges, &mut seen, levels, true, &field_ctx)?;
        }
        for (flow_name, levels) in &graph.sequence {
            let field_ctx = format!("graph.{domain_name}.sequence.{flow_name}");
            append_flow_edges(&mut edges, &mut seen, levels, false, &field_ctx)?;
        }
        for (flow_name, connect_edges) in &graph.connect {
            let field_ctx = format!("graph.{domain_name}.connect.{flow_name}");
            for (from_raw, targets) in connect_edges {
                let from_sel = compile_topology_selector(from_raw, &field_ctx)?;
                for to_raw in targets {
                    let to_sel = compile_topology_selector(to_raw, &field_ctx)?;
                    push_edge(&mut edges, &mut seen, from_sel.clone(), to_sel, from_raw, to_raw)?;
                }
            }
        }
    }
    Ok(edges)
}

fn push_edge(
    edges: &mut Vec<AbstractEdge>,
    seen: &mut HashSet<(String, String)>,
    from: TopologySelector,
    to: TopologySelector,
    from_raw: &str,
    to_raw: &str,
) -> BuildResult<()> {
    let key = (from_raw.to_string(), to_raw.to_string());
    if !seen.insert(key) {
        return Ok(());
    }
    edges.push(AbstractEdge { from, to });
    Ok(())
}

fn append_flow_edges(
    edges: &mut Vec<AbstractEdge>,
    seen: &mut HashSet<(String, String)>,
    levels: &FlowLevels,
    allow_skip: bool,
    field_path: &str,
) -> BuildResult<()> {
    for (level_idx, level) in levels.iter().enumerate() {
        if level.is_empty() {
            return Err(GraphBuildError::EmptyFlowLevel {
                field_path: field_path.to_string(),
                level_idx,
            });
        }
    }
    for i in 0..levels.len() {
        let start = i + 1;
        let end = if allow_skip {
            levels.len()
        } else {
            (i + 2).min(levels.len())
        };
        for j in start..end {
            for from_raw in &levels[i] {
                let from_sel = compile_topology_selector(from_raw, field_path)?;
                for to_raw in &levels[j] {
                    let to_sel = compile_topology_selector(to_raw, field_path)?;
                    push_edge(edges, seen, from_sel.clone(), to_sel, from_raw, to_raw)?;
                }
            }
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum RuleMatcherSideKind {
    From,
    To,
}

pub(super) fn compile_policy_rule(spec: RuleSpec) -> Result<PolicyRule, String> {
    let from = compile_matcher_side(spec.r#match.from, RuleMatcherSideKind::From)?;
    let to = compile_matcher_side(spec.r#match.to, RuleMatcherSideKind::To)?;
    validate_rule_placeholder_bindings(from.as_ref(), to.as_ref())?;
    Ok(PolicyRule {
        name: spec.name,
        from,
        to,
        scope: spec.scope,
        severity: spec.severity,
        message: spec.message,
    })
}

/// Every `[name]` on `to` must be capturable from a positive template arm on `from` (build-time contract).
fn validate_rule_placeholder_bindings(
    from: Option<&PolicyMatcherSide>,
    to: Option<&PolicyMatcherSide>,
) -> Result<(), String> {
    let required = placeholder_names_in_to_side(to);
    if required.is_empty() {
        return Ok(());
    }
    let Some(from_side) = from else {
        return Err(
            "rule match `to` uses `[name]` placeholders but `match.from` is omitted; \
             nothing can bind those names for substitution"
                .to_string(),
        );
    };
    let provided = placeholder_names_from_from_positive_templates(from_side);
    if provided.is_empty() {
        return Err(
            "rule match `to` uses `[name]` placeholders but `from` has no positive template arms with `[name]` captures \
             (only globs and/or negations cannot produce bindings)"
                .to_string(),
        );
    }
    for name in &required {
        if !provided.contains(name) {
            return Err(format!(
                "rule match `to` references `[{name}]` but no positive `from` template captures `{name}`"
            ));
        }
    }
    Ok(())
}

fn placeholder_names_in_to_side(to: Option<&PolicyMatcherSide>) -> HashSet<String> {
    let mut out = HashSet::new();
    let Some(side) = to else {
        return out;
    };
    for arm in &side.include_arms {
        if let PolicyIncludeArm::Template(t) = arm {
            out.extend(extract_placeholder_names(&t.raw));
        }
    }
    for t in &side.node_exclude_templates {
        out.extend(extract_placeholder_names(&t.raw));
    }
    for t in &side.path_exclude_templates {
        out.extend(extract_placeholder_names(&t.raw));
    }
    out
}

fn placeholder_names_from_from_positive_templates(from: &PolicyMatcherSide) -> HashSet<String> {
    let mut out = HashSet::new();
    for arm in &from.include_arms {
        if let PolicyIncludeArm::Template(t) = arm {
            out.extend(extract_placeholder_names(&t.raw));
        }
    }
    out
}

/// Collects `[ident]` placeholder names (same rules as node path templates).
fn extract_placeholder_names(s: &str) -> HashSet<String> {
    let chars: Vec<char> = s.chars().collect();
    let mut out = HashSet::new();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == '[' {
            let mut j = i + 1;
            while j < chars.len() && chars[j] != ']' {
                j += 1;
            }
            if j < chars.len() && j > i + 1 {
                let name: String = chars[i + 1..j].iter().collect();
                if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    out.insert(name);
                }
            }
        }
        i += 1;
    }
    out
}

fn compile_matcher_side(
    expr: Option<RuleMatchExpr>,
    side: RuleMatcherSideKind,
) -> Result<Option<PolicyMatcherSide>, String> {
    let Some(expr) = expr else {
        return Ok(None);
    };
    let raw = expr.into_patterns();
    if raw.is_empty() {
        return Err("rule match pattern list must not be empty".to_string());
    }
    let parsed: Vec<(bool, MatchField, String)> =
        raw.iter().map(|value| parse_rule_pattern(value)).collect::<Result<Vec<_>, _>>()?;
    let any_positive = parsed.iter().any(|(negated, _, _)| !negated);
    for (negated, _, normalized) in &parsed {
        if matches!(side, RuleMatcherSideKind::From)
            && !any_positive
            && *negated
            && rule_pattern_has_placeholders(normalized)
        {
            return Err(
                "rule match `from` cannot use `[var]` placeholders when every pattern is negated; \
                 negation refers to a complement, so the engine cannot extract a concrete binding for `to` substitution"
                    .to_string(),
            );
        }
    }
    let mut include_arms: Vec<PolicyIncludeArm> = Vec::new();
    let mut node_exc: Vec<Glob> = Vec::new();
    let mut path_exc: Vec<Glob> = Vec::new();
    let mut node_exclude_templates: Vec<PolicyTemplateArm> = Vec::new();
    let mut path_exclude_templates: Vec<PolicyTemplateArm> = Vec::new();
    for (negated, field, normalized) in parsed {
        if negated {
            if rule_pattern_has_placeholders(&normalized) {
                let arm = PolicyTemplateArm {
                    field,
                    raw: normalized,
                };
                match field {
                    MatchField::Node => node_exclude_templates.push(arm),
                    MatchField::Path => path_exclude_templates.push(arm),
                }
            } else {
                let g = Glob::new(&normalized)
                    .map_err(|e| format!("invalid rule match pattern {:?}: {e}", normalized.trim()))?;
                match field {
                    MatchField::Node => node_exc.push(g),
                    MatchField::Path => path_exc.push(g),
                }
            }
            continue;
        }
        if rule_pattern_has_placeholders(&normalized) {
            include_arms.push(PolicyIncludeArm::Template(PolicyTemplateArm {
                field,
                raw: normalized,
            }));
            continue;
        }
        let g = Glob::new(&normalized)
            .map_err(|e| format!("invalid rule match pattern {:?}: {e}", normalized.trim()))?;
        include_arms.push(PolicyIncludeArm::Glob {
            field,
            matcher: g.compile_matcher(),
        });
    }
    Ok(Some(PolicyMatcherSide {
        include_arms,
        node_exclude: fold_globs(node_exc)?,
        path_exclude: fold_globs(path_exc)?,
        node_exclude_templates,
        path_exclude_templates,
    }))
}

/// True when the pattern contains at least one `[ident]` placeholder (same convention as node templates).
fn rule_pattern_has_placeholders(s: &str) -> bool {
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == '[' {
            let mut j = i + 1;
            while j < chars.len() && chars[j] != ']' {
                j += 1;
            }
            if j < chars.len() && j > i + 1 {
                let name: String = chars[i + 1..j].iter().collect();
                if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    return true;
                }
            }
        }
        i += 1;
    }
    false
}

fn fold_globs(globs: Vec<Glob>) -> Result<Option<GlobSet>, String> {
    if globs.is_empty() {
        return Ok(None);
    }
    let mut b = GlobSetBuilder::new();
    for g in globs {
        b.add(g);
    }
    b.build().map(Some).map_err(|e| e.to_string())
}

/// Parses one rule pattern string: optional leading `!`, then node (`@`) vs path, no recursive AST.
fn parse_rule_pattern(raw: &str) -> Result<(bool, MatchField, String), String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("rule match pattern must not be empty".to_string());
    }
    let (negated, rest) = if let Some(r) = trimmed.strip_prefix('!') {
        let inner = r.trim();
        if inner.is_empty() {
            return Err("negation rule pattern must not be empty after `!`".to_string());
        }
        if inner.starts_with('!') {
            return Err("invalid nested negation rule pattern".to_string());
        }
        (true, inner)
    } else {
        (false, trimmed)
    };
    let field = if rest.starts_with('@') {
        MatchField::Node
    } else {
        MatchField::Path
    };
    Ok((negated, field, normalize_for_match(rest)))
}

fn normalize_for_match(value: &str) -> String {
    value.replace('\\', "/")
}

pub(super) fn compile_node_mapping(
    cwd: &Path,
    id_template: &str,
    raw_pattern: &str,
) -> Result<EitherPattern, String> {
    let mut pattern = raw_pattern.trim();
    if pattern.is_empty() {
        return Err("node pattern must not be empty".to_string());
    }
    let mut is_exclude = false;
    if let Some(rest) = pattern.strip_prefix('!') {
        let trimmed = rest.trim();
        if trimmed.is_empty() {
            return Err("exclude node pattern must not be empty after `!`".to_string());
        }
        is_exclude = true;
        pattern = trimmed;
    }

    if let Some(rest) = pattern.strip_prefix("npm:") {
        if is_exclude {
            return Err("exclude node pattern does not support external key `npm:`".to_string());
        }
        let pkg = rest.trim();
        if pkg.is_empty() {
            return Err("npm external key must not be empty".to_string());
        }
        return Ok(EitherPattern::External(ExternalDependencyPattern {
            id_template: id_template.to_string(),
            external_key: pkg.to_string(),
        }));
    }
    if let Some(rest) = pattern.strip_prefix("node:") {
        if is_exclude {
            return Err("exclude node pattern does not support external key `node:`".to_string());
        }
        let module = rest.trim();
        if module.is_empty() {
            return Err("node external key must not be empty".to_string());
        }
        let full = format!("node:{module}");
        return Ok(EitherPattern::External(ExternalDependencyPattern {
            id_template: id_template.to_string(),
            external_key: full,
        }));
    }

    if pattern.starts_with('@') {
        return Err(
            "node path patterns must not reference other nodes (`@...`); duplicate globs explicitly or use generated config"
                .to_string(),
        );
    }

    let normalized = normalize_template(pattern);
    let mut segments: Vec<String> = normalized
        .split('/')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    if segments.is_empty() {
        return Err("internal pattern must not resolve to empty segments".to_string());
    }

    if !contains_glob_meta(&segments) {
        segments.push("**".to_string());
    }
    let specificity = segments.iter().filter(|s| is_literal_segment(s)).count();
    let source_root = detect_source_root(cwd, &segments)?;
    let literal_rel_prefix = literal_rel_prefix_from_segments(&segments);

    Ok(EitherPattern::Internal(InternalNodePattern {
        id_template: id_template.to_string(),
        is_exclude,
        raw_pattern: raw_pattern.trim().to_string(),
        path_segments: segments,
        literal_rel_prefix,
        specificity,
        source_root,
    }))
}

pub(super) enum EitherPattern {
    Internal(InternalNodePattern),
    External(ExternalDependencyPattern),
}

fn detect_source_root(cwd: &Path, segments: &[String]) -> Result<Option<PathBuf>, String> {
    let mut stable = Vec::new();
    for seg in segments {
        if seg == "**"
            || seg == "*"
            || seg.contains('*')
            || seg.contains('?')
            || is_var_segment(seg)
        {
            break;
        }
        stable.push(seg.as_str());
    }
    if stable.is_empty() {
        return Ok(Some(cwd.to_path_buf()));
    }
    let rel = stable.join("/");
    let joined = cwd.join(rel);
    if joined.exists() {
        let canonical = dunce::canonicalize(&joined)
            .map_err(|e| format!("canonicalize source root {}: {e}", joined.display()))?;
        return Ok(Some(canonical));
    }
    Ok(Some(joined))
}

fn normalize_template(raw: &str) -> String {
    raw.trim_start_matches("./").replace('\\', "/")
}

fn contains_glob_meta(segments: &[String]) -> bool {
    segments
        .iter()
        .any(|s| s == "**" || s.contains('*') || s.contains('?'))
}

fn is_var_segment(segment: &str) -> bool {
    segment.starts_with('[') && segment.ends_with(']') && segment.len() >= 3
}

fn is_literal_segment(segment: &str) -> bool {
    !segment.contains('*') && !segment.contains('?') && !is_var_segment(segment)
}

/// Leading literal path segments joined with `/`, before `**`, `*`, `?`, `[var]`, or segment-internal globs.
fn literal_rel_prefix_from_segments(segments: &[String]) -> String {
    let mut parts = Vec::new();
    for seg in segments {
        if seg == "**"
            || seg == "*"
            || seg.contains('*')
            || seg.contains('?')
            || is_var_segment(seg)
        {
            break;
        }
        parts.push(seg.as_str());
    }
    parts.join("/")
}

struct GraphBuilder<'a> {
    cwd: &'a Path,
    nodes: &'a HashMap<String, Vec<String>>,
    graphs: &'a HashMap<String, GraphSpec>,
    rules: Vec<RuleSpec>,
    context: BuildContext,
}

struct BuildContext {
    internal_patterns_by_node: HashMap<String, Vec<InternalNodePattern>>,
    external_dependencies: Vec<ExternalDependencyPattern>,
    node_keys: HashSet<String>,
}

impl BuildContext {
    fn new(node_count: usize) -> Self {
        Self {
            internal_patterns_by_node: HashMap::new(),
            external_dependencies: Vec::new(),
            node_keys: HashSet::with_capacity(node_count),
        }
    }
}

impl<'a> GraphBuilder<'a> {
    fn new(
        cwd: &'a Path,
        nodes: &'a HashMap<String, Vec<String>>,
        graphs: &'a HashMap<String, GraphSpec>,
        rules: Vec<RuleSpec>,
    ) -> Self {
        Self {
            cwd,
            nodes,
            graphs,
            rules,
            context: BuildContext::new(nodes.len()),
        }
    }

    fn build(mut self) -> BuildResult<ResolvedGraph> {
        if self.nodes.is_empty() {
            return Err(GraphBuildError::EmptyNodes);
        }
        self.compile_node_patterns()?;
        let abstract_edges = compile_abstract_edges(self.graphs)?;

        let mut internals_flat: Vec<InternalNodePattern> = Vec::new();
        for v in self.context.internal_patterns_by_node.values() {
            internals_flat.extend(v.iter().cloned());
        }
        let startup_warnings = detect_internal_pattern_overlaps(&internals_flat);
        let policy_rules = self.compile_policy_rules()?;

        Ok(ResolvedGraph {
            internal_patterns_by_node: self.context.internal_patterns_by_node,
            external_dependencies: self.context.external_dependencies,
            abstract_edges,
            policy_rules,
            node_keys: self.context.node_keys,
            startup_warnings,
            internal_resolve_cache: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    fn compile_node_patterns(&mut self) -> BuildResult<()> {
        for (id, raw_patterns) in self.nodes {
            validate_node_id(id)?;
            if raw_patterns.is_empty() {
                return Err(GraphBuildError::EmptyNodePatterns { node_id: id.clone() });
            }
            self.context.node_keys.insert(id.clone());
            for raw_pattern in raw_patterns {
                let mapped = compile_node_mapping(self.cwd, id, raw_pattern).map_err(|reason| {
                    GraphBuildError::InvalidNodeMapping {
                        node_id: id.clone(),
                        raw_pattern: raw_pattern.clone(),
                        reason,
                    }
                })?;
                match mapped {
                    EitherPattern::Internal(p) => {
                        self.context
                            .internal_patterns_by_node
                            .entry(id.clone())
                            .or_default()
                            .push(p);
                    }
                    EitherPattern::External(ext) => {
                        self.context.external_dependencies.push(ext);
                    }
                }
            }
        }
        Ok(())
    }

    fn compile_policy_rules(&mut self) -> BuildResult<Vec<PolicyRule>> {
        let mut policy_rules = Vec::with_capacity(self.rules.len());
        for (idx, rule) in self.rules.drain(..).enumerate() {
            let compiled = compile_policy_rule(rule)
                .map_err(|reason| GraphBuildError::PolicyRuleParse { index: idx, reason })?;
            policy_rules.push(compiled);
        }
        Ok(policy_rules)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_id_validation_rejects_invalid_char() {
        let err = validate_node_id("@feature/a").expect_err("slash should be invalid");
        assert!(matches!(
            err,
            GraphBuildError::InvalidNodeIdChar {
                invalid_char: '/',
                ..
            }
        ));
    }
}
