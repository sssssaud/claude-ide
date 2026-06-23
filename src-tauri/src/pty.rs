//! Plain-shell PTY for the terminal drawer (spec 2.3, 5.A.6).
//!
//! Each open terminal is a real pseudo-terminal running the user's `$SHELL`,
//! cwd-locked. A dedicated reader thread pumps the PTY's raw bytes over a
//! `Channel<Vec<u8>>` to xterm.js (which owns ANSI / color / cursor rendering);
//! keystrokes flow back via `write`, and the drawer's size flows via `resize`.
//! The PTY master, its writer, and the child handle live ONLY here (spec 2.5
//! handle-ownership): the frontend holds an opaque id. Closing kills the child
//! and reaps it — no zombies (spec 5.A.6 acceptance).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;

use crate::error::{IpcError, IpcErrorKind, IpcResult};

/// One live terminal: the master (for resize), its writer (for keystrokes), and
/// the child (for a clean kill). The reader side runs on its own thread.
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

/// Owns every open terminal's PTY (spec 2.5). Managed by Tauri as
/// `Arc<PtyRegistry>`; teardown reaps all children on app exit.
#[derive(Default)]
pub struct PtyRegistry {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<String, PtySession>>,
}

impl PtyRegistry {
    /// Spawn `$SHELL` in a fresh PTY sized `rows`x`cols`, cwd-locked to the
    /// launch directory (per-workspace cwd routing is Phase 5). Raw output is
    /// streamed over `channel`; an empty `Vec` is sent as the EOF sentinel when
    /// the shell exits, so the UI can offer a restart.
    pub fn open(&self, rows: u16, cols: u16, channel: Channel<Vec<u8>>) -> IpcResult<String> {
        let cwd = std::env::current_dir()
            .map_err(|e| internal(format!("Cannot resolve a working directory: {e}")))?;
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());

        let pair = native_pty_system()
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| internal(format!("Failed to open a pseudo-terminal: {e}")))?;

        let mut cmd = CommandBuilder::new(&shell);
        cmd.cwd(&cwd);
        cmd.env("TERM", "xterm-256color");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| internal(format!("Failed to start the shell: {e}")))?;
        // Drop the slave so the master sees EOF once the child exits.
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| internal(format!("Failed to read from the terminal: {e}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| internal(format!("Failed to write to the terminal: {e}")))?;

        let id = format!("pty-{}", self.next_id.fetch_add(1, Ordering::SeqCst));

        // Reader thread: blocking PTY reads off the async runtime (spec 2.5).
        let reader_id = id.clone();
        std::thread::Builder::new()
            .name(format!("pty-reader-{id}"))
            .spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            if channel.send(buf[..n].to_vec()).is_err() {
                                break; // frontend went away
                            }
                        }
                        Err(_) => break,
                    }
                }
                let _ = channel.send(Vec::new()); // EOF sentinel -> UI shows "exited"
                tracing::info!(pty = %reader_id, "pty reader exited");
            })
            .map_err(|e| internal(format!("Failed to start the terminal reader: {e}")))?;

        self.sessions
            .lock()
            .expect("pty registry mutex poisoned")
            .insert(id.clone(), PtySession { master: pair.master, writer, child });
        tracing::info!(pty = %id, shell = %shell, cwd = %cwd.display(), "pty opened");
        Ok(id)
    }

    /// Write keystrokes (UTF-8 bytes) into the terminal.
    pub fn write(&self, id: &str, data: &[u8]) -> IpcResult<()> {
        let mut guard = self.sessions.lock().expect("pty registry mutex poisoned");
        let session = guard.get_mut(id).ok_or_else(not_open)?;
        session
            .writer
            .write_all(data)
            .map_err(|e| internal(format!("Terminal write failed: {e}")))?;
        session
            .writer
            .flush()
            .map_err(|e| internal(format!("Terminal flush failed: {e}")))?;
        Ok(())
    }

    /// Resize the PTY when the drawer resizes (spec 5.A.6).
    pub fn resize(&self, id: &str, rows: u16, cols: u16) -> IpcResult<()> {
        let guard = self.sessions.lock().expect("pty registry mutex poisoned");
        let session = guard.get(id).ok_or_else(not_open)?;
        session
            .master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| internal(format!("Terminal resize failed: {e}")))?;
        Ok(())
    }

    /// Close a terminal: kill + reap the child (no zombie). Dropping the master
    /// and writer closes the PTY, so the reader thread sees EOF and exits.
    pub fn close(&self, id: &str) -> IpcResult<()> {
        let session = self.sessions.lock().expect("pty registry mutex poisoned").remove(id);
        if let Some(mut session) = session {
            let _ = session.child.kill();
            let _ = session.child.wait();
        }
        Ok(())
    }

    /// Tear down every terminal on app exit (spec 5.A.6 "no zombie").
    pub fn shutdown_all(&self) {
        let sessions: Vec<PtySession> = {
            let mut guard = self.sessions.lock().expect("pty registry mutex poisoned");
            guard.drain().map(|(_, s)| s).collect()
        };
        for mut session in sessions {
            let _ = session.child.kill();
            let _ = session.child.wait();
        }
    }
}

fn internal(message: String) -> IpcError {
    IpcError::new(IpcErrorKind::Internal, message)
}

fn not_open() -> IpcError {
    IpcError::new(IpcErrorKind::InvalidInput, "That terminal is not open")
}
