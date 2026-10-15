"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { I18nProvider } from "@/hooks/useI18n";

/**
 * A session's exported history as a standalone panel page.
 *
 * The export is a whole self-contained HTML document whose response forbids
 * being framed (`frame-ancestors 'none'`, `X-Frame-Options: DENY`), so it is
 * fetched as text and handed to a `srcdoc` frame instead: that frame has no
 * response to check those headers against, and the export keeps its
 * protection where it is served.
 */
function HistoryPanel() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session");
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    setHtml(null);
    setError(null);
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/export?inline=1`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Export failed (${res.status})`);
        const text = await res.text();
        if (!disposed) setHtml(text);
      })
      .catch((err: unknown) => {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      });
    return () => { disposed = true; };
  }, [sessionId]);

  useEffect(() => {
    document.title = sessionId ? "Full history — Pi Obs" : "Pi Obs";
  }, [sessionId]);

  if (!sessionId) {
    return (
      <div role="alert" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
        Missing session: /panel/history?session=…
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      {error ? (
        <div role="alert" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, color: "var(--text-muted)", fontSize: 13, textAlign: "center" }}>
          {error}
        </div>
      ) : html === null ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
          正在生成导出… Generating export…
        </div>
      ) : (
        <iframe
          title="Session history"
          srcDoc={html}
          style={{ flex: 1, width: "100%", minHeight: 0, border: "none", background: "var(--bg)" }}
        />
      )}
    </div>
  );
}

export default function PanelHistoryPage() {
  return (
    <Suspense>
      <I18nProvider>
        <HistoryPanel />
      </I18nProvider>
    </Suspense>
  );
}
