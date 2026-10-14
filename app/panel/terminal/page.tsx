"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { TerminalPanel } from "@/components/TerminalPanel";
import { newTerminalTab, type TerminalTab } from "@/components/terminal-tab-state";
import { I18nProvider } from "@/hooks/useI18n";
import { useValidatedWorkspace } from "@/hooks/useValidatedWorkspace";

function setUrlTerminalId(id: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("id", id);
  window.history.replaceState(null, "", url);
}

function TerminalPanelPage() {
  const searchParams = useSearchParams();
  const cwdParam = searchParams.get("cwd") ?? "";
  const idParam = searchParams.get("id");
  // A panel opened without a directory (a hand-typed URL, a stale link) falls
  // back to the home directory instead of a dead page.
  const [homeCwd, setHomeCwd] = useState("");
  useEffect(() => {
    if (cwdParam) return;
    let disposed = false;
    fetch("/api/home", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { home?: string } | null) => {
        if (!disposed && data?.home) setHomeCwd(data.home);
      })
      .catch(() => {});
    return () => { disposed = true; };
  }, [cwdParam]);
  const cwd = cwdParam || homeCwd;
  // The terminal id lives in the URL so a reload (or an Obsidian tab reopen)
  // reattaches to the same shell; without one a fresh terminal is created.
  const [tab, setTab] = useState<TerminalTab | null>(null);
  const bootstrappedRef = useRef(false);
  const workspaceReady = useValidatedWorkspace(cwd);

  useEffect(() => {
    if (bootstrappedRef.current || !cwd || !workspaceReady) return;
    bootstrappedRef.current = true;
    if (idParam && /^[a-f0-9]{32}$/.test(idParam)) {
      setTab({ id: idParam, cwd, restored: true });
      return;
    }
    const fresh = newTerminalTab(cwd);
    setTab(fresh);
    setUrlTerminalId(fresh.id);
  }, [cwd, idParam, workspaceReady]);

  useEffect(() => {
    if (cwd) document.title = `Terminal — ${cwd.split(/[\\/]/).pop() || cwd}`;
  }, [cwd]);

  // Reuse the panel's own close flow: it deletes the terminal, then calls onClosed.
  const handleRestart = useCallback(() => {
    setTab((current) => current ? { ...current, closing: "restart" } : current);
  }, []);
  const handleClosed = useCallback(() => {
    if (!cwd) return;
    const fresh = newTerminalTab(cwd);
    setTab(fresh);
    setUrlTerminalId(fresh.id);
  }, [cwd]);
  const handleCloseError = useCallback(() => {
    setTab((current) => current ? { ...current, closing: undefined } : current);
  }, []);

  if (!cwd) {
    return (
      <div role="alert" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
        Missing working directory: /panel/terminal?cwd=…
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      {tab && (
        <TerminalPanel
          tab={tab}
          active
          onRestart={handleRestart}
          onClosed={handleClosed}
          onCloseError={handleCloseError}
        />
      )}
    </div>
  );
}

export default function PanelTerminalPage() {
  return (
    <Suspense>
      <I18nProvider>
        <TerminalPanelPage />
      </I18nProvider>
    </Suspense>
  );
}
