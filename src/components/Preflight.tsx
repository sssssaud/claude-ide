/*
 * Preflight gate (spec 3.10, 4.6 onboarding). Runs the environment check and,
 * on failure, shows a guided fix — never a raw error, never a spawn attempt.
 * On success the parent renders the workspace shell.
 */

import { useState, type ReactNode } from "react";
import { useAppStore } from "@/store/app";
import { AppButton, ErrorState, LoadingState } from "@/components/states";
import { InlineTerminal } from "@/components/InlineTerminal";

export function PreflightGate() {
  const phase = useAppStore((s) => s.preflightPhase);
  const report = useAppStore((s) => s.report);
  const error = useAppStore((s) => s.error);
  const runPreflight = useAppStore((s) => s.runPreflight);
  const [signingIn, setSigningIn] = useState(false);

  if (phase === "checking") {
    return (
      <CenteredCard>
        <LoadingState label="Checking your Claude Code setup…" />
      </CenteredCard>
    );
  }

  if (phase === "error" && error) {
    return (
      <CenteredCard>
        <ErrorState
          title="Couldn't check your setup"
          error={error}
          onRetry={() => void runPreflight()}
        />
      </CenteredCard>
    );
  }

  // phase === "blocked": a guided fix tailored to which check failed.
  const missing = !report?.claudeFound;
  const title = missing ? "Claude Code isn't installed" : "You're not signed in";
  const body = missing
    ? "Claude IDE drives the Claude Code CLI, which isn't on your PATH yet. Install it, then retry."
    : "The Claude Code CLI is installed but not authenticated. Sign in, then retry.";
  const command = missing
    ? "npm install -g @anthropic-ai/claude-code"
    : "claude auth login";

  return (
    <CenteredCard>
      <div className="flex flex-col items-center gap-[var(--space-5)] text-center">
        <h1
          style={{
            fontSize: "var(--text-xl)",
            fontWeight: 600,
            color: "var(--color-fg-primary)",
          }}
        >
          {title}
        </h1>
        <p style={{ color: "var(--color-fg-secondary)", maxWidth: "46ch" }}>
          {body}
        </p>
        {!missing && signingIn ? (
          <div style={{ width: "min(480px, 90vw)" }}>
            <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)", marginBottom: "var(--space-2)" }}>
              Running <code>claude auth login</code> — follow the prompt below (it opens your browser).
            </p>
            <InlineTerminal
              key="preflight-login"
              command="claude auth login"
              onExit={() => {
                setSigningIn(false);
                void runPreflight();
              }}
            />
          </div>
        ) : (
          <code
            className="select-all"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-sm)",
              color: "var(--color-accent)",
              background: "var(--color-bg-recessed)",
              border: "1px solid var(--color-border-subtle)",
              borderRadius: "var(--radius-md)",
              padding: "var(--space-3) var(--space-5)",
            }}
          >
            {command}
          </code>
        )}
        {report?.version && (
          <p
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--color-fg-muted)",
            }}
          >
            detected: {report.version}
          </p>
        )}
        <div className="flex items-center gap-[var(--space-3)]">
          {!missing && !signingIn && <AppButton onClick={() => setSigningIn(true)}>Sign in</AppButton>}
          <AppButton onClick={() => void runPreflight()}>Retry check</AppButton>
        </div>
      </div>
    </CenteredCard>
  );
}

function CenteredCard({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex h-full w-full items-center justify-center"
      style={{ background: "var(--color-bg-base)" }}
    >
      <div
        className="flex items-center justify-center"
        style={{
          minWidth: "420px",
          minHeight: "260px",
          padding: "var(--space-7)",
          borderRadius: "var(--radius-lg)",
          background: "var(--color-bg-raised)",
          boxShadow: "var(--elev-2)",
        }}
      >
        {children}
      </div>
    </div>
  );
}
