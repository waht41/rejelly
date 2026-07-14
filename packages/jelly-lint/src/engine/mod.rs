use std::path::PathBuf;

pub mod resolver;
pub mod runner;

pub use resolver::build_resolver;
pub use runner::{collect_workspace_files, lint_workspace};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warn,
}

#[derive(Debug)]
pub struct LintDiag {
    pub file: PathBuf,
    pub offset: u32,
    pub spec: Option<String>,
    pub message: String,
    pub rule_name: Option<String>,
    pub severity: Severity,
}
