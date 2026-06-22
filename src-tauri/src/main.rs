// Prevents an extra console window on Windows in release. DO NOT REMOVE.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::time::Instant;

fn main() {
    // Capture as the very first thing so the cold-start metric reflects real
    // process-init time (spec 2.7).
    let startup = Instant::now();
    claude_ide_lib::run(startup);
}
