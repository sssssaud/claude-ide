//! Project-scoped custom sub-agent definitions (Addendum II §S8, project-only).
//!
//! Author/edit/delete `.claude/agents/*.md` — the real file format the `claude`
//! CLI loads custom sub-agents from (YAML frontmatter: name/description/tools/
//! model, then a markdown body as the system prompt; confirmed against real
//! files shipped with installed plugins). This is a thin, dedicated authoring
//! surface for files the CLI itself owns and interprets — we never invoke or
//! validate agent behavior ourselves, only read/write the definition files.
//!
//! No new YAML dependency: `serde_yaml` is deprecated/archived and the schema
//! this app WRITES is narrow (four flat, single-line scalars) — a small
//! hand-rolled parser/writer is simpler and more honest than pulling in a YAML
//! crate for that. Reading is deliberately tolerant (missing/foreign frontmatter
//! never hides a file, just shows blank fields) since hand-edited or
//! plugin-shipped files may use YAML this app doesn't attempt to fully parse.
//!
//! Scoped to the PROJECT's `.claude/agents/` only — the user-global
//! `~/.claude/agents/` directory is explicitly deferred to a later phase.
//! Distinct from `agents.rs` (the unrelated live/background-session dashboard
//! over `claude agents --json`) — different file, different concept, same
//! "Agents" umbrella in the UI.

use std::fs;
use std::io::Write as _;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{IpcError, IpcErrorKind, IpcResult};

const MAX_PROMPT_BYTES: usize = 100_000;
const MAX_DESCRIPTION_LEN: usize = 500;
const MAX_MODEL_LEN: usize = 100;
const MAX_TOOL_LEN: usize = 100;
const MAX_TOOLS: usize = 100;
const MAX_SLUG_LEN: usize = 64;

/// One agent definition, as authored/edited in the UI.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDef {
    /// Filename stem == frontmatter `name` (kebab-case, validated).
    pub slug: String,
    pub description: String,
    /// Empty = omit `tools:` (CLI inherits all built-in tools).
    #[serde(default)]
    pub tools: Vec<String>,
    /// Empty = omit `model:` (CLI inherits the session default).
    #[serde(default)]
    pub model: String,
    pub prompt: String,
}

/// A list-view row (Addendum II §S8 panel list).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefSummary {
    pub slug: String,
    pub description: String,
    pub tools: Vec<String>,
    pub model: String,
}

/// List every `.claude/agents/*.md` in the project. Tolerant of a missing
/// directory (empty list) and of files this app can't cleanly parse (still
/// listed, with blank fields, rather than hidden).
pub fn list(cwd: Option<String>) -> IpcResult<Vec<AgentDefSummary>> {
    let dir = agents_dir_raw(cwd)?;
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let read = fs::read_dir(&dir)
        .map_err(|e| internal(format!("Could not read .claude/agents: {e}")))?;
    let mut out = Vec::new();
    for entry in read {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(slug) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        let Ok(text) = fs::read_to_string(&path) else { continue };
        let (front, _body) = split_frontmatter(&text);
        let fields = parse_frontmatter(front.as_deref().unwrap_or(""));
        out.push(AgentDefSummary {
            slug: slug.to_owned(),
            description: fields.description,
            tools: fields.tools,
            model: fields.model,
        });
    }
    out.sort_by(|a, b| a.slug.cmp(&b.slug));
    Ok(out)
}

/// Read one agent definition's full contents (frontmatter + prompt body).
pub fn read(cwd: Option<String>, slug: String) -> IpcResult<AgentDef> {
    let slug = validate_slug(&slug)?.to_owned();
    let dir = agents_dir_raw(cwd)?;
    let path = resolve_agent_file(&dir, &slug)?;
    let text = fs::read_to_string(&path)
        .map_err(|e| internal(format!("Could not read the agent file: {e}")))?;
    let (front, body) = split_frontmatter(&text);
    let fields = parse_frontmatter(front.as_deref().unwrap_or(""));
    Ok(AgentDef {
        slug,
        description: fields.description,
        tools: fields.tools,
        model: fields.model,
        prompt: body.trim().to_owned(),
    })
}

/// Create a new agent definition; fails if the slug is already taken.
///
/// Confined per `files.rs`'s canonicalize-parent-and-contain pattern, extended
/// one level for a directory that may not exist yet: `.claude` and
/// `.claude/agents` are fixed literal components (never caller-supplied),
/// created via `create_dir_all` off the canonical workspace root and then
/// re-canonicalized (`ensure_agents_dir`) — only THEN is the caller-chosen slug
/// (already restricted to a safe kebab-case charset by `validate_slug`, so it
/// can contain no separator or `..`) appended as a single path component.
pub fn create(cwd: Option<String>, def: AgentDef) -> IpcResult<AgentDefSummary> {
    let def = sanitize(def)?;
    let dir = ensure_agents_dir(cwd)?;
    let path = dir.join(format!("{}.md", def.slug));
    let text = render(&def);
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .and_then(|mut f| f.write_all(text.as_bytes()))
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                invalid("An agent with that name already exists")
            } else {
                internal(format!("Could not create the agent: {e}"))
            }
        })?;
    Ok(summary(&def))
}

/// Overwrite an existing agent definition (or rename it, by changing `slug`).
/// The target already exists, so this resolves+contains it directly (like a
/// normal file open) rather than the append-a-component path `create` uses.
pub fn update(cwd: Option<String>, original_slug: String, def: AgentDef) -> IpcResult<AgentDefSummary> {
    let original_slug = validate_slug(&original_slug)?.to_owned();
    let def = sanitize(def)?;
    let dir = agents_dir_raw(cwd)?;
    let existing = resolve_agent_file(&dir, &original_slug)?;

    if def.slug == original_slug {
        let text = render(&def);
        fs::write(&existing, text).map_err(|e| internal(format!("Could not save the agent: {e}")))?;
    } else {
        // Rename: write the new file first, remove the old one only on success,
        // so a mid-way failure never leaves zero copies of the agent behind.
        let new_path = dir.join(format!("{}.md", def.slug));
        if new_path.exists() {
            return Err(invalid("An agent with that name already exists"));
        }
        let text = render(&def);
        fs::write(&new_path, text).map_err(|e| internal(format!("Could not save the agent: {e}")))?;
        let _ = fs::remove_file(&existing);
    }
    Ok(summary(&def))
}

/// Delete an agent definition file.
pub fn delete(cwd: Option<String>, slug: String) -> IpcResult<()> {
    let slug = validate_slug(&slug)?.to_owned();
    let dir = agents_dir_raw(cwd)?;
    let existing = resolve_agent_file(&dir, &slug)?;
    fs::remove_file(&existing).map_err(|e| internal(format!("Could not delete the agent: {e}")))
}

// ----- path helpers -----------------------------------------------------

/// `<canonical workspace root>/.claude/agents` — may not exist yet. Built from
/// the canonical root plus fixed literals only (no caller-supplied segments).
fn agents_dir_raw(cwd: Option<String>) -> IpcResult<PathBuf> {
    let root = crate::workspace::resolve_cwd(cwd)?;
    let root = fs::canonicalize(&root)
        .map_err(|e| internal(format!("Cannot resolve the workspace root: {e}")))?;
    Ok(root.join(".claude").join("agents"))
}

/// Same as `agents_dir_raw`, but ensures the directory exists and returns its
/// canonical form (for `create`'s append-one-component step).
fn ensure_agents_dir(cwd: Option<String>) -> IpcResult<PathBuf> {
    let dir = agents_dir_raw(cwd)?;
    fs::create_dir_all(&dir).map_err(|e| internal(format!("Could not create .claude/agents: {e}")))?;
    fs::canonicalize(&dir).map_err(|e| internal(format!("Could not resolve .claude/agents: {e}")))
}

/// Canonicalize `dir` (must already exist) and confirm `<dir>/<slug>.md`
/// stays inside it — the same escape guard as `files.rs::resolve_within`,
/// scoped to the agents directory instead of the whole workspace root.
fn resolve_agent_file(dir: &std::path::Path, slug: &str) -> IpcResult<PathBuf> {
    let dir_canon = fs::canonicalize(dir).map_err(|_| invalid("No agent with that name"))?;
    let joined = dir_canon.join(format!("{slug}.md"));
    let canon = fs::canonicalize(&joined).map_err(|_| invalid("No agent with that name"))?;
    if !canon.starts_with(&dir_canon) || !canon.is_file() {
        return Err(invalid("No agent with that name"));
    }
    Ok(canon)
}

// ----- validation ---------------------------------------------------------

/// Lowercase kebab-case only (matches the two real conventions observed: the
/// filename stem and the frontmatter `name:` are the same string, and it
/// doubles as the CLI's `--agent <name>` identifier).
fn validate_slug(slug: &str) -> IpcResult<&str> {
    let slug = slug.trim();
    if slug.is_empty() || slug.len() > MAX_SLUG_LEN {
        return Err(invalid("Agent name must be 1-64 characters"));
    }
    let charset_ok = slug.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !charset_ok || slug.starts_with('-') || slug.ends_with('-') || slug.contains("--") {
        return Err(invalid(
            "Agent name must be lowercase kebab-case (letters, digits, single hyphens)",
        ));
    }
    Ok(slug)
}

fn sanitize(mut def: AgentDef) -> IpcResult<AgentDef> {
    def.slug = validate_slug(&def.slug)?.to_owned();

    def.description = single_line(&def.description, MAX_DESCRIPTION_LEN, "Description")?;
    if def.description.is_empty() {
        return Err(invalid("A description is required"));
    }

    def.model = single_line(&def.model, MAX_MODEL_LEN, "Model")?;

    let mut tools: Vec<String> = Vec::new();
    for raw in def.tools {
        let t = raw.trim();
        if t.is_empty() {
            continue;
        }
        if t.len() > MAX_TOOL_LEN || !t.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return Err(invalid("Tool names may only contain letters, digits, - and _"));
        }
        if !tools.iter().any(|e| e == t) {
            tools.push(t.to_owned());
        }
        if tools.len() > MAX_TOOLS {
            return Err(invalid("Too many tools"));
        }
    }
    def.tools = tools;

    if def.prompt.len() > MAX_PROMPT_BYTES {
        return Err(invalid("The system prompt is too long"));
    }
    let prompt = def.prompt.trim();
    if prompt.is_empty() {
        return Err(invalid("A system prompt is required"));
    }
    def.prompt = prompt.to_owned();

    Ok(def)
}

fn single_line(s: &str, max: usize, label: &str) -> IpcResult<String> {
    let s = s.trim();
    if s.contains(['\n', '\r']) {
        return Err(invalid(&format!("{label} cannot contain a line break")));
    }
    if s.len() > max {
        return Err(invalid(&format!("{label} is too long")));
    }
    Ok(s.to_owned())
}

fn summary(def: &AgentDef) -> AgentDefSummary {
    AgentDefSummary {
        slug: def.slug.clone(),
        description: def.description.clone(),
        tools: def.tools.clone(),
        model: def.model.clone(),
    }
}

// ----- frontmatter render / parse -----------------------------------------
//
// Hand-rolled instead of a YAML crate (see module doc). `render` is the only
// writer this app uses, so it fully controls the shape; `parse_frontmatter` is
// best-effort tolerant of anything else (hand-edited files, plugin-shipped
// examples using plain unquoted scalars) — a field it can't confidently read
// just comes back blank, it never errors or hides the file.

struct Fields {
    description: String,
    tools: Vec<String>,
    model: String,
}

/// Split into (frontmatter lines joined by `\n`, body). `None` frontmatter
/// means no well-formed `---`-delimited block was found (body = whole text).
fn split_frontmatter(text: &str) -> (Option<String>, String) {
    let mut lines = text.lines();
    match lines.next() {
        Some(first) if first.trim_end() == "---" => {}
        _ => return (None, text.to_owned()),
    }
    let mut front = Vec::new();
    let mut body = Vec::new();
    let mut closed = false;
    for line in lines {
        if !closed && line.trim_end() == "---" {
            closed = true;
            continue;
        }
        if closed {
            body.push(line);
        } else {
            front.push(line);
        }
    }
    if !closed {
        return (None, text.to_owned());
    }
    (Some(front.join("\n")), body.join("\n"))
}

fn parse_frontmatter(front: &str) -> Fields {
    let mut description = String::new();
    let mut tools = Vec::new();
    let mut model = String::new();
    for line in front.lines() {
        let Some((key, value)) = line.trim().split_once(':') else { continue };
        let value = unquote_yaml(value.trim());
        match key.trim() {
            "description" => description = value,
            "model" => model = value,
            "tools" => {
                tools = value
                    .split(',')
                    .map(|t| t.trim().to_owned())
                    .filter(|t| !t.is_empty())
                    .collect()
            }
            _ => {}
        }
    }
    Fields { description, tools, model }
}

fn render(def: &AgentDef) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&format!("name: {}\n", def.slug));
    out.push_str(&format!("description: {}\n", quote_yaml(&def.description)));
    if !def.tools.is_empty() {
        out.push_str(&format!("tools: {}\n", def.tools.join(", ")));
    }
    if !def.model.is_empty() {
        out.push_str(&format!("model: {}\n", quote_yaml(&def.model)));
    }
    out.push_str("---\n\n");
    out.push_str(&def.prompt);
    out.push('\n');
    out
}

/// Double-quoted YAML scalar with minimal, correct escaping. Sound for the
/// single-line, control-character-free strings `sanitize` guarantees (no
/// newlines reach here) — a real YAML parser reads this back identically to
/// how `unquote_yaml` does.
fn quote_yaml(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

fn unquote_yaml(s: &str) -> String {
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        let inner = &s[1..s.len() - 1];
        let mut out = String::with_capacity(inner.len());
        let mut chars = inner.chars();
        while let Some(c) = chars.next() {
            if c == '\\' {
                match chars.next() {
                    Some('"') => out.push('"'),
                    Some('\\') => out.push('\\'),
                    Some(other) => {
                        out.push('\\');
                        out.push(other);
                    }
                    None => out.push('\\'),
                }
            } else {
                out.push(c);
            }
        }
        out
    } else if s.len() >= 2 && s.starts_with('\'') && s.ends_with('\'') {
        s[1..s.len() - 1].replace("''", "'")
    } else {
        s.to_owned()
    }
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
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_ws() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let mut p = std::env::temp_dir();
        p.push(format!(
            "claude-ide-agentdef-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn opt(p: &std::path::Path) -> Option<String> {
        Some(p.to_string_lossy().into_owned())
    }

    fn sample(slug: &str) -> AgentDef {
        AgentDef {
            slug: slug.to_owned(),
            description: "Reviews things: carefully.".to_owned(),
            tools: vec!["Read".into(), "Grep".into()],
            model: "sonnet".into(),
            prompt: "You are a reviewer.".to_owned(),
        }
    }

    #[test]
    fn list_reports_empty_for_missing_dir() {
        let ws = temp_ws();
        assert!(list(opt(&ws)).unwrap().is_empty());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn create_read_list_round_trip() {
        let ws = temp_ws();
        let created = create(opt(&ws), sample("code-reviewer")).unwrap();
        assert_eq!(created.slug, "code-reviewer");
        assert_eq!(created.tools, vec!["Read".to_string(), "Grep".to_string()]);

        let got = read(opt(&ws), "code-reviewer".into()).unwrap();
        assert_eq!(got.description, "Reviews things: carefully.");
        assert_eq!(got.model, "sonnet");
        assert_eq!(got.prompt, "You are a reviewer.");

        let listed = list(opt(&ws)).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].slug, "code-reviewer");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn create_rejects_duplicate() {
        let ws = temp_ws();
        create(opt(&ws), sample("dup")).unwrap();
        let err = create(opt(&ws), sample("dup")).unwrap_err();
        assert!(matches!(err.kind, IpcErrorKind::InvalidInput));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn create_rejects_bad_slug() {
        let ws = temp_ws();
        for bad in ["", "Has Spaces", "Upper", "trailing-", "-leading", "double--hyphen", "../escape"] {
            let mut d = sample("placeholder");
            d.slug = bad.to_string();
            assert!(create(opt(&ws), d).is_err(), "expected rejection for {bad:?}");
        }
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn update_overwrites_in_place() {
        let ws = temp_ws();
        create(opt(&ws), sample("agent-a")).unwrap();
        let mut edited = sample("agent-a");
        edited.description = "Updated description".into();
        update(opt(&ws), "agent-a".into(), edited).unwrap();

        let got = read(opt(&ws), "agent-a".into()).unwrap();
        assert_eq!(got.description, "Updated description");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn update_renames_and_removes_old_file() {
        let ws = temp_ws();
        create(opt(&ws), sample("old-name")).unwrap();
        let renamed = sample("new-name");
        update(opt(&ws), "old-name".into(), renamed).unwrap();

        assert!(read(opt(&ws), "new-name".into()).is_ok());
        assert!(read(opt(&ws), "old-name".into()).is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn delete_removes_the_file() {
        let ws = temp_ws();
        create(opt(&ws), sample("to-delete")).unwrap();
        delete(opt(&ws), "to-delete".into()).unwrap();
        assert!(read(opt(&ws), "to-delete".into()).is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn delete_missing_agent_errors() {
        let ws = temp_ws();
        let err = delete(opt(&ws), "nope".into()).unwrap_err();
        assert!(matches!(err.kind, IpcErrorKind::InvalidInput));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn tolerates_hand_written_unquoted_frontmatter() {
        let ws = temp_ws();
        let dir = ws.join(".claude").join("agents");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("security-auditor.md"),
            "---\nname: security-auditor\ndescription: Adversarial security reviewer.\ntools: Read, Glob, Grep, Bash\n---\n\nYou are a security engineer.\n",
        )
        .unwrap();

        let got = read(opt(&ws), "security-auditor".into()).unwrap();
        assert_eq!(got.description, "Adversarial security reviewer.");
        assert_eq!(got.tools, vec!["Read", "Glob", "Grep", "Bash"]);
        assert_eq!(got.model, "");
        assert_eq!(got.prompt, "You are a security engineer.");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn lists_a_file_with_no_frontmatter_instead_of_hiding_it() {
        let ws = temp_ws();
        let dir = ws.join(".claude").join("agents");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("freeform.md"), "Just a plain markdown file, no frontmatter.\n").unwrap();

        let listed = list(opt(&ws)).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].slug, "freeform");
        assert_eq!(listed[0].description, "");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn quote_unquote_round_trips_special_characters() {
        let s = "Has \"quotes\", a colon: and a\\backslash";
        assert_eq!(unquote_yaml(&quote_yaml(s)), s);
    }

    #[test]
    fn sanitize_rejects_multiline_description() {
        let mut d = sample("x");
        d.description = "line one\nline two".into();
        assert!(sanitize(d).is_err());
    }
}
