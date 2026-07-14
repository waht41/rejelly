use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use oxc_resolver::Resolver;
use rayon::prelude::*;

use crate::config::ResolvedConfig;
use crate::graph::EdgeCheckResult;
use crate::parser::parse_source;
use crate::utils::rel_path_slash;

use super::resolver::{resolve_for_scope_check, should_skip_specifier};
use super::{LintDiag, Severity};

fn is_relative_or_absolute_spec(spec: &str) -> bool {
    let s = spec.trim();
    s.starts_with("./")
        || s.starts_with("../")
        || s.starts_with('/')
        || s.starts_with(".\\")
        || s.starts_with("..\\")
}

fn is_unmapped_external_import(cwd: &Path, spec: &str, resolved: Option<&Path>) -> bool {
    if let Some(path) = resolved {
        // Resolved path outside workspace is treated as external dependency.
        return rel_path_slash(cwd, path).is_none();
    }
    // Unresolved bare specifier is also considered external and allowed by default.
    !is_relative_or_absolute_spec(spec)
}

fn line_number_from_offset(source_text: &str, target_offset: usize) -> usize {
    let mut line = 1usize;
    for (idx, ch) in source_text.char_indices() {
        if idx >= target_offset {
            break;
        }
        if ch == '\n' {
            line += 1;
        }
    }
    line
}

pub fn lint_workspace(
    cfg: &ResolvedConfig,
    files: &[PathBuf],
    resolver: Arc<Resolver>,
    quiet: bool,
) -> Vec<LintDiag> {
    files
        .par_iter()
        .flat_map(|file| {
            let source_text = match std::fs::read_to_string(file) {
                Ok(s) => s,
                Err(e) => {
                    if !quiet {
                        println!("WARN: failed to read file {:?}: {}", file, e);
                    }
                    return Vec::new();
                }
            };
            let parsed = parse_source(file, &source_text);
            let mut diags = Vec::new();

            for req in &parsed.imports {
                let line_num = line_number_from_offset(&source_text, req.offset as usize);
                if parsed.should_ignore(line_num, &req.spec) {
                    continue;
                }

                let resolved = if should_skip_specifier(&req.spec) {
                    None
                } else {
                    resolve_for_scope_check(&resolver, file, &req.spec)
                };

                let from = match cfg.graph.resolve_file_node(&cfg.cwd, file) {
                    Some(node) => node,
                    None => continue,
                };
                let from_rel_path = rel_path_slash(&cfg.cwd, file);
                let to = cfg
                    .graph
                    .resolve_target_node(&cfg.cwd, &req.spec, resolved.as_deref());
                let to_rel_path = resolved
                    .as_deref()
                    .and_then(|resolved_path| rel_path_slash(&cfg.cwd, resolved_path));

                let Some(to) = to else {
                    if is_unmapped_external_import(&cfg.cwd, &req.spec, resolved.as_deref()) {
                        continue;
                    }
                    diags.push(LintDiag {
                        file: file.clone(),
                        offset: req.offset,
                        spec: Some(req.spec.clone()),
                        message: format!(
                            "graph: import {:?} does not match any declared internal node in `nodes`",
                            req.spec
                        ),
                        rule_name: None,
                        severity: Severity::Error,
                    });
                    continue;
                };

                let edge_detail = cfg.graph.check_edge_with_context_detail(
                    &from,
                    &to,
                    from_rel_path.as_deref(),
                    to_rel_path.as_deref(),
                    Some(&req.spec),
                );
                match edge_detail.result {
                    EdgeCheckResult::Allowed => {}
                    EdgeCheckResult::AllowedWithWarn(message) => {
                        diags.push(LintDiag {
                            file: file.clone(),
                            offset: req.offset,
                            spec: Some(req.spec.clone()),
                            message,
                            rule_name: edge_detail.rule_name,
                            severity: Severity::Warn,
                        });
                    }
                    EdgeCheckResult::Forbidden => {
                        let message = edge_detail.rule_message.unwrap_or_else(|| {
                            format!(
                                "graph: import {:?} is forbidden ({} -> {} has no directed edge)",
                                req.spec, from.concrete_id, to.concrete_id
                            )
                        });
                        diags.push(LintDiag {
                            file: file.clone(),
                            offset: req.offset,
                            spec: Some(req.spec.clone()),
                            message,
                            rule_name: edge_detail.rule_name,
                            severity: Severity::Error,
                        });
                    }
                }
            }

            diags
        })
        .collect()
}

/// Collect sources under every configured layer root (deduped).
pub fn collect_workspace_files(cfg: &ResolvedConfig, extra_ignore: &[String]) -> Vec<PathBuf> {
    let mut set = HashSet::new();
    for root in &cfg.source_roots {
        for p in collect_files_under(root, extra_ignore) {
            set.insert(p);
        }
    }
    let mut v: Vec<PathBuf> = set.into_iter().collect();
    v.sort();
    v
}

fn collect_files_under(root: &Path, extra_ignore: &[String]) -> Vec<PathBuf> {
    let mut builder = ignore::WalkBuilder::new(root);
    builder.standard_filters(true);
    builder.hidden(false);
    for rule in extra_ignore {
        builder.add_custom_ignore_filename(rule);
    }
    let exts: HashSet<&str> = ["ts", "tsx", "js", "jsx"].into_iter().collect();
    let mut out = Vec::new();
    for entry in builder.build().flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            if exts.contains(ext) {
                out.push(path.to_path_buf());
            }
        }
    }
    out.sort();
    out
}
