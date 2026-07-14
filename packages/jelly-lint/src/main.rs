//! rejelly-jelly-lint — fast scope graph dependency checks for TS/JS workspaces.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use clap::Parser;

use rejelly_jelly_lint::config::resolve_config;
use rejelly_jelly_lint::engine::{build_resolver, collect_workspace_files, lint_workspace, LintDiag, Severity};

#[derive(Parser, Debug)]
#[command(name = "jelly-lint")]
#[command(about = "Lint imports via scope graph rules from jellylint.json[c] (Oxc + Rayon).")]
struct Cli {
    /// Project root: must contain a JellyLint config file unless `--config` is set. Default `.` is the process current directory.
    #[arg(long, default_value = ".")]
    cwd: PathBuf,

    /// JellyLint config path (default: first match among jellylint.json, jellylint.jsonc under cwd).
    #[arg(long)]
    config: Option<PathBuf>,

    /// Silence warning-level output and only report errors.
    #[arg(long)]
    quiet: bool,

    /// Only print diagnostics for the target rule.
    #[arg(long)]
    filter: Option<String>,
}

/// Maps a UTF-8 byte offset in `source` to 1-based line and column (for compiler-style terminal links).
fn get_line_col(source: &str, target_offset: usize) -> (usize, usize) {
    let mut line = 1;
    let mut col = 1;
    for (i, c) in source.char_indices() {
        if i >= target_offset {
            break;
        }
        if c == '\n' {
            line += 1;
            col = 1;
        } else {
            col += 1;
        }
    }
    (line, col)
}

fn char_col_to_byte_idx(text: &str, col: usize) -> usize {
    if col <= 1 {
        return 0;
    }
    for (idx, (byte_idx, _)) in text.char_indices().enumerate() {
        if idx + 1 == col {
            return byte_idx;
        }
    }
    text.len()
}

fn byte_idx_to_char_col(text: &str, byte_idx: usize) -> usize {
    text[..byte_idx.min(text.len())].chars().count() + 1
}

fn line_text_at_offset(source: &str, offset: usize) -> String {
    let bounded = offset.min(source.len());
    let line_start = source[..bounded].rfind('\n').map_or(0, |idx| idx + 1);
    let line_end = source[bounded..]
        .find('\n')
        .map_or(source.len(), |idx| bounded + idx);
    source[line_start..line_end].trim_end_matches('\r').to_string()
}

fn marker_for_line(line_text: &str, col: usize, spec: Option<&str>) -> (usize, usize) {
    if line_text.is_empty() {
        return (1, 1);
    }

    let fallback_start = col.max(1).min(line_text.chars().count().max(1));
    let mut start_col = fallback_start;
    let mut len = 1usize;

    if let Some(spec) = spec {
        if !spec.is_empty() {
            let search_from = char_col_to_byte_idx(line_text, fallback_start);
            let found = line_text[search_from..]
                .find(spec)
                .map(|idx| search_from + idx)
                .or_else(|| line_text.find(spec));
            if let Some(start_byte) = found {
                start_col = byte_idx_to_char_col(line_text, start_byte);
                len = spec.chars().count().max(1);
            }
        }
    }

    (start_col, len)
}

fn print_grouped_diagnostic(file: &PathBuf, diag: &LintDiag) {
    let source_text = std::fs::read_to_string(file).unwrap_or_else(|_| String::from("(could not read file)"));
    let offset = diag.offset as usize;
    let (line, col) = get_line_col(&source_text, offset);
    let line_text = line_text_at_offset(&source_text, offset);
    let (marker_start, marker_len) = marker_for_line(&line_text, col, diag.spec.as_deref());
    let severity = match diag.severity {
        Severity::Warn => "warning",
        Severity::Error => "error",
    };
    let rule_name = diag.rule_name.as_deref().unwrap_or("graph");
    let marker_padding = " ".repeat(marker_start.saturating_sub(1));
    let marker = "^".repeat(marker_len.max(1));

    eprintln!(
        "  {}:{}  {}  {}  {}",
        line, col, severity, diag.message, rule_name
    );
    eprintln!("        at {}:{}:{}", file.display(), line, col);
    eprintln!("        │");
    eprintln!("        │ {}", line_text);
    eprintln!("        │ {}{}", marker_padding, marker);
    eprintln!();
}

fn diag_rule_name(diag: &LintDiag) -> &str {
    diag.rule_name.as_deref().unwrap_or("graph")
}

fn main() -> miette::Result<()> {
    let cli = Cli::parse();
    // dunce: strip Windows `\\?\` verbatim prefix from canonicalize so path logic and oxc tsconfig discovery work reliably.
    let cwd = dunce::canonicalize(&cli.cwd).map_err(|e| miette::miette!("cwd: {e}"))?;

    let cfg = resolve_config(&cwd, cli.config.as_deref()).map_err(|e| miette::miette!("{e}"))?;
    for warning in &cfg.startup_warnings {
        eprintln!("WARN {warning}");
    }

    let resolver = Arc::new(build_resolver());

    let files = collect_workspace_files(&cfg, &[]);
    if files.is_empty() {
        println!(
            "jelly-lint: no source files under configured scope roots ({})",
            cfg.source_roots.len()
        );
        return Ok(());
    }

    let diags = lint_workspace(&cfg, &files, resolver, cli.quiet);

    if diags.is_empty() {
        println!(
            "jelly-lint: OK ({} files across {} nodes)",
            files.len(),
            cfg.graph.node_count()
        );
        return Ok(());
    }

    let mut grouped: BTreeMap<PathBuf, Vec<&LintDiag>> = BTreeMap::new();
    let mut visible_warning_count = 0usize;
    let mut visible_error_count = 0usize;
    let mut total_warning_count = 0usize;
    let mut total_error_count = 0usize;

    let filter = cli.filter.as_deref();
    for d in &diags {
        match d.severity {
            Severity::Warn => total_warning_count += 1,
            Severity::Error => total_error_count += 1,
        }

        if cli.quiet && matches!(d.severity, Severity::Warn) {
            continue;
        }
        if let Some(filter_rule) = filter {
            if diag_rule_name(d) != filter_rule {
                continue;
            }
        }

        match d.severity {
            Severity::Warn => visible_warning_count += 1,
            Severity::Error => visible_error_count += 1,
        }
        grouped.entry(d.file.clone()).or_default().push(d);
    }

    for (file, entries) in &mut grouped {
        entries.sort_by_key(|d| {
            let source = std::fs::read_to_string(&d.file).unwrap_or_default();
            get_line_col(&source, d.offset as usize)
        });
        eprintln!("{}", file.display());
        for diag in entries.iter() {
            print_grouped_diagnostic(file, diag);
        }
    }

    let visible_problem_count = visible_warning_count + visible_error_count;
    if visible_problem_count > 0 {
        eprintln!(
            "✖ {} problems ({} errors, {} warnings)",
            visible_problem_count, visible_error_count, visible_warning_count
        );
    }

    let hidden_warning_count = total_warning_count.saturating_sub(visible_warning_count);
    let hidden_error_count = total_error_count.saturating_sub(visible_error_count);
    let hidden_problem_count = hidden_warning_count + hidden_error_count;
    if hidden_problem_count > 0 {
        if let Some(filter_rule) = filter {
            eprintln!(
                "ℹ output filtered by rule {:?}; hidden {} problems ({} errors, {} warnings)",
                filter_rule, hidden_problem_count, hidden_error_count, hidden_warning_count
            );
        } else if cli.quiet {
            eprintln!(
                "ℹ --quiet hid {} warning(s); hidden {} problems in total",
                hidden_warning_count, hidden_problem_count
            );
        }
    }

    if total_error_count > 0 {
        std::process::exit(1);
    }
    Ok(())
}
