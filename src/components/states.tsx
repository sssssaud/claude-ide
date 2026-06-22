/*
 * The three-state primitives (spec 4.6): every view gets an intentional empty,
 * loading, and error state. No blank panes, no raw stack traces, no unbounded
 * spinners. These are the shared building blocks used across surfaces.
 */

import type { ReactNode } from "react";
import type { IpcError } from "@/ipc/types";

interface EmptyStateProps {
  title: string;
  hint?: string;
  action?: ReactNode;
}

/** An invitation to act, never a dead blank pane. */
export function EmptyState({ title, hint, action }: EmptyStateProps) {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-[var(--space-4)] p-[var(--space-6)] text-center"
      role="status"
    >
      <p
        className="font-medium"
        style={{ color: "var(--color-fg-primary)", fontSize: "var(--text-md)" }}
      >
        {title}
      </p>
      {hint && (
        <p style={{ color: "var(--color-fg-secondary)", maxWidth: "42ch" }}>
          {hint}
        </p>
      )}
      {action}
    </div>
  );
}

/** A bounded, labeled loading state (no infinite anonymous spinner). */
export function LoadingState({ label }: { label: string }) {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-[var(--space-3)]"
      role="status"
      aria-live="polite"
    >
      <span
        className="status-lamp-pulse"
        aria-hidden="true"
        style={{
          width: "10px",
          height: "10px",
          borderRadius: "var(--radius-sm)",
          background: "var(--color-status-running)",
        }}
      />
      <p style={{ color: "var(--color-fg-secondary)" }}>{label}</p>
    </div>
  );
}

interface ErrorStateProps {
  title: string;
  error: IpcError;
  onRetry?: () => void;
}

/** Direction + recovery, in the interface's voice. Detail is copyable, never raw on screen. */
export function ErrorState({ title, error, onRetry }: ErrorStateProps) {
  const copyDetails = () => {
    const text = `${error.kind}: ${error.message}${
      error.detail ? `\n${error.detail}` : ""
    }`;
    void navigator.clipboard?.writeText(text);
  };

  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-[var(--space-4)] p-[var(--space-6)] text-center"
      role="alert"
    >
      <p
        className="font-medium"
        style={{ color: "var(--color-status-danger)", fontSize: "var(--text-md)" }}
      >
        {title}
      </p>
      <p style={{ color: "var(--color-fg-secondary)", maxWidth: "48ch" }}>
        {error.message}
      </p>
      <div className="flex gap-[var(--space-3)]">
        {onRetry && <AppButton onClick={onRetry}>Retry</AppButton>}
        <AppButton variant="ghost" onClick={copyDetails}>
          Copy details
        </AppButton>
      </div>
    </div>
  );
}

interface AppButtonProps {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost";
  type?: "button" | "submit";
}

/** Shared button primitive — token-driven, accessible focus ring inherited. */
export function AppButton({
  children,
  onClick,
  variant = "primary",
  type = "button",
}: AppButtonProps) {
  const isPrimary = variant === "primary";
  return (
    <button
      type={type}
      onClick={onClick}
      className="cursor-pointer transition-colors"
      style={{
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-sm)",
        fontWeight: 500,
        padding: "var(--space-3) var(--space-5)",
        borderRadius: "var(--radius-md)",
        border: `1px solid ${
          isPrimary ? "var(--color-accent)" : "var(--color-border-strong)"
        }`,
        background: isPrimary ? "var(--color-accent)" : "transparent",
        color: isPrimary ? "var(--color-bg-base)" : "var(--color-fg-primary)",
        transitionDuration: "var(--motion-fast)",
      }}
    >
      {children}
    </button>
  );
}
