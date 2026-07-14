//! Source parser wrappers for extracting import-like requests.

use std::collections::HashMap;
use std::path::Path;

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    ExportAllDeclaration, ExportNamedDeclaration, Expression, ImportDeclaration, ImportExpression,
    StringLiteral,
};
use oxc_ast_visit::Visit;
use oxc_parser::Parser;
use oxc_span::SourceType;

#[derive(Debug, Clone)]
pub struct ImportSpecifier {
    pub offset: u32,
    pub spec: String,
}

#[derive(Debug, Clone)]
pub struct ParsedFile {
    pub imports: Vec<ImportSpecifier>,
    pub ignore_directives: HashMap<usize, Vec<Option<String>>>,
}

impl ParsedFile {
    pub fn should_ignore(&self, line: usize, spec: &str) -> bool {
        let Some(rules) = self.ignore_directives.get(&line) else {
            return false;
        };
        rules.iter().any(|expr| match expr {
            None => true,
            Some(expr) => spec == expr || spec.contains(expr),
        })
    }
}

struct ImportVisit {
    hits: Vec<ImportSpecifier>,
}

impl<'a> Visit<'a> for ImportVisit {
    fn visit_import_declaration(&mut self, decl: &ImportDeclaration<'a>) {
        self.hits.push(ImportSpecifier {
            offset: decl.source.span.start,
            spec: decl.source.value.as_str().to_string(),
        });
    }

    fn visit_export_named_declaration(&mut self, decl: &ExportNamedDeclaration<'a>) {
        if let Some(src) = decl.source.as_ref() {
            self.hits.push(ImportSpecifier {
                offset: src.span.start,
                spec: src.value.as_str().to_string(),
            });
        }
    }

    fn visit_export_all_declaration(&mut self, decl: &ExportAllDeclaration<'a>) {
        self.hits.push(ImportSpecifier {
            offset: decl.source.span.start,
            spec: decl.source.value.as_str().to_string(),
        });
    }

    fn visit_import_expression(&mut self, expr: &ImportExpression<'a>) {
        if let Some(lit) = peel_string_literal(&expr.source) {
            self.hits.push(ImportSpecifier {
                offset: lit.span.start,
                spec: lit.value.as_str().to_string(),
            });
        }
    }
}

fn peel_string_literal<'ast, 'r>(expr: &'r Expression<'ast>) -> Option<&'r StringLiteral<'ast>> {
    match expr {
        Expression::StringLiteral(lit) => Some(lit),
        Expression::ParenthesizedExpression(w) => peel_string_literal(&w.expression),
        _ => None,
    }
}

fn source_type_for_path(path: &Path) -> SourceType {
    SourceType::from_path(path).unwrap_or_else(|_| {
        let mut t = SourceType::ts();
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if ext == "tsx" || ext == "jsx" {
            t = t.with_jsx(true);
        }
        t
    })
}

fn extract_imports(path: &Path, source_text: &str) -> Vec<ImportSpecifier> {
    let allocator = Allocator::default();
    let source_type = source_type_for_path(path);
    let ret = Parser::new(&allocator, source_text, source_type).parse();
    if ret.panicked {
        println!(
            "WARN: parser panicked for {:?}, skipping import collection",
            path
        );
        return Vec::new();
    }
    let mut v = ImportVisit { hits: Vec::new() };
    v.visit_program(&ret.program);
    v.hits
}

fn extract_ignore_expr(line: &str) -> Option<Option<String>> {
    let marker = "@jellylint-ignore";
    let idx = line.find(marker)?;
    let rest = line[idx + marker.len()..].trim();
    let Some(colon_idx) = rest.find(':') else {
        return Some(None);
    };
    let expr = rest[colon_idx + 1..].trim();
    if expr.is_empty() {
        Some(None)
    } else {
        Some(Some(expr.to_string()))
    }
}

fn is_comment_only_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("//") || trimmed.starts_with("/*") || trimmed.starts_with('*')
}

fn extract_ignore_directives(source_text: &str) -> HashMap<usize, Vec<Option<String>>> {
    let mut out: HashMap<usize, Vec<Option<String>>> = HashMap::new();
    for (idx, line) in source_text.lines().enumerate() {
        let line_num = idx + 1;
        let Some(expr) = extract_ignore_expr(line) else {
            continue;
        };
        let target_line = if is_comment_only_line(line) {
            line_num + 1
        } else {
            line_num
        };
        out.entry(target_line).or_default().push(expr);
    }
    out
}

pub fn parse_source(path: &Path, source_text: &str) -> ParsedFile {
    ParsedFile {
        imports: extract_imports(path, source_text),
        ignore_directives: extract_ignore_directives(source_text),
    }
}

#[cfg(test)]
mod tests {
    use super::parse_source;
    use std::path::Path;

    #[test]
    fn jellylint_ignore_on_previous_line_works() {
        let src = r#"
// @jellylint-ignore :@legacy
import x from '@legacy/utils'
import y from '@core/utils'
"#;
        let parsed = parse_source(Path::new("a.ts"), src);
        assert!(parsed.should_ignore(3, "@legacy/utils"));
        assert!(!parsed.should_ignore(4, "@core/utils"));
    }

    #[test]
    fn jellylint_ignore_without_expr_ignores_entire_line() {
        let src = "import z from '@legacy/a' // @jellylint-ignore";
        let parsed = parse_source(Path::new("a.ts"), src);
        assert!(parsed.should_ignore(1, "@legacy/a"));
        assert!(parsed.should_ignore(1, "@anything"));
    }
}
