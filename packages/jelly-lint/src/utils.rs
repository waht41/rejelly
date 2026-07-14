//! Shared path utilities across config parsing and lint pipeline.

use std::path::{Component, Path, PathBuf};

/// Normalize `.` / `..` while preserving Windows `Prefix` / `RootDir`.
pub fn normalize_path(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::Prefix(pref) => out.push(pref.as_os_str()),
            Component::RootDir => out.push(c.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(x) => out.push(x),
        }
    }
    out
}

/// Return normalized slash-separated path relative to `base`.
pub fn rel_path_slash(base: &Path, path: &Path) -> Option<String> {
    let base = normalize_path(base);
    let path = normalize_path(path);
    let stripped = path.strip_prefix(&base).ok()?;
    Some(
        stripped
            .components()
            .filter_map(|c| match c {
                Component::Normal(s) => s.to_str(),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("/"),
    )
}
