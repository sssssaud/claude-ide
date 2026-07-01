/*
 * Account store (Addendum II §S2.5). Read-only status mirrored from
 * `claude auth status --json`, plus a non-interactive `logout`. Signing IN is
 * NOT modeled here — it's an interactive CLI-owned flow hosted in an
 * `InlineTerminal` by the caller (Settings' Account section, the Preflight
 * gate); once that terminal reports the process exited, the caller calls
 * `refresh()` to pick up the new status.
 */

import { create } from "zustand";
import { authLogout, authStatus } from "@/ipc/commands";
import { isIpcError, type AuthStatus } from "@/ipc/types";

interface AuthState {
  status: AuthStatus | null;
  loaded: boolean;
  loadError: string | null;
  loggingOut: boolean;
  logoutError: string | null;

  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuth = create<AuthState>((set, get) => ({
  status: null,
  loaded: false,
  loadError: null,
  loggingOut: false,
  logoutError: null,

  refresh: async () => {
    try {
      const status = await authStatus();
      set({ status, loaded: true, loadError: null });
    } catch (e) {
      set({ loaded: true, loadError: isIpcError(e) ? e.message : "Could not check sign-in status" });
    }
  },

  logout: async () => {
    set({ loggingOut: true, logoutError: null });
    try {
      await authLogout();
    } catch (e) {
      set({ loggingOut: false, logoutError: isIpcError(e) ? e.message : "Could not sign out" });
      return;
    }
    // The logout itself succeeded — refresh status as a separate concern, so a
    // hiccup probing status right after can't be mistaken for the sign-out
    // having failed (it didn't; `status` just hasn't been re-checked yet).
    set({ loggingOut: false });
    await get().refresh();
  },
}));
