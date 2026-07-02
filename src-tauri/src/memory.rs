//! Memory health dashboard (Addendum III §S13). Read-only.
//!
//! Reports on Claude's own auto-memory system for this workspace —
//! `~/.claude/projects/<project>/memory/MEMORY.md` plus its topic files — the
//! same directory this IDE's own conversations write to. Mirrors the shape of
//! the `/si:status` skill (line counts vs. the 200-line cap, topic files,
//! staleness, duplicates, capacity banding) so the numbers here mean the same
//! thing they do on the command line. Never writes anything — promotion/
//! cleanup stays a manual `/si:review` in a real session, same as everywhere
//! else in this app (wrapper principle).

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::error::IpcResult;

const MEMORY_MD_CAP: usize = 200;
const MEMORY_MD_WARN: usize = 120;
const MEMORY_MD_CRIT: usize = 180;
const CLAUDE_MD_WARN: usize = 150;
const CLAUDE_MD_CRIT: usize = 200;
const TOPIC_FILES_WARN: usize = 4;
const TOPIC_FILES_CRIT: usize = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HealthBand {
    Healthy,
    Warning,
    Critical,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFile {
    pub name: String,
    pub lines: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryHealth {
    /// False when no `~/.claude/projects/<project>` dir was found for this
    /// workspace yet (e.g. brand-new project, never had a session) — every
    /// other field is just the empty state in that case, not an error.
    pub project_found: bool,
    pub memory_dir_exists: bool,
    pub memory_md_lines: usize,
    pub memory_md_cap: usize,
    pub memory_md_updated_ms: Option<u64>,
    pub topic_files: Vec<MemoryFile>,
    pub project_claude_md_lines: Option<usize>,
    pub user_claude_md_lines: Option<usize>,
    pub rules_file_count: usize,
    pub stale_refs: Vec<String>,
    pub duplicate_refs: Vec<String>,
    pub capacity: HealthBand,
    pub recommendations: Vec<String>,
}

pub fn memory_health(cwd: Option<String>) -> IpcResult<MemoryHealth> {
    let target = crate::workspace::resolve_cwd(cwd)?;
    let home = crate::sessions::home_dir();

    let project_dir = home
        .as_deref()
        .and_then(|_| crate::sessions::claude_projects_dir())
        .and_then(|projects| crate::sessions::resolve_project_dir(&projects, &target));

    let project_claude_md_lines = count_lines(&target.join("CLAUDE.md"));
    let user_claude_md_lines = home.as_deref().and_then(|h| count_lines(&h.join(".claude").join("CLAUDE.md")));
    let rules_file_count = fs::read_dir(target.join(".claude").join("rules"))
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().extension().is_some_and(|ext| ext == "md"))
                .count()
        })
        .unwrap_or(0);

    let Some(project_dir) = project_dir else {
        return Ok(MemoryHealth {
            project_found: false,
            memory_dir_exists: false,
            memory_md_lines: 0,
            memory_md_cap: MEMORY_MD_CAP,
            memory_md_updated_ms: None,
            topic_files: Vec::new(),
            project_claude_md_lines,
            user_claude_md_lines,
            rules_file_count,
            stale_refs: Vec::new(),
            duplicate_refs: Vec::new(),
            capacity: HealthBand::Healthy,
            recommendations: Vec::new(),
        });
    };

    let memory_dir = project_dir.join("memory");
    if !memory_dir.is_dir() {
        return Ok(MemoryHealth {
            project_found: true,
            memory_dir_exists: false,
            memory_md_lines: 0,
            memory_md_cap: MEMORY_MD_CAP,
            memory_md_updated_ms: None,
            topic_files: Vec::new(),
            project_claude_md_lines,
            user_claude_md_lines,
            rules_file_count,
            stale_refs: Vec::new(),
            duplicate_refs: Vec::new(),
            capacity: HealthBand::Healthy,
            recommendations: Vec::new(),
        });
    }

    let memory_md_path = memory_dir.join("MEMORY.md");
    let memory_md_content = fs::read_to_string(&memory_md_path).unwrap_or_default();
    let memory_md_lines = memory_md_content.lines().count();
    let memory_md_updated_ms = fs::metadata(&memory_md_path).ok().map(|m| mtime_ms(&m));

    let mut topic_files: Vec<MemoryFile> = fs::read_dir(&memory_dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|ext| ext == "md") && p.file_name().and_then(|n| n.to_str()) != Some("MEMORY.md"))
                .map(|p| MemoryFile {
                    name: p.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                    lines: fs::read_to_string(&p).map(|s| s.lines().count()).unwrap_or(0),
                })
                .collect()
        })
        .unwrap_or_default();
    topic_files.sort_by(|a, b| a.name.cmp(&b.name));

    let (stale_refs, duplicate_refs) = check_links(&memory_md_content, &memory_dir);

    let memory_band = band(memory_md_lines, MEMORY_MD_WARN, MEMORY_MD_CRIT);
    let topic_band = band(topic_files.len(), TOPIC_FILES_WARN, TOPIC_FILES_CRIT);
    let capacity = worst(memory_band, topic_band);

    let mut recommendations = Vec::new();
    if memory_band != HealthBand::Healthy {
        recommendations.push(format!(
            "MEMORY.md is at {memory_md_lines}/{MEMORY_MD_CAP} lines — run /si:review to promote or clean up before it starts dropping older entries."
        ));
    }
    if topic_band != HealthBand::Healthy {
        recommendations.push(format!("{} topic files — worth checking they're still organized well.", topic_files.len()));
    }
    if !stale_refs.is_empty() {
        recommendations.push(format!(
            "{} stale reference(s) in MEMORY.md point at files that no longer exist — delete them to free capacity.",
            stale_refs.len()
        ));
    }
    if !duplicate_refs.is_empty() {
        recommendations.push(format!("{} duplicate reference(s) in MEMORY.md — consolidate them.", duplicate_refs.len()));
    }
    if let Some(n) = project_claude_md_lines {
        if band(n, CLAUDE_MD_WARN, CLAUDE_MD_CRIT) != HealthBand::Healthy {
            recommendations.push(format!("Project CLAUDE.md is {n} lines — consider trimming to keep it scannable."));
        }
    }

    Ok(MemoryHealth {
        project_found: true,
        memory_dir_exists: true,
        memory_md_lines,
        memory_md_cap: MEMORY_MD_CAP,
        memory_md_updated_ms,
        topic_files,
        project_claude_md_lines,
        user_claude_md_lines,
        rules_file_count,
        stale_refs,
        duplicate_refs,
        capacity,
        recommendations,
    })
}

fn band(n: usize, warn: usize, crit: usize) -> HealthBand {
    if n > crit {
        HealthBand::Critical
    } else if n >= warn {
        HealthBand::Warning
    } else {
        HealthBand::Healthy
    }
}

fn worst(a: HealthBand, b: HealthBand) -> HealthBand {
    use HealthBand::*;
    match (a, b) {
        (Critical, _) | (_, Critical) => Critical,
        (Warning, _) | (_, Warning) => Warning,
        _ => Healthy,
    }
}

/// Markdown link targets (`[text](target)`) referenced from `MEMORY.md`, each
/// checked for existence relative to the memory dir itself — that's how this
/// app's own auto-memory index links to its topic files (see `MEMORY.md`'s own
/// format: `- [Title](file.md) — hook`). Also flags any target linked more
/// than once. Silently skips http(s) links — those aren't file references.
fn check_links(memory_md: &str, memory_dir: &Path) -> (Vec<String>, Vec<String>) {
    let mut seen = HashSet::new();
    let mut duplicates = HashSet::new();
    for line in memory_md.lines() {
        let mut rest = line;
        while let Some(open) = rest.find("](") {
            let after = &rest[open + 2..];
            let Some(close) = after.find(')') else { break };
            let target = &after[..close];
            rest = &after[close + 1..];
            if target.is_empty() || target.starts_with("http://") || target.starts_with("https://") {
                continue;
            }
            if !seen.insert(target.to_string()) {
                duplicates.insert(target.to_string());
            }
        }
    }

    let mut stale: Vec<String> = seen.into_iter().filter(|link| !memory_dir.join(link).is_file()).collect();
    stale.sort();
    let mut duplicates: Vec<String> = duplicates.into_iter().collect();
    duplicates.sort();
    (stale, duplicates)
}

fn count_lines(path: &PathBuf) -> Option<usize> {
    fs::read_to_string(path).ok().map(|s| s.lines().count())
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn band_thresholds() {
        assert_eq!(band(0, 120, 180), HealthBand::Healthy);
        assert_eq!(band(119, 120, 180), HealthBand::Healthy);
        assert_eq!(band(120, 120, 180), HealthBand::Warning);
        assert_eq!(band(180, 120, 180), HealthBand::Warning);
        assert_eq!(band(181, 120, 180), HealthBand::Critical);
    }

    #[test]
    fn worst_band_wins() {
        assert_eq!(worst(HealthBand::Healthy, HealthBand::Warning), HealthBand::Warning);
        assert_eq!(worst(HealthBand::Warning, HealthBand::Critical), HealthBand::Critical);
        assert_eq!(worst(HealthBand::Healthy, HealthBand::Healthy), HealthBand::Healthy);
    }

    #[test]
    fn check_links_finds_stale_and_duplicate() {
        let dir = std::env::temp_dir().join(format!("memory-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("real.md"), "content").unwrap();

        let md = "- [A](real.md) — exists\n- [B](missing.md) — gone\n- [C](real.md) — same target again\n- [D](https://example.com) — not a file\n";
        let (stale, duplicates) = check_links(md, &dir);

        assert_eq!(stale, vec!["missing.md".to_string()]);
        assert_eq!(duplicates, vec!["real.md".to_string()]);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn check_links_empty_when_no_links() {
        let dir = std::env::temp_dir().join(format!("memory-test-empty-{}", std::process::id()));
        let (stale, duplicates) = check_links("# Memory index\n\nnothing here yet\n", &dir);
        assert!(stale.is_empty());
        assert!(duplicates.is_empty());
    }
}
