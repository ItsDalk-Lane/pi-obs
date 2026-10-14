// Embed mode: Pi Web running inside a host app (Obsidian) instead of a browser tab.
//
// The host loads the main UI in a frame with `?embed=1`; the flag is kept in
// sessionStorage so it survives client-side navigation. While embedded, every
// interface that would open in the main UI's right panel (files, workspace
// terminals, subagent viewers) — plus the exported session history, which a
// browser opens as its own tab — is instead handed to the host as a request to
// show a standalone `/panel/*` page in a tab of its own.

export type PanelKind = "file" | "terminal" | "agent" | "history";

export type PanelParams = Record<string, string | number | undefined | null>;

const EMBED_KEY = "pi-web:embed-mode";

/** Message types a host (e.g. the Obsidian plugin) can listen for. */
export const HOST_MESSAGE_SOURCE = "pi-web";
export const OPEN_PANEL_MESSAGE = "open-panel";

export function isEmbedMode(): boolean {
  try {
    return window.sessionStorage.getItem(EMBED_KEY) === "1";
  } catch {
    return false;
  }
}

export function markEmbedMode(): void {
  try {
    window.sessionStorage.setItem(EMBED_KEY, "1");
  } catch {
    // Private modes may refuse storage; the ?embed=1 param still works per load.
  }
}

export function buildPanelUrl(kind: PanelKind, params: PanelParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const query = search.toString();
  const path = `/panel/${kind}${query ? `?${query}` : ""}`;
  // Absolute: the host frame (Obsidian's app://obsidian.md document) cannot
  // resolve a relative URL, so its iframe would load a blank page instead.
  return typeof window === "undefined" ? path : `${window.location.origin}${path}`;
}

export interface OpenPanelMessage {
  source: typeof HOST_MESSAGE_SOURCE;
  type: typeof OPEN_PANEL_MESSAGE;
  panel: PanelKind;
  url: string;
}

/**
 * Forward a one-way notice to the host frame, e.g. a file page's line
 * selection becoming a chat `@`-mention. No-op when not framed.
 */
export function postToHost(message: Record<string, unknown>): void {
  if (window.parent === window) return;
  window.parent.postMessage({ source: HOST_MESSAGE_SOURCE, ...message }, "*");
}

/**
 * Show a panel page outside the main UI: inside a frame the request goes to
 * the host as a postMessage; standalone (browser testing) opens a real tab.
 */
export function openPanel(kind: PanelKind, params: PanelParams): void {
  const url = buildPanelUrl(kind, params);
  if (window.parent !== window) {
    const message: OpenPanelMessage = { source: HOST_MESSAGE_SOURCE, type: OPEN_PANEL_MESSAGE, panel: kind, url };
    window.parent.postMessage(message, "*");
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
