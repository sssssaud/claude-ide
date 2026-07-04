//! Workspace file access for the editor surface (spec 5.A.3, Phase 4).
//!
//! Read-only directory listing + file reads for the explorer and Monaco, all
//! STRICTLY confined to the workspace root (Phase 4 gate: "nothing touches paths
//! outside the workspace root"). Paths from the frontend are relative to the
//! root; every one is canonicalized and verified to stay inside the canonical
//! root before any fs access. Writes / save land in the next slice.

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{IpcError, IpcErrorKind, IpcResult};

/// Max bytes loaded into the editor (a viewer, not a log tailer). Larger files
/// are read up to the cap and flagged `truncated`.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Max length for a single path component name (comfortably under the ~255-byte
/// limit most filesystems enforce).
const MAX_NAME_LEN: usize = 200;

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
/// `cwd` selects which workspace root (Phase 5 multi-workspace); None = default.
pub fn list_dir(cwd: Option<String>, rel: Option<String>) -> IpcResult<Vec<DirEntry>> {
    let root = root_canon(cwd)?;
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
pub fn read_file(cwd: Option<String>, rel: String) -> IpcResult<FileContents> {
    let root = root_canon(cwd)?;
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
pub fn write_file(cwd: Option<String>, rel: String, contents: String) -> IpcResult<()> {
    let root = root_canon(cwd)?;
    let path = resolve_within(&root, &rel)?;
    if !path.is_file() {
        return Err(invalid("Not a file"));
    }
    // SECURITY: this slice is safe only because `resolve_within` canonicalizes an
    // EXISTING path and the `is_file` gate rejects anything else — so `..`/symlink
    // escape is impossible here. A future "create new file" slice CANNOT reuse
    // this as-is: a not-yet-existing target can't be canonicalized, and skipping
    // the canonicalize+containment check to allow it would reopen the escape hole.
    // The correct pattern is to canonicalize the (existing) PARENT directory,
    // confirm IT starts_with(root), then append a single validated path component
    // (no separators, no `.`/`..`). See `resolve_within`'s SECURITY note.
    fs::write(&path, contents).map_err(|e| internal(format!("Could not save the file: {e}")))
}

/// Create a new empty file or directory inside the workspace (Addendum II §S7).
/// `parent_rel` is an EXISTING directory relative to the workspace root (empty =
/// the root itself); `name` is validated as a single path component. Confined
/// per `resolve_within`'s documented pattern for a not-yet-existing target: the
/// parent is canonicalized+containment-checked (it already exists), then one
/// validated component is appended — never canonicalizing the target itself.
pub fn create_entry(
    cwd: Option<String>,
    parent_rel: String,
    name: String,
    is_dir: bool,
) -> IpcResult<DirEntry> {
    let root = root_canon(cwd)?;
    let parent = resolve_within(&root, &parent_rel)?;
    if !parent.is_dir() {
        return Err(invalid("Parent is not a directory"));
    }
    let name = validate_component(&name)?;
    let target = parent.join(name);
    if is_dir {
        fs::create_dir(&target).map_err(|e| create_err(e, "folder"))?;
    } else {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|e| create_err(e, "file"))?;
    }
    let rel_path = target.strip_prefix(&root).unwrap_or(&target).to_string_lossy().replace('\\', "/");
    Ok(DirEntry { name: name.to_string(), path: rel_path, is_dir })
}

/// Duplicate an existing workspace file next to itself, auto-numbering the name
/// ("foo.txt" -> "foo copy.txt" -> "foo copy 2.txt" -> ...) until a free one is
/// found (Addendum II §S7). Source is resolved via `resolve_within` (must
/// already exist); the generated name is appended to the same already-
/// containment-checked parent, same pattern as `create_entry`.
pub fn duplicate_file(cwd: Option<String>, rel: String) -> IpcResult<DirEntry> {
    let root = root_canon(cwd)?;
    let source = resolve_within(&root, &rel)?;
    if !source.is_file() {
        return Err(invalid("Not a file"));
    }
    let parent = source
        .parent()
        .ok_or_else(|| internal("The file has no parent directory".to_string()))?;
    let stem = source.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = source.extension().map(|s| s.to_string_lossy().into_owned());

    for n in 0..1000 {
        let candidate = match (&ext, n) {
            (Some(e), 0) => format!("{stem} copy.{e}"),
            (None, 0) => format!("{stem} copy"),
            (Some(e), n) => format!("{stem} copy {}.{e}", n + 1),
            (None, n) => format!("{stem} copy {}", n + 1),
        };
        let name = validate_component(&candidate)?;
        let target = parent.join(name);
        let mut dest = match fs::OpenOptions::new().write(true).create_new(true).open(&target) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(internal(format!("Could not duplicate the file: {e}"))),
        };
        let mut src =
            fs::File::open(&source).map_err(|e| internal(format!("Could not read the file: {e}")))?;
        io::copy(&mut src, &mut dest)
            .map_err(|e| internal(format!("Could not duplicate the file: {e}")))?;
        let rel_path = target.strip_prefix(&root).unwrap_or(&target).to_string_lossy().replace('\\', "/");
        return Ok(DirEntry { name: name.to_string(), path: rel_path, is_dir: false });
    }
    Err(invalid("Too many copies of this file already exist"))
}

/// Validate a single path component intended to be appended to an already
/// containment-checked, EXISTING parent — the "append one validated component"
/// half of the create-new-file pattern documented on `resolve_within` below.
/// Rejects empty, `.`/`..`, any path separator, a NUL byte, and anything over
/// the filesystem's typical component-length limit.
fn validate_component(name: &str) -> IpcResult<&str> {
    let name = name.trim();
    if name.is_empty() || name.len() > MAX_NAME_LEN {
        return Err(invalid("Name is empty or too long"));
    }
    if name == "." || name == ".." {
        return Err(invalid("Name cannot be \".\" or \"..\""));
    }
    if name.contains(['/', '\\']) {
        return Err(invalid("Name cannot contain a path separator"));
    }
    if name.contains('\0') {
        return Err(invalid("Name contains a null byte"));
    }
    Ok(name)
}

fn create_err(e: io::Error, kind: &str) -> IpcError {
    if e.kind() == io::ErrorKind::AlreadyExists {
        invalid("Something with that name already exists")
    } else {
        internal(format!("Could not create the {kind}: {e}"))
    }
}

fn root_canon(cwd: Option<String>) -> IpcResult<PathBuf> {
    let root = crate::workspace::resolve_cwd(cwd)?;
    fs::canonicalize(&root).map_err(|e| internal(format!("Cannot resolve the workspace root: {e}")))
}

/// Resolve + containment-check a workspace-relative path, for callers outside
/// this module that need a validated absolute path rather than file contents
/// (Addendum II §S7 — "reveal in file manager", scoped to `resolve_within`).
pub fn workspace_path(cwd: Option<String>, rel: &str) -> IpcResult<PathBuf> {
    let root = root_canon(cwd)?;
    resolve_within(&root, rel)
}

/// Join `rel` onto the canonical `root` and confirm the canonical result stays
/// inside the root — the single guard against `..` / symlink escape.
///
/// SECURITY: containment holds because `fs::canonicalize` resolves the FULL path
/// (every `..` and symlink) before the `starts_with(root)` check — and it only
/// succeeds for a path that already EXISTS. That existence requirement is load-
/// bearing: it is why this guard is sound for read/overwrite. Do NOT relax it to
/// accept missing paths (e.g. for create-new-file) by canonicalizing only a
/// prefix or skipping canonicalize — that reopens the escape. To support a
/// not-yet-existing target, canonicalize its existing parent, containment-check
/// the parent, then append one validated component (reject separators and `..`).
fn resolve_within(root: &Path, rel: &str) -> IpcResult<PathBuf> {
    let rel = rel.trim_start_matches(['/', '\\']);
    let joined = if rel.is_empty() { root.to_path_buf() } else { root.join(rel) };
    let canon = fs::canonicalize(&joined).map_err(|_| invalid("Path not found"))?;
    if !canon.starts_with(root) {
        return Err(invalid("Path is outside the workspace"));
    }
    Ok(canon)
}

/// Attachment size caps (raw bytes, pre-base64): match the API's practical
/// limits — ~5MB per image, PDFs well under the 32MB request cap, text kept
/// small because it lands inline in the prompt.
const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_PDF_BYTES: u64 = 20 * 1024 * 1024;
const MAX_ATTACH_TEXT_BYTES: u64 = 400 * 1024;

/// Read a user-picked file into a composer `Attachment` (see commands.rs
/// `read_attachment` for the trust story). Classification is by extension:
/// images and PDFs are base64-encoded, UTF-8 text passes through, video/audio
/// gets an honest "can't watch video" refusal, and any other binary is refused.
pub fn read_attachment(path: &str) -> IpcResult<crate::engine::Attachment> {
    use base64::Engine as _;

    let path = Path::new(path.trim());
    let canon = fs::canonicalize(path).map_err(|e| invalid(&format!("Cannot open the file: {e}")))?;
    if !canon.is_file() {
        return Err(invalid("Not a file"));
    }
    let name = canon
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "attachment".to_owned());
    let ext = canon
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();

    let (kind, media_type, cap) = match ext.as_str() {
        "png" => ("image", "image/png", MAX_IMAGE_BYTES),
        "jpg" | "jpeg" => ("image", "image/jpeg", MAX_IMAGE_BYTES),
        "gif" => ("image", "image/gif", MAX_IMAGE_BYTES),
        "webp" => ("image", "image/webp", MAX_IMAGE_BYTES),
        "pdf" => ("document", "application/pdf", MAX_PDF_BYTES),
        "mp4" | "mkv" | "avi" | "mov" | "webm" | "m4v" | "mp3" | "wav" | "ogg" | "flac"
        | "m4a" => {
            return Err(invalid(
                "Claude can't watch videos or listen to audio. Attach an image, a PDF, or a text file instead.",
            ))
        }
        _ => ("text", "text/plain", MAX_ATTACH_TEXT_BYTES),
    };

    let len = fs::metadata(&canon).map(|m| m.len()).unwrap_or(u64::MAX);
    if len > cap {
        return Err(invalid(&format!(
            "{name} is too large to attach (max {}MB for this type)",
            cap / (1024 * 1024)
        )));
    }
    let bytes = fs::read(&canon).map_err(|e| internal(format!("Could not read {name}: {e}")))?;

    let data = match kind {
        "text" => String::from_utf8(bytes).map_err(|_| {
            invalid(&format!(
                "{name} is a binary file Claude can't take as an attachment. Supported: images (PNG/JPEG/GIF/WebP), PDF, and text files."
            ))
        })?,
        _ => base64::engine::general_purpose::STANDARD.encode(bytes),
    };

    Ok(crate::engine::Attachment {
        name,
        kind: kind.to_owned(),
        media_type: media_type.to_owned(),
        data,
    })
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

    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_dir() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let mut p = std::env::temp_dir();
        p.push(format!("claude-ide-files-test-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn cwd_str(dir: &Path) -> Option<String> {
        Some(dir.display().to_string())
    }

    #[test]
    fn create_entry_makes_a_file_and_a_folder() {
        let dir = temp_dir();
        let file = create_entry(cwd_str(&dir), String::new(), "note.txt".into(), false).unwrap();
        assert_eq!(file.path, "note.txt");
        assert!(dir.join("note.txt").is_file());

        let folder = create_entry(cwd_str(&dir), String::new(), "sub".into(), true).unwrap();
        assert_eq!(folder.path, "sub");
        assert!(dir.join("sub").is_dir());

        // Nested inside the just-created folder.
        let nested = create_entry(cwd_str(&dir), "sub".into(), "deep.txt".into(), false).unwrap();
        assert_eq!(nested.path, "sub/deep.txt");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_entry_rejects_escape_and_collision() {
        let dir = temp_dir();
        create_entry(cwd_str(&dir), String::new(), "note.txt".into(), false).unwrap();

        assert!(create_entry(cwd_str(&dir), String::new(), "note.txt".into(), false).is_err()); // already exists
        assert!(create_entry(cwd_str(&dir), String::new(), "..".into(), true).is_err());
        assert!(create_entry(cwd_str(&dir), String::new(), "a/b".into(), false).is_err()); // embedded separator
        assert!(create_entry(cwd_str(&dir), "does-not-exist".into(), "x.txt".into(), false).is_err()); // bad parent
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn duplicate_file_auto_numbers() {
        let dir = temp_dir();
        fs::write(dir.join("a.txt"), b"hello").unwrap();

        let first = duplicate_file(cwd_str(&dir), "a.txt".into()).unwrap();
        assert_eq!(first.path, "a copy.txt");
        assert_eq!(fs::read_to_string(dir.join("a copy.txt")).unwrap(), "hello");

        let second = duplicate_file(cwd_str(&dir), "a.txt".into()).unwrap();
        assert_eq!(second.path, "a copy 2.txt");

        assert!(duplicate_file(cwd_str(&dir), "missing.txt".into()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
