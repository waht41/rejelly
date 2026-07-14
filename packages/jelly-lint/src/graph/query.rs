use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::utils::rel_path_slash;
use globset::GlobMatcher;

use super::data::{
    EdgeCheckDetail, EdgeCheckResult, EdgeSeverity, MatchField, NodeRef, PolicyIncludeArm,
    PolicyMatcherSide, PolicyTemplateArm, ResolvedGraph, RuleScope, TopologySelector,
};

pub fn collect_source_roots(graph: &ResolvedGraph) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for patterns in graph.internal_patterns_by_node.values() {
        for p in patterns {
            if p.is_exclude {
                continue;
            }
            let Some(root) = &p.source_root else {
                continue;
            };
            let key = root.to_string_lossy().to_string();
            if seen.insert(key) {
                out.push(root.clone());
            }
        }
    }
    out.sort();
    out
}

impl ResolvedGraph {
    pub fn node_count(&self) -> usize {
        self.node_keys.len()
    }

    pub fn resolve_file_node(&self, cwd: &Path, file: &Path) -> Option<NodeRef> {
        let rel = rel_path_slash(cwd, file)?;
        self.resolve_internal_by_rel_path(&rel)
    }

    pub fn resolve_target_node(&self, cwd: &Path, spec: &str, resolved: Option<&Path>) -> Option<NodeRef> {
        if let Some(path) = resolved {
            if let Some(rel) = rel_path_slash(cwd, path) {
                if let Some(node) = self.resolve_internal_by_rel_path(&rel) {
                    return Some(node);
                }
            }
        }
        self.resolve_external_by_spec(spec)
    }

    pub fn has_edge(&self, from: &NodeRef, to: &NodeRef) -> bool {
        self.check_edge(from, to) != EdgeCheckResult::Forbidden
    }

    pub fn startup_warnings(&self) -> &[String] {
        &self.startup_warnings
    }

    pub fn check_edge(&self, from: &NodeRef, to: &NodeRef) -> EdgeCheckResult {
        self.check_edge_with_context(from, to, None, None, None)
    }

    pub fn check_edge_with_context(
        &self,
        from: &NodeRef,
        to: &NodeRef,
        from_rel_path: Option<&str>,
        to_rel_path: Option<&str>,
        to_spec: Option<&str>,
    ) -> EdgeCheckResult {
        self.check_edge_with_context_detail(from, to, from_rel_path, to_rel_path, to_spec)
            .result
    }

    pub fn check_edge_with_context_detail(
        &self,
        from: &NodeRef,
        to: &NodeRef,
        from_rel_path: Option<&str>,
        to_rel_path: Option<&str>,
        to_spec: Option<&str>,
    ) -> EdgeCheckDetail {
        if from.concrete_id == to.concrete_id {
            return EdgeCheckDetail {
                result: EdgeCheckResult::Allowed,
                rule_name: None,
                rule_message: None,
            };
        }

        let topology_allowed = self.abstract_topology_allows(from, to);
        if !topology_allowed {
            return self.apply_policy_rules(false, from, to, from_rel_path, to_rel_path, to_spec);
        }
        self.apply_policy_rules(true, from, to, from_rel_path, to_rel_path, to_spec)
    }

    fn abstract_topology_allows(&self, from: &NodeRef, to: &NodeRef) -> bool {
        self.abstract_edges.iter().any(|edge| {
            topology_endpoint_matches(&edge.from, &from.template_id, &from.concrete_id)
                && topology_endpoint_matches(&edge.to, &to.template_id, &to.concrete_id)
                && shared_bindings_compatible(&from.bindings, &to.bindings)
        })
    }

    fn resolve_internal_by_rel_path(&self, rel: &str) -> Option<NodeRef> {
        {
            let cache = self.internal_resolve_cache.lock().unwrap();
            if let Some(cached) = cache.get(rel) {
                return cached.clone();
            }
        }
        let resolved = self.resolve_internal_by_rel_path_uncached(rel);
        self.internal_resolve_cache
            .lock()
            .unwrap()
            .insert(rel.to_string(), resolved.clone());
        resolved
    }

    fn resolve_internal_by_rel_path_uncached(&self, rel: &str) -> Option<NodeRef> {
        let path_segments: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
        let mut best: Option<(usize, usize, NodeRef)> = None;

        for patterns in self.internal_patterns_by_node.values() {
            let mut node_candidate: Option<(usize, usize, NodeRef)> = None;
            let mut node_included = false;

            for pattern in patterns {
                if !rel_has_literal_prefix(rel, &pattern.literal_rel_prefix) {
                    continue;
                }
                let mut bindings = HashMap::new();
                if !matches_path_segments_collect(
                    &pattern.path_segments,
                    &path_segments,
                    0,
                    0,
                    &mut bindings,
                ) {
                    continue;
                }
                if pattern.is_exclude {
                    node_included = false;
                    node_candidate = None;
                    continue;
                }
                node_included = true;
                let concrete = render_id(&pattern.id_template, &bindings);
                let candidate = NodeRef {
                    template_id: pattern.id_template.clone(),
                    concrete_id: concrete,
                    bindings,
                };
                let score = (pattern.specificity, pattern.path_segments.len());
                node_candidate = Some((score.0, score.1, candidate));
            }

            if !node_included {
                continue;
            }
            if let Some((a, b, n)) = node_candidate {
                if best.as_ref().map(|(ba, bb, _)| (*ba, *bb) < (a, b)).unwrap_or(true) {
                    best = Some((a, b, n));
                }
            }
        }

        best.map(|(_, _, n)| n)
    }

    fn resolve_external_by_spec(&self, spec: &str) -> Option<NodeRef> {
        let spec = spec.trim();
        if spec.is_empty() {
            return None;
        }
        for pattern in &self.external_dependencies {
            if import_spec_matches_key(spec, &pattern.external_key) {
                return Some(NodeRef {
                    template_id: pattern.id_template.clone(),
                    concrete_id: pattern.id_template.clone(),
                    bindings: HashMap::new(),
                });
            }
        }
        None
    }
}

impl ResolvedGraph {
    fn apply_policy_rules(
        &self,
        topology_allowed: bool,
        from: &NodeRef,
        to: &NodeRef,
        from_rel_path: Option<&str>,
        to_rel_path: Option<&str>,
        to_spec: Option<&str>,
    ) -> EdgeCheckDetail {
        for rule in &self.policy_rules {
            let skip_by_scope = matches!(
                (rule.scope, topology_allowed),
                (RuleScope::Fallback, true) | (RuleScope::TopologyAllowed, false)
            );
            if skip_by_scope {
                continue;
            }
            let Some(from_ctx) = policy_from_matches(rule.from.as_ref(), from, from_rel_path, None) else {
                continue;
            };
            if !policy_to_matches(rule.to.as_ref(), to, to_rel_path, to_spec, &from_ctx) {
                continue;
            }
            return match rule.severity {
                EdgeSeverity::Error => EdgeCheckDetail {
                    result: EdgeCheckResult::Forbidden,
                    rule_name: rule.name.clone(),
                    rule_message: rule.message.clone(),
                },
                EdgeSeverity::Warn => {
                    let message = rule.message.clone().unwrap_or_else(|| {
                        format!(
                            "rules: edge matched warn policy ({} -> {})",
                            from.concrete_id, to.concrete_id
                        )
                    });
                    EdgeCheckDetail {
                        result: EdgeCheckResult::AllowedWithWarn(message.clone()),
                        rule_name: rule.name.clone(),
                        rule_message: Some(message),
                    }
                }
                EdgeSeverity::Off => EdgeCheckDetail {
                    result: EdgeCheckResult::Allowed,
                    rule_name: rule.name.clone(),
                    rule_message: rule.message.clone(),
                },
            };
        }
        if topology_allowed {
            EdgeCheckDetail {
                result: EdgeCheckResult::Allowed,
                rule_name: None,
                rule_message: None,
            }
        } else {
            EdgeCheckDetail {
                result: EdgeCheckResult::Forbidden,
                rule_name: None,
                rule_message: None,
            }
        }
    }
}

fn policy_pattern_has_placeholders(s: &str) -> bool {
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

fn split_policy_segments(field: MatchField, raw: &str) -> Vec<String> {
    match field {
        MatchField::Node => raw.split(':').filter(|s| !s.is_empty()).map(String::from).collect(),
        MatchField::Path => raw.split('/').filter(|s| !s.is_empty()).map(String::from).collect(),
    }
}

/// Match `raw` (with optional `[var]` segments) against node id or path/spec; returns captured bindings.
fn template_raw_matches_node(
    raw: &str,
    field: MatchField,
    template_id: &str,
    concrete_id: &str,
    rel_path: Option<&str>,
    spec: Option<&str>,
) -> Option<HashMap<String, String>> {
    let segments = split_policy_segments(field, raw);
    match field {
        MatchField::Node => {
            for cand in [concrete_id, template_id] {
                let path_segs: Vec<&str> = cand.split(':').filter(|s| !s.is_empty()).collect();
                let mut bindings = HashMap::new();
                if matches_path_segments_collect(&segments, &path_segs, 0, 0, &mut bindings) {
                    return Some(bindings);
                }
            }
            None
        }
        MatchField::Path => {
            let mut try_paths: Vec<&str> = Vec::new();
            if let Some(p) = rel_path {
                try_paths.push(p);
            }
            if let Some(s) = spec {
                try_paths.push(s);
            }
            for path in try_paths {
                let path_segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
                let mut bindings = HashMap::new();
                if matches_path_segments_collect(&segments, &path_segs, 0, 0, &mut bindings) {
                    return Some(bindings);
                }
            }
            None
        }
    }
}

fn side_has_any_include(side: &PolicyMatcherSide) -> bool {
    !side.include_arms.is_empty()
}

fn glob_include_arm_matches(
    field: MatchField,
    matcher: &GlobMatcher,
    node: &NodeRef,
    rel_path: Option<&str>,
    spec: Option<&str>,
) -> bool {
    match field {
        MatchField::Node => matcher.is_match(&node.template_id) || matcher.is_match(&node.concrete_id),
        MatchField::Path => {
            rel_path.map(|p| matcher.is_match(p)).unwrap_or(false)
                || spec.map(|s| matcher.is_match(s)).unwrap_or(false)
        }
    }
}

/// First matching positive arm in JSON order; returns bindings from template or empty map from glob.
fn policy_include_extract_ordered(
    side: &PolicyMatcherSide,
    node: &NodeRef,
    rel_path: Option<&str>,
    spec: Option<&str>,
) -> Option<HashMap<String, String>> {
    for arm in &side.include_arms {
        match arm {
            PolicyIncludeArm::Glob {
                field,
                matcher,
            } => {
                if glob_include_arm_matches(*field, matcher, node, rel_path, spec) {
                    return Some(HashMap::new());
                }
            }
            PolicyIncludeArm::Template(t) => {
                if let Some(b) = template_raw_matches_node(
                    &t.raw,
                    t.field,
                    &node.template_id,
                    &node.concrete_id,
                    rel_path,
                    spec,
                ) {
                    return Some(b);
                }
            }
        }
    }
    None
}

/// `to` side: first matching arm wins (glob or rendered template).
fn policy_include_matches_ordered_injected(
    side: &PolicyMatcherSide,
    node: &NodeRef,
    rel_path: Option<&str>,
    spec: Option<&str>,
    ctx: &HashMap<String, String>,
) -> bool {
    for arm in &side.include_arms {
        match arm {
            PolicyIncludeArm::Glob {
                field,
                matcher,
            } => {
                if glob_include_arm_matches(*field, matcher, node, rel_path, spec) {
                    return true;
                }
            }
            PolicyIncludeArm::Template(t) => {
                let rendered = render_id(&t.raw, ctx);
                if policy_pattern_has_placeholders(&rendered) {
                    continue;
                }
                if template_raw_matches_node(&rendered, t.field, &node.template_id, &node.concrete_id, rel_path, spec)
                    .is_some()
                {
                    return true;
                }
            }
        }
    }
    false
}

fn template_arm_matches_with_optional_inject(
    arm: &PolicyTemplateArm,
    node: &NodeRef,
    rel_path: Option<&str>,
    spec: Option<&str>,
    inject: Option<&HashMap<String, String>>,
) -> bool {
    let raw = match inject {
        None => arm.raw.clone(),
        Some(ctx) => {
            let r = render_id(&arm.raw, ctx);
            if policy_pattern_has_placeholders(&r) {
                return false;
            }
            r
        }
    };
    template_raw_matches_node(&raw, arm.field, &node.template_id, &node.concrete_id, rel_path, spec).is_some()
}

fn policy_exclude_blocks(
    side: &PolicyMatcherSide,
    node: &NodeRef,
    rel_path: Option<&str>,
    spec: Option<&str>,
    inject: Option<&HashMap<String, String>>,
) -> bool {
    if let Some(gs) = &side.node_exclude {
        if gs.is_match(&node.template_id) || gs.is_match(&node.concrete_id) {
            return true;
        }
    }
    if let Some(gs) = &side.path_exclude {
        if rel_path.map(|p| gs.is_match(p)).unwrap_or(false) || spec.map(|s| gs.is_match(s)).unwrap_or(false) {
            return true;
        }
    }
    for arm in &side.node_exclude_templates {
        if template_arm_matches_with_optional_inject(arm, node, rel_path, spec, inject) {
            return true;
        }
    }
    for arm in &side.path_exclude_templates {
        if template_arm_matches_with_optional_inject(arm, node, rel_path, spec, inject) {
            return true;
        }
    }
    false
}

/// From-side match with `[var]` extraction for cross-edge injection into `to`.
///
/// Binding contract (documented in packages/jelly-lint/README.md §3.3):
/// - Exclude arms are evaluated before positive arms; no bindings if any exclude matches.
/// - Negation patterns never supply bindings for `to` substitution (only template positive arms capture).
/// - Positive arms are evaluated in JSON array order; first matching glob yields empty bindings; first matching template yields its captures.
fn policy_from_matches(
    side: Option<&PolicyMatcherSide>,
    node: &NodeRef,
    rel_path: Option<&str>,
    spec: Option<&str>,
) -> Option<HashMap<String, String>> {
    let Some(side) = side else {
        return Some(HashMap::new());
    };
    if policy_exclude_blocks(side, node, rel_path, spec, None) {
        return None;
    }
    if !side_has_any_include(side) {
        return Some(HashMap::new());
    }
    policy_include_extract_ordered(side, node, rel_path, spec)
}

/// Every template arm on `to` must fully substitute `ctx`; otherwise the rule cannot be evaluated.
fn policy_to_templates_resolvable_with_ctx(side: &PolicyMatcherSide, ctx: &HashMap<String, String>) -> bool {
    let mut arms: Vec<&PolicyTemplateArm> = Vec::new();
    for arm in &side.include_arms {
        if let PolicyIncludeArm::Template(t) = arm {
            arms.push(t);
        }
    }
    arms.extend(side.node_exclude_templates.iter());
    arms.extend(side.path_exclude_templates.iter());
    for arm in arms {
        let rendered = render_id(&arm.raw, ctx);
        if policy_pattern_has_placeholders(&rendered) {
            return false;
        }
    }
    true
}

fn policy_to_matches(
    side: Option<&PolicyMatcherSide>,
    node: &NodeRef,
    rel_path: Option<&str>,
    spec: Option<&str>,
    ctx: &HashMap<String, String>,
) -> bool {
    let Some(side) = side else {
        return true;
    };
    if !policy_to_templates_resolvable_with_ctx(side, ctx) {
        return false;
    }
    if policy_exclude_blocks(side, node, rel_path, spec, Some(ctx)) {
        return false;
    }
    if !side_has_any_include(side) {
        return true;
    }
    policy_include_matches_ordered_injected(side, node, rel_path, spec, ctx)
}

/// Prefix pruning: `rel` must equal `prefix` or continue as `prefix/...` (avoids `src` matching `src2`).
fn rel_has_literal_prefix(rel: &str, prefix: &str) -> bool {
    if prefix.is_empty() {
        return true;
    }
    if !rel.starts_with(prefix) {
        return false;
    }
    rel.len() == prefix.len() || rel.as_bytes().get(prefix.len()) == Some(&b'/')
}

fn render_id(template: &str, bindings: &HashMap<String, String>) -> String {
    let mut out = template.to_string();
    for (k, v) in bindings {
        out = out.replace(&format!("[{k}]"), v);
    }
    out
}

fn topology_endpoint_matches(sel: &TopologySelector, template_id: &str, concrete_id: &str) -> bool {
    match sel {
        TopologySelector::Exact(s) => s == template_id || s == concrete_id,
        TopologySelector::Pattern(m) => m.is_match(template_id) || m.is_match(concrete_id),
    }
}

fn shared_bindings_compatible(a: &HashMap<String, String>, b: &HashMap<String, String>) -> bool {
    a.iter()
        .all(|(k, av)| b.get(k).map(|bv| bv == av).unwrap_or(true))
}

fn import_spec_matches_key(spec: &str, key: &str) -> bool {
    if spec == key {
        return true;
    }
    spec.starts_with(&format!("{key}/"))
}

fn matches_path_segments_collect(
    pattern: &[String],
    path: &[&str],
    pi: usize,
    si: usize,
    bindings: &mut HashMap<String, String>,
) -> bool {
    if pi == pattern.len() {
        return si == path.len();
    }
    let token = &pattern[pi];
    if token == "**" {
        for take in si..=path.len() {
            let mut local = bindings.clone();
            if matches_path_segments_collect(pattern, path, pi + 1, take, &mut local) {
                *bindings = local;
                return true;
            }
        }
        return false;
    }
    if si >= path.len() {
        return false;
    }

    if !segment_match_with_bindings(token, path[si], bindings) {
        return false;
    }
    matches_path_segments_collect(pattern, path, pi + 1, si + 1, bindings)
}

fn segment_match_with_bindings(
    pattern: &str,
    text: &str,
    bindings: &mut HashMap<String, String>,
) -> bool {
    let units = parse_segment_units(pattern);
    let chars: Vec<char> = text.chars().collect();
    segment_units_match(&units, 0, &chars, 0, bindings)
}

#[derive(Clone, Debug)]
enum SegmentUnit {
    Star,
    Single,
    Literal(char),
    Var(String),
}

fn parse_segment_units(pattern: &str) -> Vec<SegmentUnit> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < chars.len() {
        match chars[i] {
            '*' => {
                out.push(SegmentUnit::Star);
                i += 1;
            }
            '?' => {
                out.push(SegmentUnit::Single);
                i += 1;
            }
            '[' => {
                let mut j = i + 1;
                while j < chars.len() && chars[j] != ']' {
                    j += 1;
                }
                if j < chars.len() && j > i + 1 {
                    let name: String = chars[i + 1..j].iter().collect();
                    if name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                        out.push(SegmentUnit::Var(name));
                        i = j + 1;
                        continue;
                    }
                }
                out.push(SegmentUnit::Literal('['));
                i += 1;
            }
            c => {
                out.push(SegmentUnit::Literal(c));
                i += 1;
            }
        }
    }
    out
}

fn segment_units_match(
    units: &[SegmentUnit],
    ui: usize,
    text: &[char],
    ti: usize,
    bindings: &mut HashMap<String, String>,
) -> bool {
    if ui == units.len() {
        return ti == text.len();
    }
    match &units[ui] {
        SegmentUnit::Star => {
            for take in ti..=text.len() {
                let mut local = bindings.clone();
                if segment_units_match(units, ui + 1, text, take, &mut local) {
                    *bindings = local;
                    return true;
                }
            }
            false
        }
        SegmentUnit::Single => {
            if ti >= text.len() {
                return false;
            }
            segment_units_match(units, ui + 1, text, ti + 1, bindings)
        }
        SegmentUnit::Literal(c) => {
            if ti >= text.len() || text[ti] != *c {
                return false;
            }
            segment_units_match(units, ui + 1, text, ti + 1, bindings)
        }
        SegmentUnit::Var(name) => {
            for take in (ti + 1)..=text.len() {
                let captured: String = text[ti..take].iter().collect();
                if captured.contains('/') {
                    continue;
                }
                if let Some(existing) = bindings.get(name) {
                    if existing != &captured {
                        continue;
                    }
                    if segment_units_match(units, ui + 1, text, take, bindings) {
                        return true;
                    }
                    continue;
                }
                let mut local = bindings.clone();
                local.insert(name.clone(), captured);
                if segment_units_match(units, ui + 1, text, take, &mut local) {
                    *bindings = local;
                    return true;
                }
            }
            false
        }
    }
}
