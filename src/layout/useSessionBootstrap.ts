/*
 * Session bootstrap (Addendum II layout pass). The Sessions rail used to be an
 * always-mounted column whose effects loaded the workspace's sessions and
 * continued the most recent one on open (`claude -c` behaviour). Now that
 * Sessions is a collapsible side-panel *view*, those effects can't live there —
 * they'd only run when the user opened the Sessions view. This hook hoists them
 * into the always-mounted shell so the behaviour is unchanged regardless of which
 * side-panel view is showing.
 */

import { useEffect } from "react";
import { useSessions } from "@/store/sessions";
import { useActiveConversation } from "@/store/conversation";
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
}
