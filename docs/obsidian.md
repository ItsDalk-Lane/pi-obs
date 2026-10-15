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
  manifest.json      plugin metadata (id `pi-obs`, desktop-only, Obsidian >= 1.5.0)
  main.ts            the plugin: views, server lifecycle, the two settings tabs
  main.js            esbuild output (git-ignored, but published)
  styles.css         iframe sizing, the connecting and offline states
  esbuild.config.mjs bundle: main.ts + ../lib/{file-icon-names,app-update,pi-obs-server}.ts -> main.js
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
3. Enable **Pi Obs** under **Settings → Community plugins**.

BRAT reads the repository's GitHub releases, not the npm package. It expects `main.js`, `manifest.json` and `styles.css` as release assets; the `obsidian-plugin/` subdirectory is fine because BRAT reads the release, not the source tree.

**The release tag, the release name and `version` in `manifest.json` must all be identical.** Obsidian rejects a release whose three disagree, and BRAT warns and overrides when they do not. See [release.md](./release.md).

### Manually

Copy the three files into the vault's plugin folder. The folder name must match the `id` in `manifest.json`:

```text
<vault>/.obsidian/plugins/pi-obs/
  main.js
  manifest.json
  styles.css
```

Then enable it under **Settings → Community plugins**. The ribbon shows a bot icon, and the command palette has **Pi Obs: 打开 Pi Obs**.

Obsidian loads plugins only in the desktop app, which is why `manifest.json` sets `isDesktopOnly: true`.

## Versioning

The plugin has its own version line, independent of the npm package:

| Where | Field | Currently |
| --- | --- | --- |
| `obsidian-plugin/manifest.json` | `version` | `0.1.0` |
| `package.json` | `version` | `0.1.0` |

Users update the plugin through BRAT and the server through npm, and the two rarely move together. **Never bump either version without an explicit request** — the user owns both version lines now.

## Settings

One page under **Settings → Pi Obs**: a live server-status card on top, the npm package card under it, then the preferences. Detection runs when the page opens and on the status card's 刷新 button — there is no polling. Every value the cards display — address, port, mode, pids, the package's install path — copies to the clipboard on click.

The plugin's own UI text (settings tab, ribbon tooltip, command, notices, panel titles) is Simplified Chinese; the embedded web UI follows its own locale (see [i18n.md](./i18n.md)).

### 服务器状态 (status card)

A state dot and label （运行中 / 启动中… / 未运行）, value rows, and exactly the buttons the state allows: running → 刷新 and 停止； starting → 刷新 and a disabled 启动中…; stopped → 启动 alone. 启动 spawns the server for the current mode and waits up to 5 minutes. 停止 ends whatever listens on the port, whoever started it: the plugin's own process first, then any node/next process found there; a listener that is neither is left alone and reported.

### npm 包 (package card)

`pi-obs` and its version on the left (`v0.1.0 → v0.1.1` when an update is out), the install path under it in small text (click to copy), and on the right exactly the actions the state allows — not installed: 安装； installed with an update out: 更新 and 卸载； installed and current: 卸载. 安装 opens a dialog choosing between the plugin folder (`<plugin folder>/pi-obs-app`) and the global npm directory. 更新 and 卸载 act on whichever install is actually there. Until `pi-obs` is published `npm view` answers nothing, so no 更新 shows — 卸载 alone.

### Preferences

| Setting | Default | Meaning |
| --- | --- | --- |
| 运行模式 | npm 包（推荐） | The two ways to supply the server, mutually exclusive; switching stops the running server first. 本地目录（开发调试）is for working on the web UI itself and always starts with `npm run dev` — there is no start-command setting. Switching never redraws the page: every preference stays, only the status card re-detects. |
| 启动目录 | *(empty)* | Always shown; used by local mode: the checkout to run `npm run dev` in. |
| 端口 | `30141` | Port the server listens on. |
| 退出时停止服务器 | on | End the server on unload (Obsidian quitting or the plugin being disabled). Also ends one started elsewhere; off ends only the plugin's own process. |
| 面板位置 | New tab | Where file, terminal, subagent and full-history panels open: a tab of the main area, or a tab of the right sidebar. |

### Two ways to supply the server

Starting is explicit: the status card's 启动 button, which waits up to 5 minutes for the port to answer. Opening a view never starts or installs anything — with no server answering, the view draws an offline hint （打开设置 / 重试） instead, and there is only ever one main view.

**Resuming on launch.** Quitting Obsidian always ends the spawned server, so if it was running then, the next plugin load starts it again with the mode in effect (local → 启动目录， npm → the installed package). A deliberate 停止 or a crash clears the flag, and those are not resumed. When something already answers on the port at launch, nothing is started.

**运行模式 = 本地目录（开发调试）** — the plugin spawns `npm run dev` in 启动目录. Use it while working on the web UI itself.

**运行模式 = npm 包（推荐）** — the plugin starts the installed `pi-obs` package: the plugin-folder install (`<plugin folder>/pi-obs-app`) when there is one, else the global one. Starting requires an install to exist — none is made as a side effect; the npm 包 card's 安装 button does that, into the scope its dialog picks. The start command is derived, not configured: `node "<install>/node_modules/pi-obs/bin/pi-obs.js" -p <port> --no-open` （插件目录） or `pi-obs -p <port>` （全局）.

Neither mode installs a global package on its own.

## Embed Mode

The plugin loads the UI with `?embed=1`. That flag is written to `sessionStorage` under `pi-obs:embed-mode` so it survives client-side navigation, and `components/AppShell.tsx` reads it on every mount.

While embedded, anything that would open in the web UI's own right-hand panel is instead **handed to Obsidian as a request for a standalone page**:

| Panel | Route | Query parameters |
| --- | --- | --- |
| File | `/panel/file` | `path`, `cwd`, `sourceSessionId`, `page`, `mode` |
| Terminal | `/panel/terminal` | `cwd`, `id` |
| Subagent | `/panel/agent` | `session`, `label` |
| Full history | `/panel/history` | `session` |

The request is a `postMessage` to the parent frame:

```js
{ source: "pi-obs", type: "open-panel", panel: "file", url: "http://127.0.0.1:30141/panel/file?path=…" }
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

The plugin reuses the web UI's own artwork. `lib/file-icon-names.ts` maps a file name to a Catppuccin icon name; the plugin fetches `/icons/catppuccin/<latte|mocha>/<name>.svg` from the running server and registers it under the id `pi-obs-cat-<name>`, picking `mocha` on Obsidian's dark theme and `latte` on its light one.

Obsidian draws an icon on a 100×100 canvas while these SVGs are drawn on 16×16, so registering one verbatim leaves it 16% of the canvas — a dot at header size. The plugin wraps the inner markup in `<g transform="scale(6.25)" stroke-width="1">` instead. Terminal, subagent and history panels use Obsidian's built-in `terminal`, `bot` and `history` icons.

## Failure Behavior

- **Server down at view open** — the view shows an offline hint with 打开设置 and 重试, never a blank frame, and it never starts a server itself. Only one main view exists; extras a restored workspace left behind are detached on layout ready.
- **Server dies mid-session** — the iframe is not recreated until the port answers again.
- **Uninstall** — the plugin ends the server on unload. With 退出时停止服务器 on (the default) it stops whatever listens on the port, including a server the user started by hand; with it off it kills only the process tree it started (`taskkill /T /F` on Windows, `kill` elsewhere).

## Publishing

Two artifacts come out of this repository, on independent version lines:

| Artifact | Where it goes | Version lives in |
| --- | --- | --- |
| The server (`pi-obs`) | npm | `package.json` `version` |
| The plugin (`pi-obs`) | GitHub Release assets on `ItsDalk-Lane/pi-obs` | `obsidian-plugin/manifest.json` `version` |

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