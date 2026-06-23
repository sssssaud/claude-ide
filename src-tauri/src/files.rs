//! Workspace file access for the editor surface (spec 5.A.3, Phase 4).
//!
//! Read-only directory listing + file reads for the explorer and Monaco, all
//! STRICTLY confined to the workspace root (Phase 4 gate: "nothing touches paths
//! outside the workspace root"). Paths from the frontend are relative to the
//! root; every one is canonicalized and verified to stay inside the canonical
//! root before any fs access. Writes / save land in the next slice.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{IpcError, IpcErrorKind, IpcResult};

/// Max bytes loaded into the editor (a viewer, not a log tailer). Larger files
/// are read up to the cap and flagged `truncated`.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    /// Path relative to the workspace root, forward-slashed (e.g. `src/main.rs`).
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContents {
    pub path: String,
    pub text: String,
    /// File exceeded the cap; `text` holds the first `MAX_FILE_BYTES`.
    pub truncated: bool,
    /// Non-text (a NUL byte was found); `text` is empty.
    pub binary: bool,
}

/// List a directory's immediate children — directories first, then files, both
/// case-insensitive. `rel` is relative to the workspace root; empty/None = root.
pub fn list_dir(rel: Option<String>) -> IpcResult<Vec<DirEntry>> {
    let root = root_canon()?;
    let dir = resolve_within(&root, rel.as_deref().unwrap_or(""))?;
    if !dir.is_dir() {
        return Err(invalid("Not a directory"));
    }

    let mut out = Vec::new();
    let read =
        fs::read_dir(&dir).map_err(|e| internal(format!("Could not read the directory: {e}")))?;
    for entry in read {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        let is_dir = path.is_dir();
        let name = entry.file_name().to_string_lossy().into_owned();
        let rel_path = path
            .strip_prefix(&root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        out.push(DirEntry { name, path: rel_path, is_dir });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// Read a workspace file for the editor (UTF-8 text; size-capped; binary-guarded).
pub fn read_file(rel: String) -> IpcResult<FileContents> {
    let root = root_canon()?;
    let path = resolve_within(&root, &rel)?;
    if !path.is_file() {
        return Err(invalid("Not a file"));
    }
    let len = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let truncated = len > MAX_FILE_BYTES;

    let file =
        fs::File::open(&path).map_err(|e| internal(format!("Could not open the file: {e}")))?;
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|e| internal(format!("Could not read the file: {e}")))?;

    if bytes.contains(&0) {
        return Ok(FileContents { path: rel, text: String::new(), truncated: false, binary: true });
    }
    Ok(FileContents {
        path: rel,
        text: String::from_utf8_lossy(&bytes).into_owned(),
        truncated,
        binary: false,
    })
}

/// Overwrite an existing workspace file with `contents` (editor save). Confined
/// to the workspace root; only files that already exist may be written (the
/// editor only saves files it opened). Creating new files is a later slice.
pub fn write_file(rel: String, contents: String) -> IpcResult<()> {
    let root = root_canon()?;
    let path = resolve_within(&root, &rel)?;
    if !path.is_file() {
        return Err(invalid("Not a file"));
    }
    fs::write(&path, contents).map_err(|e| internal(format!("Could not save the file: {e}")))
}

fn root_canon() -> IpcResult<PathBuf> {
    let root = crate::workspace::resolve_cwd(None)?;
    fs::canonicalize(&root).map_err(|e| internal(format!("Cannot resolve the workspace root: {e}")))
}

/// Join `rel` onto the canonical `root` and confirm the canonical result stays
/// inside the root — the single guard against `..` / symlink escape.
fn resolve_within(root: &Path, rel: &str) -> IpcResult<PathBuf> {
    let rel = rel.trim_start_matches(|c| c == '/' || c == '\\');
    let joined = if rel.is_empty() { root.to_path_buf() } else { root.join(rel) };
    let canon = fs::canonicalize(&joined).map_err(|_| invalid("Path not found"))?;
    if !canon.starts_with(root) {
        return Err(invalid("Path is outside the workspace"));
    }
    Ok(canon)
}

fn internal(message: String) -> IpcError {
    IpcError::new(IpcErrorKind::Internal, message)
}

fn invalid(message: &str) -> IpcError {
    IpcError::new(IpcErrorKind::InvalidInput, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The crate's own dir is a stable, always-present root for the guard tests.
    fn root() -> PathBuf {
        fs::canonicalize(env!("CARGO_MANIFEST_DIR")).unwrap()
    }

    #[test]
    fn resolves_paths_inside_the_root() {
        let r = root();
        assert!(resolve_within(&r, "Cargo.toml").is_ok());
        assert!(resolve_within(&r, "").is_ok()); // the root itself
        assert!(resolve_within(&r, "/Cargo.toml").is_ok()); // leading slash tolerated
        assert!(resolve_within(&r, "src/lib.rs").is_ok());
    }

    #[test]
    fn rejects_escape_and_missing() {
        let r = root();
        assert!(resolve_within(&r, "../../../etc/passwd").is_err()); // climbs out
        assert!(resolve_within(&r, "..").is_err()); // parent of the root
        assert!(resolve_within(&r, "nope-does-not-exist.xyz").is_err());
    }
}
