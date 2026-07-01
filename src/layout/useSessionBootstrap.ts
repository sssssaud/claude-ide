/*
 * Workspace bootstrap (Addendum II layout pass). The Sessions rail (and the
 * Source-Control badge/status) used to live in always-mounted columns whose
 * effects loaded the workspace's sessions / git status on open. Now that both
 * are collapsible side-panel *views* (and the activity bar itself hides in
 * zen mode), those effects can't live there — they'd only run when the
 * relevant view/bar happened to be visible. This hook hoists them into the
 * always-mounted shell so the behaviour is unchanged regardless of which
 * side-panel view is showing or whether zen mode is on.
 */

import { useEffect } from "react";
import { useSessions } from "@/store/sessions";
import { useActiveConversation } from "@/store/conversation";
import { useGit } from "@/store/git";
import { useActiveCwd } from "@/store/workspaces";

export function useSessionBootstrap() {
  const cwd = useActiveCwd();
  const slice = useSessions((s) => (cwd ? s.byCwd[cwd] : undefined));
  const loaded = slice?.loaded ?? false;
  const sessions = slice?.sessions ?? [];
  const init = useSessions((s) => s.init);
  const maybeContinue = useActiveConversation((s) => s.maybeContinue);

  // Resolve the workspace's sessions on open / workspace switch.
  useEffect(() => {
    if (cwd) void init(cwd);
  }, [cwd, init]);

  // Once known, continue the most recent session (newest-first). One-shot in the
  // store, so this re-fires harmlessly on watcher updates and tab switches.
  useEffect(() => {
    if (loaded && sessions.length > 0) maybeContinue(sessions[0].id);
  }, [loaded, sessions, maybeContinue]);

  // Keep git status live as the active workspace changes — the Status Bar's
  // branch/ahead-behind segment and the activity bar's Source-Control badge
  // both read from this, regardless of which is currently mounted/visible.
  useEffect(() => {
    void useGit.getState().refresh();
  }, [cwd]);
}
