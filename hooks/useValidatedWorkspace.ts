"use client";

import { useEffect, useState } from "react";

/**
 * Register the workspace with /api/cwd/validate so /api/files and
 * /api/terminal accept the paths of a standalone /panel page: allowed roots
 * are validated workspaces (plus session cwds), and such a page never went
 * through the main UI's workspace selection.
 */
export function useValidatedWorkspace(cwd: string): boolean {
  const [ready, setReady] = useState(!cwd);
  useEffect(() => {
    if (!cwd) return;
    let disposed = false;
    setReady(false);
    void fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    })
      .catch(() => null)
      .finally(() => { if (!disposed) setReady(true); });
    return () => { disposed = true; };
  }, [cwd]);
  return ready;
}
