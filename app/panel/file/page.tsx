"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { FileViewer } from "@/components/FileViewer";
import { I18nProvider } from "@/hooks/useI18n";
import { useValidatedWorkspace } from "@/hooks/useValidatedWorkspace";
import { openPanel, postToHost, type PanelParams } from "@/lib/embed-mode";
import type { FileViewerDisplayMode } from "@/lib/file-viewer-state";

function FilePanel() {
  const searchParams = useSearchParams();
  const filePath = searchParams.get("path");

  // A plain function: React Compiler memoizes it against searchParams itself.
  const openAnotherFile = (nextPath: string, page?: number) => {
    const params: PanelParams = {
      path: nextPath,
      cwd: searchParams.get("cwd"),
      sourceSessionId: searchParams.get("sourceSessionId"),
      page,
      mode: searchParams.get("mode"),
    };
    openPanel("file", params);
  };

  const cwd = searchParams.get("cwd") ?? undefined;
  const sourceSessionId = searchParams.get("sourceSessionId");
  const page = searchParams.get("page");
  const mode = searchParams.get("mode");

  const workspaceReady = useValidatedWorkspace(cwd ?? (filePath ? filePath.replace(/[\\/][^\\/]*$/, "") : ""));

  if (!filePath) {
    return (
      <div role="alert" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
        Missing file path: /panel/file?path=…
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      {workspaceReady ? (
        <FileViewer
          filePath={filePath}
          cwd={cwd}
          sourceSessionId={sourceSessionId}
          watchEnabled
          initialDisplayMode={(mode === "source" || mode === "preview" || mode === "diff") ? mode as FileViewerDisplayMode : undefined}
          initialPage={page ? Number(page) || undefined : undefined}
          onMentionLines={(relativePath, startLine, endLine) => postToHost({ type: "mention-lines", path: relativePath, startLine, endLine })}
          onAtMention={(relativePath, isDir) => postToHost({ type: "mention", path: relativePath, isDir })}
          onOpenFile={openAnotherFile}
        />
      ) : (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }} />
      )}
    </div>
  );
}

export default function PanelFilePage() {
  return (
    <Suspense>
      <I18nProvider>
        <FilePanel />
      </I18nProvider>
    </Suspense>
  );
}
