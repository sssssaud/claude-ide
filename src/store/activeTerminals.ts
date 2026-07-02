/*
 * A non-reactive registry of each workspace's live PTY id (Addendum II §S7 —
 * "Open Terminal Here" needs to write a `cd` into that workspace's
 * already-open shell without plumbing xterm/PTY state through React context,
 * mirroring `store/activeEditorHandle.ts`'s pattern). Set by each
 * `WorkspaceTerminal` (`BottomPanel.tsx`) whenever its shell opens/exits;
 * read imperatively at the moment an action runs, never subscribed to.
 */

const ptyIds = new Map<string, string>();

export function setActivePtyId(cwd: string, ptyId: string | null): void {
  if (ptyId) ptyIds.set(cwd, ptyId);
  else ptyIds.delete(cwd);
}

export function getActivePtyId(cwd: string): string | null {
  return ptyIds.get(cwd) ?? null;
}
