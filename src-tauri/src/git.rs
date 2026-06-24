//! Git source-control surface (spec 5.A.3, Phase 4). This first slice is
//! READ-ONLY: working-tree status, the current branch (+ ahead/behind), and a
//! per-file diff, by driving the installed `git` CLI in the workspace root.
//!
//! Git is a generic developer tool, not part of `claude`'s agent loop, so
//! shelling out to it does not violate the wrapper rule — and it matches the
//! installed binary exactly with no extra dependency. `git` is always invoked
//! with `-C <root>` (never by changing the process cwd), paths are validated to
//! stay inside the workspace, and this slice runs no mutating or destructive
//! command. Stage / unstage / commit and guarded discard land in later slices.

use std::path::Path;
use std::process::Command;

use serde::Serialize;

use crate::error::{IpcError, IpcErrorKind, IpcResult};

/// Diff sides are loaded into Monaco's diff editor (a viewer); cap each side so
/// a huge file can't balloon memory. Larger blobs are flagged via `binary` only
/// when non-text; oversize text is truncated to the cap.
const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// False when the workspace root isn't inside a git work tree (the panel
    /// then shows a calm "not a repository" state rather than an error).
    pub is_repo: bool,
    pub branch: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub changes: Vec<GitChange>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    /// Repo-relative path, forward-slashed.
    pub path: String,
    /// Original path for a rename/copy (else None).
    pub orig_path: Option<String>,
    /// modified | added | deleted | renamed | copied | typechange | untracked | conflicted
    pub status: String,
    /// In the staged (index) group vs the unstaged (working-tree) group. A file
    /// changed in both places appears once in each, like VS Code.
    pub staged: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    pub path: String,
    /// Left side of the diff (the version being changed from).
    pub original: String,
    /// Right side of the diff (the version being changed to).
    pub modified: String,
    pub staged: bool,
    /// Either side is non-text; both strings are empty and the UI shows a notice.
    pub binary: bool,
}

/// Working-tree status for the source-control panel. Newest git semantics:
/// staged changes (index) and unstaged changes (working tree) are separate
/// groups; untracked files are unstaged; conflicts are their own group.
pub fn status(cwd: Option<String>) -> IpcResult<GitStatus> {
    let root = crate::workspace::resolve_cwd(cwd)?;
    if !is_repo(&root) {
        return Ok(GitStatus {
            is_repo: false,
            branch: None,
            ahead: 0,
            behind: 0,
            changes: Vec::new(),
        });
    }
    let branch = run(&root, &["branch", "--show-current"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let (ahead, behind) = ahead_behind(&root);
    let out = run_bytes(&root, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])?;
    let changes = parse_porcelain_z(&out);
    Ok(GitStatus { is_repo: true, branch, ahead, behind, changes })
}

/// Two full sides of a file's diff for Monaco's diff editor. For staged changes
/// the diff is HEAD → index; for unstaged it's index → working tree. Missing
/// sides (a new/untracked or deleted file) come back as empty strings.
pub fn diff(cwd: Option<String>, path: String, staged: bool) -> IpcResult<GitDiff> {
    let root = crate::workspace::resolve_cwd(cwd)?;
    let rel = safe_rel(&path)?;

    let (orig_bytes, mod_bytes) = if staged {
        (show(&root, &format!("HEAD:{rel}")), show(&root, &format!(":{rel}")))
    } else {
        (show(&root, &format!(":{rel}")), read_worktree(&root, &rel))
    };

    let (original, lbin) = to_text(orig_bytes);
    let (modified, rbin) = to_text(mod_bytes);
    if lbin || rbin {
        return Ok(GitDiff { path: rel, original: String::new(), modified: String::new(), staged, binary: true });
    }
    Ok(GitDiff { path: rel, original, modified, staged, binary: false })
}

// ----- mutations: stage / unstage / commit (slice B; non-destructive) --------
// None of these can lose work: staging moves changes into the index, unstaging
// moves them back out (the working tree is never touched), and commit records
// the staged snapshot. Destructive ops (discard/reset --hard) are slice C and
// gated behind an explicit confirm.

/// Stage a path — a modification, addition, or deletion (`git add` records the
/// deletion of a removed file too).
pub fn stage(cwd: Option<String>, path: String) -> IpcResult<()> {
    let root = crate::workspace::resolve_cwd(cwd)?;
    let rel = safe_rel(&path)?;
    run_bytes(&root, &["add", "--", rel.as_str()])?;
    Ok(())
}

/// Unstage a path: move it out of the index (working tree untouched).
pub fn unstage(cwd: Option<String>, path: String) -> IpcResult<()> {
    let root = crate::workspace::resolve_cwd(cwd)?;
    let rel = safe_rel(&path)?;
    run_bytes(&root, &["restore", "--staged", "--", rel.as_str()])?;
    Ok(())
}

/// Stage every change (including untracked files and deletions).
pub fn stage_all(cwd: Option<String>) -> IpcResult<()> {
    let root = crate::workspace::resolve_cwd(cwd)?;
    run_bytes(&root, &["add", "-A"])?;
    Ok(())
}

/// Unstage everything: reset the index to HEAD (working tree untouched).
pub fn unstage_all(cwd: Option<String>) -> IpcResult<()> {
    let root = crate::workspace::resolve_cwd(cwd)?;
    run_bytes(&root, &["reset", "-q"])?;
    Ok(())
}

/// Commit the staged changes with `message`; returns git's short summary line.
/// Fails (surfaced to the UI) if the message is empty or nothing is staged.
pub fn commit(cwd: Option<String>, message: String) -> IpcResult<String> {
    let root = crate::workspace::resolve_cwd(cwd)?;
    let msg = message.trim();
    if msg.is_empty() {
        return Err(invalid("Commit message is empty"));
    }
    let out = run_bytes(&root, &["commit", "-m", msg])?;
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

// ----- porcelain parsing (pure; unit-tested) ---------------------------------

/// Parse `git status --porcelain=v1 -z` output. Records are NUL-separated;
/// `XY<space>path` with X = index (staged) state, Y = work-tree (unstaged)
/// state. Renames/copies emit the new path then a trailing NUL token with the
/// old path. A file changed in both index and work tree yields two changes.
fn parse_porcelain_z(bytes: &[u8]) -> Vec<GitChange> {
    let mut tokens = bytes
        .split(|&b| b == 0)
        .filter(|t| !t.is_empty())
        .map(|t| String::from_utf8_lossy(t).into_owned())
        .collect::<Vec<_>>()
        .into_iter();

    let mut changes = Vec::new();
    while let Some(entry) = tokens.next() {
        if entry.len() < 4 {
            continue; // need at least "XY p"
        }
        let b = entry.as_bytes();
        let x = b[0] as char;
        let y = b[1] as char;
        let path = entry[3..].to_string();

        // Rename/copy carries the original path as the following token.
        let orig = if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') {
            tokens.next()
        } else {
            None
        };

        if x == '?' && y == '?' {
            changes.push(GitChange { path, orig_path: None, status: "untracked".into(), staged: false });
            continue;
        }
        if x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
            changes.push(GitChange { path, orig_path: orig, status: "conflicted".into(), staged: false });
            continue;
        }
        if x != ' ' {
            changes.push(GitChange {
                path: path.clone(),
                orig_path: orig.clone(),
                status: code_label(x),
                staged: true,
            });
        }
        if y != ' ' {
            changes.push(GitChange { path, orig_path: orig, status: code_label(y), staged: false });
        }
    }
    changes
}

fn code_label(c: char) -> String {
    match c {
        'M' => "modified",
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'T' => "typechange",
        _ => "modified",
    }
    .to_string()
}

// ----- git invocation helpers ------------------------------------------------

fn is_repo(root: &Path) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false)
}

/// Ahead/behind vs the tracking upstream; (0, 0) when there is no upstream.
fn ahead_behind(root: &Path) -> (u32, u32) {
    match run(root, &["rev-list", "--count", "--left-right", "@{u}...HEAD"]) {
        Ok(s) => {
            let mut it = s.split_whitespace();
            let behind = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
            let ahead = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
            (ahead, behind)
        }
        Err(_) => (0, 0),
    }
}

/// Read an object's bytes (`git show <spec>`); empty on any failure (e.g. a new
/// file absent from HEAD, or a path absent from the index).
fn show(root: &Path, spec: &str) -> Vec<u8> {
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["show", spec])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| o.stdout)
        .unwrap_or_default()
}

fn read_worktree(root: &Path, rel: &str) -> Vec<u8> {
    std::fs::read(root.join(rel)).unwrap_or_default()
}

fn run(root: &Path, args: &[&str]) -> IpcResult<String> {
    Ok(String::from_utf8_lossy(&run_bytes(root, args)?).into_owned())
}

fn run_bytes(root: &Path, args: &[&str]) -> IpcResult<Vec<u8>> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|e| internal(format!("Could not run git: {e}")))?;
    if !out.status.success() {
        return Err(internal(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(out.stdout)
}

/// Cap and NUL-guard a diff side. Returns (text, is_binary).
fn to_text(bytes: Vec<u8>) -> (String, bool) {
    if bytes.contains(&0) {
        return (String::new(), true);
    }
    let slice = if bytes.len() > MAX_DIFF_BYTES { &bytes[..MAX_DIFF_BYTES] } else { &bytes[..] };
    (String::from_utf8_lossy(slice).into_owned(), false)
}

/// Validate a frontend-supplied repo-relative path WITHOUT touching the disk
/// (a diffed file may be deleted, so canonicalize won't work): reject absolute
/// paths and any `..` / root / prefix component. git itself confines to the repo.
fn safe_rel(path: &str) -> IpcResult<String> {
    let normalized = path.trim_start_matches(['/', '\\']).replace('\\', "/");
    let escapes = Path::new(&normalized).components().any(|c| {
        matches!(
            c,
            std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_)
        )
    });
    if normalized.is_empty() || escapes {
        return Err(invalid("Path is outside the workspace"));
    }
    Ok(normalized)
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

    #[test]
    fn parses_staged_unstaged_untracked_and_rename() {
        // " M a.rs" unstaged-modified; "M  b.rs" staged-modified;
        // "MM c.rs" both; "?? d.rs" untracked; "R  new.rs"+"old.rs" staged rename;
        // "D  gone.rs" staged delete.
        let buf = b" M a.rs\0M  b.rs\0MM c.rs\0?? d.rs\0R  new.rs\0old.rs\0D  gone.rs\0";
        let c = parse_porcelain_z(buf);
        assert_eq!(c.len(), 7); // a, b, c(x2), d, new, gone

        let a = c.iter().find(|c| c.path == "a.rs").unwrap();
        assert!(!a.staged && a.status == "modified");

        let b = c.iter().find(|c| c.path == "b.rs").unwrap();
        assert!(b.staged && b.status == "modified");

        // c.rs appears twice — once staged, once unstaged.
        assert_eq!(c.iter().filter(|c| c.path == "c.rs").count(), 2);
        assert!(c.iter().any(|c| c.path == "c.rs" && c.staged));
        assert!(c.iter().any(|c| c.path == "c.rs" && !c.staged));

        let d = c.iter().find(|c| c.path == "d.rs").unwrap();
        assert!(!d.staged && d.status == "untracked");

        let r = c.iter().find(|c| c.path == "new.rs").unwrap();
        assert!(r.staged && r.status == "renamed" && r.orig_path.as_deref() == Some("old.rs"));

        let g = c.iter().find(|c| c.path == "gone.rs").unwrap();
        assert!(g.staged && g.status == "deleted");
    }

    #[test]
    fn safe_rel_accepts_repo_paths_and_rejects_escape() {
        assert_eq!(safe_rel("src/main.rs").unwrap(), "src/main.rs");
        assert_eq!(safe_rel("/src/main.rs").unwrap(), "src/main.rs"); // leading slash trimmed
        assert!(safe_rel("../secret").is_err());
        assert!(safe_rel("a/../../b").is_err());
        assert!(safe_rel("").is_err());
    }
}
