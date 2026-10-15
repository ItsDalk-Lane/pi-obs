"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { SubagentViewer } from "@/components/SubagentViewer";
import { I18nProvider } from "@/hooks/useI18n";
import { openPanel, type PanelParams } from "@/lib/embed-mode";

function AgentPanel() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session");
  const label = searchParams.get("label") ?? "Subagent";
  // Picked from the running list (or the URL); the URL follows so a reload
  // reopens the same viewer.
  const [selectedSession, setSelectedSession] = useState<string | null>(sessionId);
  const [runningIds, setRunningIds] = useState<string[]>([]);

  useEffect(() => {
    setSelectedSession(sessionId);
  }, [sessionId]);

  // A standalone page polls the same snapshot endpoint the sidebar does: the
  // viewer's run badge, and the fallback list when no session was given.
  useEffect(() => {
    let disposed = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/agent/running", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json() as { runningSessionIds?: string[] };
        if (!disposed) setRunningIds(data.runningSessionIds ?? []);
      } catch {
        /* transient; the next tick retries */
      }
    };
    void poll();
    const timer = setInterval(poll, 5000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);

  useEffect(() => {
    document.title = `${label} — Pi Obs`;
  }, [label]);

  const handleSelectRunning = useCallback((id: string) => {
    setSelectedSession(id);
    const url = new URL(window.location.href);
    url.searchParams.set("session", id);
    window.history.replaceState(null, "", url);
  }, []);

  const handleOpenFile = useCallback((filePath: string, page?: number) => {
    const params: PanelParams = {
      path: filePath,
      cwd: searchParams.get("cwd"),
      sourceSessionId: selectedSession ?? undefined,
      page,
    };
    openPanel("file", params);
  }, [searchParams, selectedSession]);

  if (!selectedSession) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, color: "var(--text-muted)", fontSize: 13 }}>
        <div style={{ color: "var(--text)", fontWeight: 600 }}>Running subagents</div>
        {runningIds.length === 0 ? (
          <div>No running subagents. Open one from a subagent run in a chat.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "min(100%, 420px)" }}>
            {runningIds.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => handleSelectRunning(id)}
                style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", font: "inherit", fontSize: 12, textAlign: "left" }}
              >
                <span style={{ width: 7, height: 7, borderRadius: 99, background: "#4ade80", flexShrink: 0 }} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{id}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  const running = runningIds.includes(selectedSession);

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      <SubagentViewer
        key={selectedSession}
        sessionId={selectedSession}
        fallbackLabel={label}
        running={running}
        onOpenFile={handleOpenFile}
      />
    </div>
  );
}

export default function PanelAgentPage() {
  return (
    <Suspense>
      <I18nProvider>
        <AgentPanel />
      </I18nProvider>
    </Suspense>
  );
}
