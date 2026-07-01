/*
 * The developer command set (Addendum II §S3, §2.1/2.3): one flat registry of
 * every command the app exposes, driving both the Command Palette (fuzzy,
 * click-or-Enter) and the global keybinding dispatcher (`useLayoutShortcuts`).
 * Commands read from stores via `.getState()` at call time — never React
 * props/context — so this file has no component dependencies and the same
 * list works for both the palette and the raw keydown matcher.
 *
 * `combo` is the DEFAULT global keybinding (normalized "mod+…", "mod" = Ctrl on
 * Windows/Linux, Cmd on macOS). Not every command has one — Save and Go to
 * Line are deliberately left to Monaco's own per-instance keybindings instead
 * of being duplicated at the window level. A user-facing keybinding *editor*
 * (rebinding, conflict warnings) is later work (S6); today's bindings are fixed.
 */

import { AGENT_ACTION_LABELS, hasAgentActionTarget, sendAgentAction, type AgentActionKind } from "@/commands/agentActions";
import { getActiveEditorHandle } from "@/store/activeEditorHandle";
import { activeEditorStore } from "@/store/editor";
import { useLayout } from "@/store/layout";
import { useOverlays } from "@/store/overlays";
import { useZoom } from "@/store/zoom";

export interface Command {
  id: string;
  title: string;
  category: string;
  /** Human-readable, for the palette row (e.g. "Ctrl+B"). */
  keybinding?: string;
  /** Normalized combo the global dispatcher matches against (e.g. "mod+b"). */
  combo?: string;
  /** Defaults to always enabled. */
  enabled?: () => boolean;
  run: () => void | Promise<void>;
}

const hasActiveEditor = () => getActiveEditorHandle() !== null;

const openSettings = () => {
  useLayout.getState().setVisible("editor", true);
  activeEditorStore().getState().openSettings();
};

export const COMMANDS: Command[] = [
  // ---- View / layout ---------------------------------------------------
  {
    id: "view.toggleSidePanel",
    title: "View: Toggle Side Panel",
    category: "View",
    keybinding: "Ctrl+B",
    combo: "mod+b",
    run: () => useLayout.getState().toggle("sidebar"),
  },
  {
    id: "view.toggleTerminal",
    title: "View: Toggle Terminal",
    category: "View",
    keybinding: "Ctrl+J",
    combo: "mod+j",
    run: () => useLayout.getState().toggle("terminal"),
  },
  {
    id: "view.toggleEditorPanel",
    title: "View: Toggle Editor Panel",
    category: "View",
    run: () => useLayout.getState().toggle("editor"),
  },
  {
    id: "view.toggleZenMode",
    title: "View: Toggle Zen Mode",
    category: "View",
    run: () => useLayout.getState().toggleZen(),
  },
  {
    id: "preferences.openSettings",
    title: "Preferences: Open Settings",
    category: "Preferences",
    keybinding: "Ctrl+,",
    combo: "mod+,",
    run: openSettings,
  },
  {
    id: "workbench.quickOpen",
    title: "Go: Quick Open File…",
    category: "Go",
    keybinding: "Ctrl+P",
    combo: "mod+p",
    run: () => useOverlays.getState().openQuickOpen(),
  },
  {
    id: "workbench.commandPalette",
    title: "View: Command Palette",
    category: "View",
    keybinding: "Ctrl+Shift+P",
    combo: "mod+shift+p",
    run: () => useOverlays.getState().openPalette(),
  },

  // ---- Editor (need the active Monaco instance) ------------------------
  {
    id: "file.save",
    title: "File: Save",
    category: "File",
    keybinding: "Ctrl+S (in the editor)",
    enabled: hasActiveEditor,
    run: () => void getActiveEditorHandle()?.save(),
  },
  {
    id: "editor.gotoLine",
    title: "Go to Line/Column…",
    category: "Go",
    keybinding: "Ctrl+G (in the editor)",
    enabled: hasActiveEditor,
    run: () => getActiveEditorHandle()?.editor.getAction("editor.action.gotoLine")?.run(),
  },

  // ---- Zoom -------------------------------------------------------------
  {
    id: "view.zoomInUi",
    title: "View: Zoom In",
    category: "View",
    keybinding: "Ctrl+=",
    combo: "mod+=",
    run: () => useZoom.getState().zoomInUi(),
  },
  {
    id: "view.zoomOutUi",
    title: "View: Zoom Out",
    category: "View",
    keybinding: "Ctrl+-",
    combo: "mod+-",
    run: () => useZoom.getState().zoomOutUi(),
  },
  {
    id: "view.resetUiZoom",
    title: "View: Reset Zoom",
    category: "View",
    keybinding: "Ctrl+0",
    combo: "mod+0",
    run: () => useZoom.getState().resetUiZoom(),
  },
  {
    id: "editor.zoomIn",
    title: "Editor: Zoom In Font",
    category: "Editor",
    run: () => useZoom.getState().zoomInEditor(),
  },
  {
    id: "editor.zoomOut",
    title: "Editor: Zoom Out Font",
    category: "Editor",
    run: () => useZoom.getState().zoomOutEditor(),
  },
  {
    id: "editor.resetZoom",
    title: "Editor: Reset Font Zoom",
    category: "Editor",
    run: () => useZoom.getState().resetEditorZoom(),
  },

  // ---- Agent bridge (§S4) — select code, ask Claude -----------------------
  ...(["explain", "refactor", "fix", "tests", "docstring"] as AgentActionKind[]).map(
    (kind): Command => ({
      id: `claude.${kind}`,
      title: `Claude: ${AGENT_ACTION_LABELS[kind]}`,
      category: "Claude",
      enabled: hasAgentActionTarget,
      run: () => sendAgentAction(kind),
    }),
  ),
];

/** Commands actually runnable right now (palette hides disabled ones). */
export function availableCommands(): Command[] {
  return COMMANDS.filter((c) => c.enabled?.() ?? true);
}
