use std::collections::{HashMap, HashSet};

use super::data::InternalNodePattern;

/// Pairwise prefix/superset checks instead of a trie (startup-only; typically small N).
pub(super) fn detect_internal_pattern_overlaps(patterns: &[InternalNodePattern]) -> Vec<String> {
    let mut excludes_by_node: HashMap<String, Vec<Vec<String>>> = HashMap::new();
    for p in patterns.iter().filter(|p| p.is_exclude) {
        excludes_by_node
            .entry(p.id_template.clone())
            .or_default()
            .push(static_prefix_segments(&p.path_segments));
    }

    let internals: Vec<InternalOverlapPattern<'_>> = patterns
        .iter()
        .filter(|p| !p.is_exclude)
        .map(|p| InternalOverlapPattern {
            id_template: &p.id_template,
            raw_pattern: &p.raw_pattern,
            prefix: static_prefix_segments(&p.path_segments),
            path_segments: &p.path_segments,
        })
        .collect();

    let mut seen = HashSet::new();
    let mut warnings = Vec::new();

    for i in 0..internals.len() {
        for j in 0..internals.len() {
            if i == j {
                continue;
            }
            push_overlap_if_needed(
                &internals,
                i,
                j,
                &excludes_by_node,
                &mut seen,
                &mut warnings,
            );
        }
    }

    warnings.sort();
    warnings
}

struct InternalOverlapPattern<'a> {
    id_template: &'a str,
    raw_pattern: &'a str,
    prefix: Vec<String>,
    path_segments: &'a [String],
}

fn push_overlap_if_needed(
    patterns: &[InternalOverlapPattern<'_>],
    broad_idx: usize,
    narrow_idx: usize,
    excludes_by_node: &HashMap<String, Vec<Vec<String>>>,
    seen: &mut HashSet<String>,
    warnings: &mut Vec<String>,
) {
    let broad = &patterns[broad_idx];
    let narrow = &patterns[narrow_idx];
    if broad.id_template == narrow.id_template {
        return;
    }
    if !prefix_contains(&broad.prefix, &narrow.prefix) {
        return;
    }
    if !pattern_contains(broad.path_segments, narrow.path_segments) {
        return;
    }
    if is_narrow_prefix_excluded_by_broad(broad, narrow, excludes_by_node) {
        return;
    }
    push_overlap_warning(
        seen,
        warnings,
        broad.id_template.to_string(),
        broad.raw_pattern.to_string(),
        narrow.id_template.to_string(),
        narrow.raw_pattern.to_string(),
    );
}

fn is_narrow_prefix_excluded_by_broad(
    broad: &InternalOverlapPattern<'_>,
    narrow: &InternalOverlapPattern<'_>,
    excludes_by_node: &HashMap<String, Vec<Vec<String>>>,
) -> bool {
    excludes_by_node
        .get(broad.id_template)
        .map(|excludes| {
            excludes
                .iter()
                .any(|exclude| prefix_contains(exclude, &narrow.prefix))
        })
        .unwrap_or(false)
}

fn push_overlap_warning(
    seen: &mut HashSet<String>,
    warnings: &mut Vec<String>,
    broad_id_template: String,
    broad_raw_pattern: String,
    narrow_id_template: String,
    narrow_raw_pattern: String,
) {
    let key = format!(
        "{}|{}|{}|{}",
        broad_id_template, broad_raw_pattern, narrow_id_template, narrow_raw_pattern
    );
    if !seen.insert(key) {
        return;
    }
    warnings.push(format!(
        "graph: detected overlapping node physical paths: {} ({}) fully contains {} ({}). Ownership may be ambiguous; use `!` exclusion patterns in `nodes` to define explicit boundaries.",
        broad_id_template, broad_raw_pattern, narrow_id_template, narrow_raw_pattern
    ));
}

fn static_prefix_segments(path_segments: &[String]) -> Vec<String> {
    let mut prefix = Vec::new();
    for seg in path_segments {
        if seg == "**"
            || seg == "*"
            || seg.contains('*')
            || seg.contains('?')
            || is_full_segment_var(seg)
        {
            break;
        }
        prefix.push(seg.clone());
    }
    prefix
}

fn prefix_contains(broad: &[String], narrow: &[String]) -> bool {
    if broad.len() > narrow.len() {
        return false;
    }
    for (idx, seg) in broad.iter().enumerate() {
        if narrow.get(idx) != Some(seg) {
            return false;
        }
    }
    true
}

fn pattern_contains(broad: &[String], narrow: &[String]) -> bool {
    if !is_provable_superset_pattern(broad) || !is_provable_subset_pattern(narrow) {
        return false;
    }
    let mut bi = 0usize;
    let mut ni = 0usize;
    while bi < broad.len() && ni < narrow.len() {
        let b = &broad[bi];
        if b == "**" {
            return broad[bi + 1..].iter().all(|seg| seg == "*");
        }
        let n = &narrow[ni];
        if n == "**" {
            return false;
        }
        if !segment_is_guaranteed_super_pattern(b, n) {
            return false;
        }
        bi += 1;
        ni += 1;
    }
    if bi == broad.len() && ni == narrow.len() {
        return true;
    }
    if bi < broad.len() {
        return broad[bi..].iter().all(|seg| seg == "**" || seg == "*");
    }
    false
}

fn is_provable_superset_pattern(pattern: &[String]) -> bool {
    for (idx, seg) in pattern.iter().enumerate() {
        if seg == "**" {
            return pattern[idx + 1..].iter().all(|rest| rest == "*");
        }
        if contains_complex_segment_meta(seg) {
            return false;
        }
    }
    true
}

fn is_provable_subset_pattern(pattern: &[String]) -> bool {
    for seg in pattern {
        if seg == "**" || seg == "*" || is_full_segment_var(seg) {
            continue;
        }
        if contains_complex_segment_meta(seg) {
            return false;
        }
    }
    true
}

fn segment_is_guaranteed_super_pattern(broad: &str, narrow: &str) -> bool {
    if broad == narrow {
        return true;
    }
    if broad == "*" {
        return true;
    }
    if is_full_segment_var(broad) {
        return true;
    }
    if contains_segment_meta(broad) {
        return false;
    }
    if contains_segment_meta(narrow) {
        return false;
    }
    broad == narrow
}

fn contains_segment_meta(segment: &str) -> bool {
    segment.contains('*') || segment.contains('?') || is_full_segment_var(segment)
}

fn contains_complex_segment_meta(segment: &str) -> bool {
    if segment == "*" || segment == "**" || is_full_segment_var(segment) {
        return false;
    }
    segment.contains('*') || segment.contains('?')
}

fn is_full_segment_var(segment: &str) -> bool {
    segment.starts_with('[') && segment.ends_with(']') && segment.len() >= 3
}
