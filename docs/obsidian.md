# Obsidian Plugin

This repository is a fork of [agegr/pi-web](https://github.com/agegr/pi-web) that adapts the web UI to run **inside Obsidian** as a local desktop plugin. This document describes what the fork adds. For everything the web UI already does, see the [README](../README.md).

## What the Fork Adds

| Area | Upstream | This fork |
| --- | --- | --- |
| npm package name | `@agegr/pi-web` | `pi-obs` (declared in `package.json` `bin`) |
| Host application | a browser tab | an Obsidian view (`iframe` into a locally spawned server) |
| Right-hand panels | rendered inside the page | handed to Obsidian as separate tabs |
| File-type icons | Catppuccin SVGs in the web UI's own tab bar | the same SVGs, registered as Obsidian header icons |
| Release target | GitHub Releases on `agegr/pi-web` | none; see [Publishing](#publishing) |

The web UI itself is unchanged in behavior: same session files, same models, same configuration — a session started in Obsidian is readable from a browser and the other way around.

## Layout

```text
obsidian-plugin/
  manifest.json      plugin metadata (id `pi-web`, desktop-only, Obsidian >= 1.5.0)
  main.ts            the plugin: views, server lifecycle, settings tab
  main.js            esbuild output (git-ignored, but published)
  styles.css         iframe sizing, the connecting and offline states
  esbuild.config.mjs bundle: main.ts + ../lib/file-icon-names.ts -> main.js
  package.json       plugin-only devDependencies (obsidian, esbuild, typescript)
```

`lib/file-icon-names.ts` lives on the **web** side of the fork and the plugin imports it. That file is pure data and functions — no JSX, no React — so esbuild can bundle the same mapping into `main.js` and the two icon tables cannot drift apart.

## Building

```bash
npm install
npm run build                       # the Next.js production build the server serves
npm run build:plugin                # tsc --noEmit + esbuild -> obsidian-plugin/main.js
```

`npm run build:plugin` is shorthand for `npm --prefix obsidian-plugin run build`; run it after changing `main.ts`, `manifest.json`, `styles.css` or anything `main.js` bundles in. `npm run release` runs it for you.

The three distributable files are `main.js`, `manifest.json` and `styles.css`. `main.js` is git-ignored — it is built, not committed — but it **is** published: it is listed in `package.json` `files` so it ships inside the npm tarball.

## Installing

### With BRAT

1. Install **BRAT** from the community plugins browser.
2. **Settings → BRAT → Add Beta Plugin**, paste `ItsDalk-Lane/pi-obs`.
3. Enable **Pi Web** under **Settings → Community plugins**.

BRAT reads the repository's GitHub releases, not the npm package. It expects `main.js`, `manifest.json` and `styles.css` as release assets; the `obsidian-plugin/` subdirectory is fine because BRAT reads the release, not the source tree.

**The release tag, the release name and `version` in `manifest.json` must all be identical.** Obsidian rejects a release whose three disagree, and BRAT warns and overrides when they do not. See [release.md](./release.md).

### Manually

Copy the three files into the vault's plugin folder. The folder name must match the `id` in `manifest.json`:

```text
<vault>/.obsidian/plugins/pi-web/
  main.js
  manifest.json
  styles.css
```

Then enable it under **Settings → Community plugins**. The ribbon shows a bot icon, and the command palette has **Pi Web: Open Pi Web**.

Obsidian loads plugins only in the desktop app, which is why `manifest.json` sets `isDesktopOnly: true`.

## Versioning

The plugin has its own version line, independent of the npm package:

| Where | Field | Currently |
| --- | --- | --- |
| `obsidian-plugin/manifest.json` | `version` | `0.1.0` |
| `package.json` | `version` | `0.12.1` |

Users update the plugin through BRAT and the server through npm, and the two rarely move together. Bump the plugin's `version` for any change under `obsidian-plugin/`; bump the package's for anything in the web UI. Release notes should say which one a release carries.

## Settings

**Settings → Pi Web**.

| Setting | Default | Meaning |
| --- | --- | --- |
| Pi Web directory | *(empty)* | A checkout to run from. The start command runs **there**, so this is the development mode: point it at a clone and edit code with hot reload. |
| Start command | `npm run dev` | Shell command that starts the server. Only read when a directory is set. |
| Pi Web package | `pi-obs` | npm package installed into the plugin folder. Only read when no directory is set. |
| Port | `30141` | Port the server listens on. Must match whatever the start command or the plugin passes. |
| Start Pi Web automatically | on | Install (once) and spawn the server when a view opens and nothing answers yet. |
| Panel placement | New tab | Where file, terminal, subagent and full-history panels open: a tab of the main area, or a tab of the right sidebar. |

### Two ways to supply the server

**Directory set** — the plugin spawns the start command in that directory and waits up to 90 seconds for the port to answer. Use it while working on the web UI itself.

**Directory empty** — the plugin installs `packageName` into `<plugin folder>/pi-web-app` on first enable and starts it with `node …/bin/pi-web.js -p <port> --no-open`. Nothing lives outside the plugin folder, so deleting the folder removes the server with it. First install pulls `next` and `node-pty`, so the wait ceiling here is 300 seconds.

## Embed Mode

The plugin loads the UI with `?embed=1`. That flag is written to `sessionStorage` under `pi-web:embed-mode` so it survives client-side navigation, and `components/AppShell.tsx` reads it on every mount.

While embedded, anything that would open in the web UI's own right-hand panel is instead **handed to Obsidian as a request for a standalone page**:

| Panel | Route | Query parameters |
| --- | --- | --- |
| File | `/panel/file` | `path`, `cwd`, `sourceSessionId`, `page`, `mode` |
| Terminal | `/panel/terminal` | `cwd`, `id` |
| Subagent | `/panel/agent` | `session`, `label` |
| Full history | `/panel/history` | `session` |

The request is a `postMessage` to the parent frame:

```js
{ source: "pi-web", type: "open-panel", panel: "file", url: "http://127.0.0.1:30141/panel/file?path=…" }
```

`lib/embed-mode.ts` builds the URL absolutely on purpose: the plugin's document is `app://obsidian.md`, so a relative URL would resolve against that scheme and the iframe would come up blank.

The plugin only accepts messages whose `origin` equals its own base URL. Each accepted panel becomes an Obsidian tab; opening the same URL again reveals the existing tab instead of duplicating it.

Two messages travel the other way, from a file panel to the host:

| Message | Payload | Used for |
| --- | --- | --- |
| `mention-lines` | `path`, `startLine`, `endLine` | a line selection becoming a chat `@`-mention |
| `mention` | `path`, `isDir` | an `@`-mention of a whole file or folder |

Standalone (a normal browser tab), `openPanel` falls back to `window.open`, so the `/panel/*` routes stay testable without Obsidian.

## Panel Headers

The plugin reuses the web UI's own artwork. `lib/file-icon-names.ts` maps a file name to a Catppuccin icon name; the plugin fetches `/icons/catppuccin/<latte|mocha>/<name>.svg` from the running server and registers it under the id `pi-web-cat-<name>`, picking `mocha` on Obsidian's dark theme and `latte` on its light one.

Obsidian draws an icon on a 100×100 canvas while these SVGs are drawn on 16×16, so registering one verbatim leaves it 16% of the canvas — a dot at header size. The plugin wraps the inner markup in `<g transform="scale(6.25)" stroke-width="1">` instead. Terminal, subagent and history panels use Obsidian's built-in `terminal`, `bot` and `history` icons.

## Failure Behavior

- **Server down at view open** — the view shows a retry button, never a blank frame. A workspace restored during a restart hits this path.
- **Server dies mid-session** — the iframe is not recreated until the port answers again.
- **Uninstall** — the plugin kills the process tree it started (`taskkill /T /F` on Windows, `kill` elsewhere) on unload. A server the user started by hand is not touched.

## Publishing

Two artifacts come out of this repository, on independent version lines:

| Artifact | Where it goes | Version lives in |
| --- | --- | --- |
| The server (`pi-obs`) | npm | `package.json` `version` |
| The plugin (`pi-web`) | GitHub Release assets on `ItsDalk-Lane/pi-obs` | `obsidian-plugin/manifest.json` `version` |

`npm run release` builds both — the Next.js production build and `npm run build:plugin` — and publishes the npm package with the plugin's three files inside it. The GitHub Release is created separately, because it carries the plugin assets BRAT downloads; see [release.md](./release.md).

The plugin is distributed through BRAT rather than the Obsidian community store. That has one concrete consequence: the official listing requires `manifest.json` at the **repository root**, and this repository keeps it under `obsidian-plugin/`. Submitting to the community list would mean moving the plugin's files to the root; BRAT has no such requirement.

**Before the first push**, the code needs to reach the remote — the repository is currently empty:

```bash
git remote add origin https://github.com/ItsDalk-Lane/pi-obs.git
git push -u origin main
```

## Relationship to Upstream

Upstream is <https://github.com/agegr/pi-web> by `agegr`, MIT licensed, `Copyright (c) 2026 agegr` as recorded in [LICENSE](../LICENSE). This fork keeps that copyright and license unchanged; the Obsidian-specific work is additive.

Sync with upstream by rebasing onto a newer tag and re-checking the three integration points, in order of how likely they are to break:

1. `components/AppShell.tsx` — the panel-opening calls must stay routed through `openPanel` from `lib/embed-mode.ts`.
2. `lib/file-icon-names.ts` — the plugin imports it across the repository boundary; changing its exports breaks the esbuild bundle.
3. `manifest.json` and the settings tab — the plugin's contract with the vault.