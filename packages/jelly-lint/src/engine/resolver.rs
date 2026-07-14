use std::path::{Path, PathBuf};

use oxc_resolver::{ResolveOptions, Resolver, TsconfigDiscovery};

/// Resolver with per-file tsconfig discovery (`TsconfigDiscovery::Auto` requires [`Resolver::resolve_file`]).
pub fn build_resolver() -> Resolver {
    let options = ResolveOptions {
        // Follow symlinks so pnpm `.pnpm` store layouts resolve like Node does.
        symlinks: true,
        extensions: vec![
            ".tsx".into(),
            ".ts".into(),
            ".jsx".into(),
            ".js".into(),
            ".mjs".into(),
            ".cjs".into(),
            ".json".into(),
        ],
        extension_alias: vec![(
            ".js".into(),
            vec![".ts".into(), ".tsx".into(), ".js".into(), ".jsx".into()],
        )],
        condition_names: vec![
            "import".into(),
            "require".into(),
            "node".into(),
            "default".into(),
        ],
        tsconfig: Some(TsconfigDiscovery::Auto),
        ..ResolveOptions::default()
    };
    Resolver::new(options)
}

pub fn should_skip_specifier(spec: &str) -> bool {
    let s = spec.trim();
    s.is_empty()
        || s.starts_with("http:")
        || s.starts_with("https:")
        || s.starts_with("node:")
        || s.starts_with("data:")
        || s.starts_with('!')
}

pub fn resolve_for_scope_check(resolver: &Resolver, file: &Path, spec: &str) -> Option<PathBuf> {
    let resolution = match resolver.resolve_file(file, spec) {
        Ok(r) => r,
        Err(e) => {
            println!("WARN: resolve failed for {:?} from {:?}: {:?}", spec, file, e);
            return None;
        }
    };
    Some(resolution.full_path().to_path_buf())
}
