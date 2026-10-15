# Pi Obs — Obsidian adaptation fork

[中文文档](./README.zh-CN.md) | [日本語](./README.ja.md) | [Русский](./README.ru.md)

> **This repository is a fork of [agegr/pi-web](https://github.com/agegr/pi-web), not a standalone project.**
>
> This repository: <https://github.com/ItsDalk-Lane/pi-obs> ·
> Upstream: `agegr/pi-web`, MIT licensed, copyright `agegr` (see [LICENSE](./LICENSE), unchanged).
> The local change is a single one: **adapting the web UI to run inside Obsidian as a local desktop
> plugin**. It adds the `obsidian-plugin/` directory, an embed mode (`?embed=1`), and a set of
> standalone panel routes (`/panel/*`); the npm package name becomes `pi-obs`.
> See the [Obsidian plugin document](./docs/obsidian.md) for the adaptation in detail.
>
> Everything not marked below is identical to upstream.

Local browser UI for the [pi coding agent](https://github.com/earendil-works/pi). Pi Obs uses the same local configuration and session files as pi, so you can browse and resume conversations, run agent turns, configure models and resources, and inspect project files from a browser.

**To use it in Obsidian**: see the [Obsidian plugin document](./docs/obsidian.md). It covers building and installing the plugin, every setting, and how embed mode and the panel routes behave.

> The rest of this file is upstream documentation.

**[Try the interactive demo →](https://agegr.github.io/pi-obs/)** The real Pi Obs UI runs entirely in your browser, with sample sessions, files and models. There is nothing to install; replies are pre-written and no model is called.

![Pi Obs displaying a pi session with structured Markdown, tool calls, and project navigation](https://raw.githubusercontent.com/agegr/pi-web/main/docs/screenshot2.png)

## How This Fork Differs from Upstream

Only the parts that affect use:

| Area | Upstream | This fork |
| --- | --- | --- |
| npm package name | `@agegr/pi-web` | `pi-obs` |
| Host | a browser tab | an Obsidian view, or a browser tab |
| Right-hand panels | rendered inside the page | handed to Obsidian when embedded, each as its own tab |
| License and copyright | MIT / `agegr` | unchanged |

Session files, models and configuration are shared on both sides; interface behavior is identical.

## Features

- **Session workspace**: browse, resume, rename, export, and delete conversations grouped by project, with running state, context usage, cost, and compaction details.
- **Two ways to branch**: **New session** creates an independent session file from an earlier message; **Edit from here** creates a branch inside the current session.
- **Project file tools**: browse and upload files, inspect Git diffs, and preview source, Markdown, images, audio, PDFs, and DOCX files with automatic refresh.
- **Git worktrees**: switch checkouts from the sidebar while keeping sessions from the same repository grouped together.
- **Web-based configuration**: manage provider login and API keys, models, model tests, plugin packages, and skills without leaving Pi Obs.
- **English, Simplified Chinese, and Traditional Chinese UI**: Pi Obs follows the browser language initially and provides a language switcher in the top bar.

## Quick Start

> **Status**: until `pi-obs` is published, run this from a checkout of this repository
> (`npm install && npm run dev`). After publication the command below works as written.
> The command name is `pi-obs` (see `bin` in `package.json`). To use the upstream release instead,
> see [docs/release.md](./docs/release.md).

Pi Obs requires Node.js 22.19.0 or newer. Check your version with `node --version`, then run:

```bash
npx pi-obs@latest
```

The CLI opens a browser after the server is ready. If it does not, open [http://127.0.0.1:30141](http://127.0.0.1:30141). Pi Obs listens only on `127.0.0.1` by default.

If no model provider is configured yet, open the **Models** panel to sign in or add an API key.

To install the `pi-obs` command globally:

```bash
npm install -g pi-obs@latest
pi-obs
```

Commands:

```bash
pi-obs version          # print the installed version
pi-obs status           # list running servers
pi-obs stop [--port N]  # stop a running server
pi-obs open [--port N]  # open a running server in the browser
pi-obs update [--check] # update a global npm install
```

To update, run `pi-obs stop`, then `pi-obs update` (or run the same install command again). To uninstall, run `npm uninstall -g pi-obs`.

## Configuration

For port and hostname, command-line options override the corresponding environment variables. Either `--no-open` or `PI_OBS_NO_OPEN=1` disables automatic browser opening. Run `pi-obs --help` (or `-h`) to print startup options and exit without starting the server. Unknown options exit with an error.

| Option or environment variable | Purpose | Default |
| --- | --- | --- |
| `--help`, `-h` | Print startup options and exit | — |
| `--port <port>`, `-p <port>`, or `PORT` | Server port | `30141` |
| `--hostname <host>`, `-H <host>`, or `PI_OBS_HOSTNAME` | Bind hostname | `127.0.0.1` |
| `--no-open` or `PI_OBS_NO_OPEN=1` | Do not open a browser automatically | Browser opens |
| `PI_OBS_APP_NAME` | PWA manifest `name` and `short_name`; surrounding whitespace is trimmed, empty values use the default | `Pi Obs` |
| `PI_OBS_SKIP_VERSION_CHECK=1` | Disable Pi Obs update checks | Unset |
| `PI_OBS_ALLOWED_HOSTS` | Additional exact proxy or custom hostnames, comma-separated | Unset |
| `PI_OBS_PASSWORD` | Enable browser password login; API clients may use Basic Auth with username `pi` | Authentication disabled |
| `PI_OBS_IDLE_TIMEOUT_MS` | Session idle timeout in milliseconds, up to `2147483647`; `0` disables idle shutdown; invalid or out-of-range values use the default | `600000` (10 min) |
| `PI_OBS_SHUTDOWN_DEADLINE_MS` | How long extensions get to handle `session_shutdown` before a closing session is disposed anyway, in milliseconds up to `2147483647`; `0`, invalid or out-of-range values use the default | `5000` (5 s) |

Set `PI_OBS_APP_NAME` before starting the server (for example, `PI_OBS_APP_NAME='Work Pi' pi-obs`). After changing it, restart the server to serve the new manifest; no rebuild is required. Updates to the name of an already installed PWA are managed by the browser and are not guaranteed to appear immediately. This does not change the page title or icons.

For example:

```bash
pi-obs --help
pi-obs -p 8080 -H 0.0.0.0 --no-open
```

### Remote Access

Binding to a non-loopback address exposes an agent that can execute high-privilege actions. On a trusted LAN, require a long random password:

```bash
PI_OBS_PASSWORD='a-long-random-password' pi-obs --hostname 0.0.0.0
```

Password authentication does not encrypt the connection. Do not expose Pi Obs over plain HTTP to the internet; use HTTPS through a trusted reverse proxy or a trusted VPN. If a reverse proxy sends an external hostname, add that exact name to `PI_OBS_ALLOWED_HOSTS`. This allow-list does not change the address Pi Obs binds to.

### HTTP Proxy

Server-side model and API requests honor the standard `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` environment variables.

On macOS or Linux:

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npx pi-obs@latest
```

On Windows PowerShell:

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npx pi-obs@latest
```

## Notes

- **Agent data**: Pi Obs reads pi data from `~/.pi/agent` by default, including session files under `sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`. Set `PI_CODING_AGENT_DIR` to use another pi agent directory.
- **Filesystem access**: Pi Obs must be able to read the agent data directory and the working directories recorded by its sessions. Run Pi Obs in the same filesystem environment as pi when sharing existing sessions.
- **Shared configuration**: the Models panel uses pi's model, settings, and credential storage, so changes are visible to both interfaces.
- **File access boundary**: the file browser is limited to working directories selected in Pi Obs and project or session roots it already knows about; it is not a general filesystem browser.
- **Git worktrees**: see [Worktrees in Pi Obs](./docs/worktrees.md) for switcher visibility, worktree creation, and removal behavior.

### Downstream Session Context Menu

Electron wrappers and other downstream integrations can provide a session-row
context menu without patching `SessionSidebar`. Listen for the cancelable
`pi-obs:session-row-contextmenu` browser event and call `preventDefault()`
synchronously when the integration will handle it:

```js
window.addEventListener("pi-obs:session-row-contextmenu", (event) => {
  event.preventDefault();
  const { id, path, cwd, name, clientX, clientY, refresh } = event.detail;

  void openSessionMenu({ id, path, cwd, name, clientX, clientY }).then((changed) => {
    if (changed) refresh();
  });
});
```

The detail object contains `id`, `path`, `cwd`, optional `name`, pointer
coordinates, and a `refresh()` callback for actions that change the session
list. If no listener cancels the extension event, Pi Obs opens its built-in
session menu (pin, rename, fork, mark read or unread, archive, open in new
tab, delete) at the pointer instead of the browser's native context menu.
The row's `⋯` button always opens the built-in menu and does not dispatch the
event. Sessions not yet saved to disk get no built-in menu, so the native one
still appears for them. This hook is browser-side and independent of Pi agent
extensions.

### Extension Session Liveness

Server-side Pi extensions with detached work can prevent automatic idle
session eviction through the versioned global registry:

```js
const liveness = globalThis[Symbol.for("pi-obs/session-liveness/v1")];
const release = liveness?.version === 1
  ? liveness.register({
      name: "my-extension",
      sessionId,
      sessionFile: sessionFile || undefined,
      isActive: () => detachedJobs.size > 0,
    })
  : () => {};
```

Register once per active extension session and call the returned idempotent
`release` function on session shutdown, replacement, or reload. `isActive`
must be synchronous, cheap, and scoped to the supplied exact session id or
file. Provider errors fail safe by preserving that session. This lease only
affects automatic idle eviction; explicit shutdown and Stop fallback cleanup
still take precedence.

## Development

```bash
npm install
npm run dev
```

The development server runs at [http://127.0.0.1:30141](http://127.0.0.1:30141). Run the common checks with:

```bash
npm test
node_modules/.bin/tsc --noEmit
npm run lint
```

Do not run `next build` or `npm run build` during normal development. It writes to `.next/` and can interfere with the development server; leave builds for release work.

Contributor guides: [Internationalization](./docs/i18n.md) and [Release process](./docs/release.md).

## Repository Layout

```text
app/             Next.js UI and API routes
  panel/         Standalone panel pages for embed mode (file / terminal / agent / history)
components/      React UI components
hooks/           Client state and interaction hooks
lib/             Session, agent, model, file, Git, and security logic
public/          Static assets and PWA files
bin/             npm CLI entrypoint and launch option parsing
docs/            Focused user and contributor guides
demo/            Static browser demo published to GitHub Pages (see demo/README.md)
obsidian-plugin/ Added by this fork: the Obsidian desktop plugin (see docs/obsidian.md)
```

See [AGENTS.md](./AGENTS.md) for the architecture notes and detailed file map. For the Obsidian adaptation and the notes on syncing with upstream, see [docs/obsidian.md](./docs/obsidian.md).

## License

[MIT](./LICENSE), copyright `agegr`, unchanged from upstream. This fork's additions fall under the same license.
