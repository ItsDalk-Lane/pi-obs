import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { ChildProcess, execFile, execFileSync, spawn } from "child_process";
import { addIcon, FileSystemAdapter, ItemView, Modal, Notice, Plugin, PluginSettingTab, removeIcon, requestUrl, Setting, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { CATPPUCCIN_ICONS_ROOT, catppuccinIconFor } from "../lib/file-icon-names";
import { isNewerStableVersion } from "../lib/app-update";
import {
  applyPortPlaceholder,
  deriveNpmStartCommand,
  isLikelyServerProcess,
  killTreeCommand,
  listenOwnerCommands,
  npmGlobalListArgs,
  npmGlobalRootArgs,
  npmInstallArgs,
  npmShellCommand,
  npmUninstallArgs,
  npmViewVersionArgs,
  parseListenerPids,
  parseNpmGlobalRoot,
  parseNpmGlobalVersion,
  parseNpmViewVersion,
  parsePackageVersion,
  parseProcessCommand,
  processQueryCommand,
  resolveNpmRunner,
} from "../lib/pi-obs-server";

const MAIN_VIEW_TYPE = "pi-obs-main";
const PANEL_VIEW_TYPE = "pi-obs-panel";

/** Directory inside the plugin folder holding the plugin's own npm install. */
const BUNDLED_DIR_NAME = "pi-obs-app";

/** The npm package that provides the server in npm mode. Not a setting: it is
    this plugin's own package, and a typo here could only break things. */
const PACKAGE_NAME = "pi-obs";

/** Local mode is the developer-debug way to run, and its command is fixed. */
const LOCAL_START_COMMAND = "npm run dev";

/** How the server is supplied: a checkout run from disk, or a published npm package. */
type RunMode = "local" | "npm";

/** Where an npm-mode install lands: globally, or inside the plugin folder. */
type NpmInstallScope = "global" | "plugin";

interface PiObsSettings {
  /** Port Pi Obs listens on. */
  port: number;
  /** Which of the two mutually exclusive ways supplies the server. */
  runMode: RunMode;
  /**
   * Pi Obs checkout directory; the start command runs there (local mode).
   */
  dir: string;
  /** End the server when the plugin is unloaded (Obsidian quits or it is disabled). */
  stopOnExit: boolean;
  /** Where a panel page (files, terminals, subagents, full history) opens. */
  panelPlacement: PanelPlacement;
  /**
   * Persisted state, not a preference: the plugin's server was running when
   * the plugin last unloaded, so the next load resumes it. Obsidian always
   * ends the spawned server on quit; this flag is what brings it back.
   */
  wasRunning: boolean;
}

/** New tab in the main area, or a tab of the right sidebar's dock. */
type PanelPlacement = "tab" | "right-sidebar";

const DEFAULT_SETTINGS: PiObsSettings = {
  port: 30141,
  runMode: "npm",
  dir: "",
  stopOnExit: true,
  panelPlacement: "tab",
  wasRunning: false,
};

/** What the settings page's server card shows. */
interface ServerStatus {
  running: boolean;
  /** A start is in flight, so "未运行" would read as a failure. */
  starting: boolean;
  url: string;
  port: number;
  /** Pids listening on the port, and what each one is (null = unreadable). */
  listeners: { pid: number; command: string | null }[];
  /** Whether the plugin itself spawned the process it holds. */
  ours: boolean;
  /** "本地目录 — <dir>" or "npm 包运行"; the local mode's dir lives here. */
  modeLabel: string;
}

/** An installed npm-mode package: where, and which version. */
interface InstalledNpmPackage {
  scope: NpmInstallScope;
  version: string;
  /** The directory the install lives in (shown, and copied on click). */
  location: string;
}

/** What the server tab's package row shows. */
interface NpmPackageInfo {
  installed: InstalledNpmPackage | null;
  /** The newest published version (null when npm cannot answer). */
  latest: string | null;
  updateAvailable: boolean;
}

/** Result of an install / uninstall / update, with a line for the Notice. */
interface NpmActionResult {
  ok: boolean;
  message: string;
}

interface CapturedRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command and capture its output; never throws on a non-zero exit. */
function execCapture(
  command: string,
  args: string[],
  options: { cwd?: string; shell?: boolean; timeoutMs?: number } = {},
): Promise<CapturedRun> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        shell: options.shell ?? false,
        windowsHide: true,
        encoding: "utf8",
        timeout: options.timeoutMs ?? 60_000,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Copy to the system clipboard and say so; the settings tab's copyable lines
    and the package row's install path both go through here. */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    new Notice(`已复制：${text}`);
  } catch {
    new Notice("复制失败。");
  }
}

/**
 * The synchronous twin of `execCapture`, used while the plugin unloads: Obsidian
 * quits before an awaited chain could finish, so ending the server there has to
 * block until the kill returned.
 */
function execCaptureSync(command: string, args: string[], timeoutMs = 5_000): CapturedRun {
  try {
    const stdout = execFileSync(command, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.status === "number" ? failure.status : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

/** Human tab title for a /panel/* URL, before the iframe's own title could be used. */
function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url, "http://localhost");
    const path = parsed.pathname;
    if (path === "/panel/terminal") {
      const cwd = parsed.searchParams.get("cwd") ?? "";
      return `终端 — ${cwd.split(/[\\/]/).pop() || cwd}`;
    }
    if (path === "/panel/file") {
      return panelFileName(parsed) || "文件";
    }
    if (path === "/panel/agent") {
      return parsed.searchParams.get("label") || "子代理";
    }
    if (path === "/panel/history") {
      return "完整历史";
    }
    return "Pi Obs";
  } catch {
    return "Pi Obs";
  }
}

/** The file name inside a /panel/file URL's `path` parameter. */
function panelFileName(parsed: URL): string {
  const path = parsed.searchParams.get("path") ?? "";
  return path.split(/[\\/]/).pop() ?? "";
}

/** Custom icon ids the plugin registers: Obsidian's own set carries no
    language icons, so a file panel borrows the icon the web UI's tab shows. */
const PANEL_ICON_PREFIX = "pi-obs-cat-";

/** Obsidian draws an icon's content on a 100x100 canvas; the web UI's
    Catppuccin icons are drawn on 16x16 (all 32 of them), so registering one
    verbatim leaves it 16% of the canvas -- a dot at header size. Wrap the
    inner markup at the ratio, and pin the stroke the web UI renders at 1. */
function panelIconMarkup(svgText: string): string | null {
  const root = new DOMParser().parseFromString(svgText, "image/svg+xml").documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg") return null;
  return `<g transform="scale(6.25)" stroke-width="1">${root.innerHTML}</g>`;
}

/** Panel URLs arrive from the embedded UI; make them absolute, because a
    relative one inside this app://obsidian.md document resolves to a dead
    app:// URL and the iframe shows nothing but a blank page. */
function toAbsoluteUrl(base: string, url: string): string {
  if (/^https?:/i.test(url)) return url;
  try {
    return new URL(url, `${base}/`).href;
  } catch {
    return url;
  }
}

class PiObsMainView extends ItemView {
  private readonly plugin: PiObsPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: PiObsPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return MAIN_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Pi Obs";
  }

  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    await this.renderFrame();
  }

  /** Opening a view never starts a server: it shows how to start one. */
  private async renderFrame(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("pi-obs-embed");
    this.contentEl.createEl("p", { cls: "pi-obs-connecting", text: "正在连接 Pi Obs…" });
    const up = await this.plugin.serverReachable();
    this.contentEl.empty();
    if (!up) {
      this.plugin.renderOfflineBox(this.contentEl, () => { void this.renderFrame(); });
      return;
    }
    const iframe = this.contentEl.createEl("iframe");
    iframe.src = `${this.plugin.baseUrl()}/?embed=1`;
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }
}

class PiObsPanelView extends ItemView {
  private readonly plugin: PiObsPlugin;
  private url = "";
  private title = "Pi Obs";

  constructor(leaf: WorkspaceLeaf, plugin: PiObsPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return PANEL_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.title;
  }

  getIcon(): string {
    return this.plugin.panelIcon(this.url);
  }

  setState(state: unknown, result: ViewStateResult): Promise<void> {
    const url = (state as { url?: string } | null)?.url;
    if (url) this.applyUrl(url);
    return super.setState(state, result);
  }

  getState(): Record<string, unknown> {
    return { url: this.url };
  }

  private applyUrl(url: string): void {
    const absolute = toAbsoluteUrl(this.plugin.baseUrl(), url);
    // A repeated setState with the same url must not reload the iframe.
    if (absolute === this.url && this.contentEl.querySelector("iframe")) return;
    this.url = absolute;
    this.title = titleFromUrl(absolute);
    this.contentEl.empty();
    this.contentEl.addClass("pi-obs-embed");
    const iframe = this.contentEl.createEl("iframe");
    iframe.src = absolute;
  }

  async onOpen(): Promise<void> {
    if (!this.url) {
      // Restored without state (e.g. a manual addViewCall): nothing to show.
      this.contentEl.setText("Pi Obs 面板");
      return;
    }
    await this.renderFrame();
  }

  /** Same contract as the main view: no iframe before the server answers. */
  private async renderFrame(): Promise<void> {
    if (!this.url) return;
    this.contentEl.empty();
    this.contentEl.addClass("pi-obs-embed");
    this.contentEl.createEl("p", { cls: "pi-obs-connecting", text: "正在连接 Pi Obs…" });
    const up = await this.plugin.serverReachable();
    this.contentEl.empty();
    if (!up) {
      this.plugin.renderOfflineBox(this.contentEl, () => { void this.renderFrame(); });
      return;
    }
    const iframe = this.contentEl.createEl("iframe");
    iframe.src = this.url;
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }
}

export default class PiObsPlugin extends Plugin {
  settings: PiObsSettings = DEFAULT_SETTINGS;
  private proc: ChildProcess | null = null;
  private starting: Promise<boolean> | null = null;
  private readonly registeredIcons = new Set<string>();

  baseUrl(): string {
    return `http://127.0.0.1:${this.settings.port}`;
  }

  /** The header icon of a panel: the web UI's own file icon once registered,
      Obsidian's built-ins for the panels the web UI draws itself. */
  panelIcon(url: string): string {
    try {
      const parsed = new URL(url, "http://localhost");
      if (parsed.pathname === "/panel/file") {
        const id = PANEL_ICON_PREFIX + catppuccinIconFor(panelFileName(parsed));
        return this.registeredIcons.has(id) ? id : "file-text";
      }
      if (parsed.pathname === "/panel/terminal") return "terminal";
      if (parsed.pathname === "/panel/agent") return "bot";
      if (parsed.pathname === "/panel/history") return "history";
      return "panel-right-open";
    } catch {
      return "panel-right-open";
    }
  }

  /** Register the icon the web UI's tab bar shows for a file panel. The SVGs
      come from the running Pi Obs server, so the two are the same artwork. */
  private async ensurePanelIcon(url: string): Promise<void> {
    let iconName: string;
    try {
      const parsed = new URL(url, "http://localhost");
      if (parsed.pathname !== "/panel/file") return;
      iconName = catppuccinIconFor(panelFileName(parsed));
    } catch {
      return;
    }
    const id = PANEL_ICON_PREFIX + iconName;
    if (this.registeredIcons.has(id)) return;
    const theme = document.body.classList.contains("theme-dark") ? "mocha" : "latte";
    const res = await requestUrl({
      url: `${this.baseUrl()}${CATPPUCCIN_ICONS_ROOT}/${theme}/${iconName}.svg`,
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) return;
    const markup = panelIconMarkup(res.text);
    if (!markup) return;
    addIcon(id, markup);
    this.registeredIcons.add(id);
  }

  /** Panels restored with the workspace drew their headers before their icons
      existed; register those and redraw the headers. */
  private async refreshPanelIcons(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(PANEL_VIEW_TYPE)) {
      const view = leaf.view;
      if (!(view instanceof PiObsPanelView)) continue;
      const url = view.getState().url;
      if (typeof url !== "string" || !url) continue;
      const before = this.registeredIcons.size;
      await this.ensurePanelIcon(url);
      if (this.registeredIcons.size === before) continue;
      // Undocumented, but the only way to redraw a header whose icon changed.
      (leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
    }
  }

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(MAIN_VIEW_TYPE, (leaf) => new PiObsMainView(leaf, this));
    this.registerView(PANEL_VIEW_TYPE, (leaf) => new PiObsPanelView(leaf, this));

    this.addRibbonIcon("bot", "打开 Pi Obs", () => {
      void this.openMain();
    });

    this.addCommand({
      id: "open-pi-obs",
      name: "打开 Pi Obs",
      callback: () => {
        void this.openMain();
      },
    });

    // Panels of the embedded UI (files, terminals, subagents) ask the host to
    // show their standalone /panel page; each becomes a tab of its own.
    this.registerDomEvent(window, "message", (event: MessageEvent) => {
      const data = event.data as { source?: string; type?: string; url?: string } | null;
      if (event.origin !== this.baseUrl()) return;
      if (data?.source !== "pi-obs" || data?.type !== "open-panel" || typeof data.url !== "string") return;
      void this.openPanelTab(data.url);
    });

    this.addSettingTab(new PiObsSettingTab(this.app, this));

    // A panel restored with the workspace drew its header before its icon was
    // registered; redo those headers once the layout is up.
    this.app.workspace.onLayoutReady(() => {
      this.dedupeMainViews();
      void this.refreshPanelIcons();
      // Resume the server that was running when the plugin last unloaded --
      // Obsidian always ends the spawned server on quit, so it is restarted
      // here with the mode that was in effect.
      if (this.settings.wasRunning) void this.resumeLastServer();
    });
  }

  onunload(): void {
    // Blocking, so quitting Obsidian still ends the server.
    if (this.settings.stopOnExit) this.stopRunningSync();
    else this.stopOwnProcess();
    for (const id of this.registeredIcons) removeIcon(id);
    this.registeredIcons.clear();
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<PiObsSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
    // A settings file written before runMode existed said it with `dir`.
    if (this.settings.runMode !== "local" && this.settings.runMode !== "npm") {
      this.settings.runMode = stored?.dir?.trim() ? "local" : "npm";
    }
    this.settings.stopOnExit = this.settings.stopOnExit !== false;
    if (this.settings.panelPlacement !== "right-sidebar") this.settings.panelPlacement = "tab";
    this.settings.wasRunning = this.settings.wasRunning === true;
    // Keys written by older versions whose settings no longer exist: the
    // package is a constant now, npm mode's start command is derived, and
    // local mode's is fixed to `npm run dev`.
    const stale = this.settings as unknown as Record<string, unknown>;
    delete stale.packageName;
    delete stale.npmInstallScope;
    delete stale.npmStartCommand;
    delete stale.startCommand;
    delete stale.autoStart;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Switch modes: the other mode's server is stopped before the switch. */
  async setRunMode(mode: RunMode): Promise<boolean> {
    if (mode === this.settings.runMode) return true;
    const stopped = await this.stopRunning();
    if (!stopped) return false;
    this.settings.runMode = mode;
    await this.saveSettings();
    return true;
  }

  /** The plugin's own folder inside the vault's plugin directory. */
  private pluginFolder(): string {
    const adapter = this.app.vault.adapter as FileSystemAdapter;
    return join(adapter.getBasePath(), this.manifest.dir ?? "");
  }

  /** Absolute path of the plugin's own npm install, inside the plugin folder. */
  private bundledInstallDir(): string {
    return join(this.pluginFolder(), BUNDLED_DIR_NAME);
  }

  private bundledPackageDir(): string {
    const parts = PACKAGE_NAME.startsWith("@") ? PACKAGE_NAME.split("/") : [PACKAGE_NAME];
    return join(this.bundledInstallDir(), "node_modules", ...parts);
  }

  /** The version installed into the plugin folder, or null. */
  private pluginInstalledVersion(): string | null {
    try {
      return parsePackageVersion(readFileSync(join(this.bundledPackageDir(), "package.json"), "utf8"));
    } catch {
      return null;
    }
  }

  // --- the server ---------------------------------------------------------

  private isServerUp(): Promise<boolean> {
    return requestUrl({ url: `${this.baseUrl()}/`, method: "GET", throw: false })
      .then((res) => res.status >= 200 && res.status < 500)
      .catch(() => false);
  }

  /** The npm-mode start command, derived from the package and where it is installed. */
  private derivedNpmStartCommand(scope: NpmInstallScope): string {
    return applyPortPlaceholder(deriveNpmStartCommand({
      scope,
      installDir: this.bundledInstallDir(),
      pkg: PACKAGE_NAME,
      port: this.settings.port,
    }), this.settings.port);
  }

  /** The current mode in one line, for the settings pane. */
  modeLabel(): string {
    return this.settings.runMode === "local"
      ? `本地目录 — ${this.settings.dir.trim() || "（未设置）"}`
      : "npm 包运行";
  }

  /** Read-only: is a server already answering? Never starts one. */
  serverReachable(): Promise<boolean> {
    return this.isServerUp();
  }

  /**
   * The settings page's 启动 button (and the launch-time resume). Starting is
   * explicit: a view opening only ever shows the offline hint, so nothing is
   * installed or spawned behind the user's back.
   */
  async startServerManually(): Promise<NpmActionResult> {
    if (await this.isServerUp()) return { ok: true, message: "服务器已在运行。" };
    if (this.settings.runMode === "local" && !this.settings.dir.trim()) {
      return { ok: false, message: "请先在「运行模式 → 本地目录」里填写启动目录。" };
    }
    if (this.settings.runMode === "npm" && !(await this.installedNpmPackage())) {
      return { ok: false, message: "尚未安装 pi-obs 包，请先在设置页的 npm 包卡片中安装。" };
    }
    if (this.proc) return { ok: false, message: "服务器正在启动中，请稍候。" };
    // The dev script pins the port, so a silent listener (one that occupies it
    // without answering HTTP) would only make the start die on EADDRINUSE.
    // Name it instead of failing after a wait.
    const blockers = await this.listenerPids();
    if (blockers.length) {
      return { ok: false, message: `端口 ${this.settings.port} 已被进程 ${blockers.join("，")} 占用但不响应。请先点「停止」结束它，再启动。` };
    }
    const ready = await this.startAndAwait();
    if (ready) {
      // Remember it for the next launch: quitting Obsidian ends the server,
      // and this flag is what brings it back.
      this.settings.wasRunning = true;
      void this.saveSettings();
      return { ok: true, message: `服务器已启动：${this.baseUrl()}` };
    }
    // A timeout leaves the process running (a cold `next dev` can outlive the
    // wait); a dead process does not. Say which, so the notice is actionable.
    return this.proc
      ? { ok: false, message: `等待超时（端口 ${this.settings.port}，最长 5 分钟）。进程仍在运行，稍后可点「刷新」查看；若一直未就绪，请在开发者控制台查看 [pi-obs] 日志。` }
      : { ok: false, message: `启动进程已退出（端口 ${this.settings.port}）。请在开发者控制台查看 [pi-obs] 日志。` };
  }

  /**
   * The launch-time counterpart of the unload kill: restart the server that
   * was running when Obsidian closed. Silent on success -- a Notice on every
   * launch would be noise; failures do get one.
   */
  private async resumeLastServer(): Promise<void> {
    if (await this.isServerUp()) return; // something already answers
    const result = await this.startServerManually();
    if (!result.ok) new Notice(result.message);
    console.log(`[pi-obs] resume: ${result.message}`);
  }

  private async startAndAwait(): Promise<boolean> {
    if (!(await this.prepareStart())) return false;
    this.starting ??= this.waitForStart();
    const ready = await this.starting;
    this.starting = null;
    return ready;
  }

  private async waitForStart(): Promise<boolean> {
    this.startServer(await this.startSpec());
    // A cold `next dev` compile, and a first npm install, both take minutes.
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      if (await this.isServerUp()) return true;
      if (!this.proc) return false; // the process exited while we waited
      await delay(1000);
    }
    return false;
  }

  /** What has to be in place before the start command can run. */
  private async prepareStart(): Promise<boolean> {
    if (this.settings.runMode === "local") return Boolean(this.settings.dir.trim());
    return (await this.installedNpmPackage()) !== null;
  }

  /** The command and directory the current run mode starts the server with. */
  private async startSpec(): Promise<{ command: string; cwd: string }> {
    if (this.settings.runMode === "local") {
      return { command: LOCAL_START_COMMAND, cwd: this.settings.dir.trim() || this.pluginFolder() };
    }
    const installed = await this.installedNpmPackage();
    const scope: NpmInstallScope = installed?.scope ?? "plugin";
    return {
      command: this.derivedNpmStartCommand(scope),
      cwd: scope === "plugin" ? this.bundledInstallDir() : this.pluginFolder(),
    };
  }

  private startServer(spec: { command: string; cwd: string }): void {
    if (this.proc) return;
    const proc = spawn(spec.command, [], {
      cwd: spec.cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = proc;
    proc.stdout?.on("data", (chunk: Buffer) => {
      console.log("[pi-obs]", chunk.toString().trimEnd());
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      console.warn("[pi-obs]", chunk.toString().trimEnd());
    });
    proc.on("exit", (code) => {
      if (this.proc === proc) {
        this.proc = null;
        // The server died on its own: nothing to resume on the next launch
        // (auto-restarting a crash loop would be worse than none).
        this.settings.wasRunning = false;
        void this.saveSettings();
      }
      console.log(`[pi-obs] server exited with code ${code}`);
    });
  }

  /** End the process this plugin spawned, if any. */
  private stopOwnProcess(): boolean {
    const proc = this.proc;
    if (!proc || proc.pid === undefined) {
      this.proc = null;
      return false;
    }
    this.proc = null;
    // A shell-wrapped start (`shell: true`) has children that must die with it.
    const spec = killTreeCommand(proc.pid, process.platform);
    spawn(spec.command, spec.args, { windowsHide: true });
    return true;
  }

  /** Pids listening on the configured port, whoever started them. */
  private async listenerPids(): Promise<number[]> {
    for (const spec of listenOwnerCommands(this.settings.port, process.platform)) {
      const result = await execCapture(spec.command, spec.args, { timeoutMs: 10_000 });
      if (result.code !== 0 && !result.stdout.trim()) continue; // no such command
      return parseListenerPids(result.stdout, process.platform, this.settings.port);
    }
    return [];
  }

  private async readProcessCommand(pid: number): Promise<string | null> {
    const spec = processQueryCommand(pid, process.platform);
    const result = await execCapture(spec.command, spec.args, { timeoutMs: 10_000 });
    const command = parseProcessCommand(result.stdout, process.platform, pid);
    return command === "" ? null : command;
  }

  /** Poll until nothing listens on the port, so a restart cannot race itself. */
  private async waitForPortRelease(timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.listenerPids()).length === 0) return true;
      await delay(300);
    }
    return (await this.listenerPids()).length === 0;
  }

  /**
   * End the server on the configured port: the plugin's own process first, then
   * whatever else listens there -- a server started in another terminal or app.
   * A pid whose command line is not node/next is left alone and reported: that
   * port could belong to something else entirely.
   */
  async stopRunning(): Promise<boolean> {
    this.stopOwnProcess();
    const skipped: string[] = [];
    for (const pid of await this.listenerPids()) {
      const command = await this.readProcessCommand(pid);
      if (!isLikelyServerProcess(command, process.platform)) {
        skipped.push(`${pid}${command ? ` (${command})` : ""}`);
        continue;
      }
      const spec = killTreeCommand(pid, process.platform);
      await execCapture(spec.command, spec.args, { timeoutMs: 10_000 });
    }
    if (skipped.length) {
      new Notice(`未结束监听 ${this.settings.port} 端口的非 node 进程：${skipped.join("，")}`);
    }
    const released = await this.waitForPortRelease();
    if (released) {
      // Deliberately stopped: the next launch must not bring it back.
      this.settings.wasRunning = false;
      void this.saveSettings();
    }
    return released;
  }

  /**
   * The unload path. Obsidian quits before an awaited chain could finish, so
   * this blocks on the kills instead -- otherwise quitting the app would leave
   * the server running.
   */
  private stopRunningSync(): void {
    this.stopOwnProcess();
    for (const spec of listenOwnerCommands(this.settings.port, process.platform)) {
      const result = execCaptureSync(spec.command, spec.args);
      if (result.code !== 0 && !result.stdout.trim()) continue;
      const pids = parseListenerPids(result.stdout, process.platform, this.settings.port);
      for (const pid of pids) {
        const query = processQueryCommand(pid, process.platform);
        const command = parseProcessCommand(execCaptureSync(query.command, query.args).stdout, process.platform, pid);
        if (!isLikelyServerProcess(command || null, process.platform)) continue;
        const kill = killTreeCommand(pid, process.platform);
        execCaptureSync(kill.command, kill.args);
      }
      if (pids.length) break;
    }
  }

  /** Everything the settings page's server card shows. */
  async serverStatus(): Promise<ServerStatus> {
    const pids = await this.listenerPids();
    const listeners = await Promise.all(pids.map(async (pid) => ({ pid, command: await this.readProcessCommand(pid) })));
    return {
      running: await this.isServerUp(),
      starting: this.starting !== null,
      url: this.baseUrl(),
      port: this.settings.port,
      listeners,
      ours: this.proc !== null,
      modeLabel: this.modeLabel(),
    };
  }

  // --- npm ----------------------------------------------------------------

  private npmLookup(): { pathEnv: string | undefined; fileExists: (path: string) => boolean } {
    return { pathEnv: process.env.PATH, fileExists: existsSync };
  }

  /** Run npm without a shell when a Node.js install can be found, else through one. */
  private runNpm(args: string[], cwd: string): Promise<CapturedRun> {
    const runner = resolveNpmRunner(args, this.npmLookup());
    if (runner) return execCapture(runner.command, runner.args, { cwd, timeoutMs: 300_000 });
    return execCapture(npmShellCommand(args), [], { cwd, shell: true, timeoutMs: 300_000 });
  }

  private async globalInstalledVersion(): Promise<string | null> {
    const result = await this.runNpm(npmGlobalListArgs(PACKAGE_NAME), this.pluginFolder());
    return parseNpmGlobalVersion(result.stdout, PACKAGE_NAME);
  }

  /** Where global npm installs land (`npm prefix -g`), for the row's small line. */
  private async globalRootDir(): Promise<string | null> {
    const result = await this.runNpm(npmGlobalRootArgs(), this.pluginFolder());
    return parseNpmGlobalRoot(result.stdout);
  }

  /**
   * The installed package, wherever it is: the plugin folder's own install
   * wins (it is self-contained and dies with the plugin), then the global one.
   */
  async installedNpmPackage(): Promise<InstalledNpmPackage | null> {
    const pluginVersion = this.pluginInstalledVersion();
    if (pluginVersion) {
      return { scope: "plugin", version: pluginVersion, location: this.bundledInstallDir() };
    }
    const [globalVersion, globalRoot] = await Promise.all([this.globalInstalledVersion(), this.globalRootDir()]);
    if (!globalVersion) return null;
    return { scope: "global", version: globalVersion, location: globalRoot ?? "npm 全局目录" };
  }

  async npmLatestVersion(): Promise<string | null> {
    const result = await this.runNpm(npmViewVersionArgs(PACKAGE_NAME), this.pluginFolder());
    return parseNpmViewVersion(result.stdout);
  }

  /** What the package row renders: installed where, and is an update out. */
  async npmPackageInfo(): Promise<NpmPackageInfo> {
    const [installed, latest] = await Promise.all([this.installedNpmPackage(), this.npmLatestVersion()]);
    return {
      installed,
      latest,
      updateAvailable: Boolean(installed && latest && isNewerStableVersion(latest, installed.version)),
    };
  }

  /** Install into the scope the modal picked; no version pins the newest. */
  async installPackage(scope: NpmInstallScope): Promise<NpmActionResult> {
    const args = npmInstallArgs({ pkg: PACKAGE_NAME, scope, prefixDir: this.bundledInstallDir() });
    const result = await this.runNpm(args, this.pluginFolder());
    const installed = await this.installedNpmPackage();
    if (installed) {
      return { ok: true, message: `已安装 ${PACKAGE_NAME}@${installed.version}（${scope === "global" ? "全局" : "插件目录"}）。` };
    }
    const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
    return { ok: false, message: detail ? `安装失败：${detail}` : "安装失败。" };
  }

  /** Ends the install that is actually there, whichever scope that is. */
  async uninstallPackage(): Promise<NpmActionResult> {
    const installed = await this.installedNpmPackage();
    if (!installed) return { ok: false, message: `${PACKAGE_NAME} 未安装。` };
    const args = npmUninstallArgs({ pkg: PACKAGE_NAME, scope: installed.scope, prefixDir: this.bundledInstallDir() });
    await this.runNpm(args, this.pluginFolder());
    const left = await this.installedNpmPackage();
    return left
      ? { ok: false, message: `卸载后仍检测到 ${PACKAGE_NAME}@${left.version}。` }
      : { ok: true, message: `已卸载 ${PACKAGE_NAME}。` };
  }

  /** Updates in place: the scope of the install that is there now. */
  async updatePackage(): Promise<NpmActionResult> {
    const installed = await this.installedNpmPackage();
    if (!installed) return { ok: false, message: `${PACKAGE_NAME} 未安装。` };
    const latest = await this.npmLatestVersion();
    if (!latest) return { ok: false, message: "无法获取最新版本（npm 上可能尚未发布，或本机离线）。" };
    const args = npmInstallArgs({ pkg: PACKAGE_NAME, version: latest, scope: installed.scope, prefixDir: this.bundledInstallDir() });
    await this.runNpm(args, this.pluginFolder());
    const now = await this.installedNpmPackage();
    if (now && now.version === latest) return { ok: true, message: `已更新到 ${PACKAGE_NAME}@${latest}。` };
    if (now) return { ok: true, message: `${PACKAGE_NAME} 当前为 v${now.version}（最新 v${latest}）。` };
    return { ok: false, message: "更新失败。" };
  }

  /**
   * Open (or reveal) the single main view. It never waits for the server: the
   * view draws the offline hint itself, and starting is the settings pane's
   * 启动 button.
   */
  async openMain(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(MAIN_VIEW_TYPE)[0];
    if (existing) {
      await workspace.revealLeaf(existing);
      return;
    }
    const leaf = workspace.getLeaf("tab");
    await leaf.setViewState({ type: MAIN_VIEW_TYPE, active: true, state: {} });
    await workspace.revealLeaf(leaf);
  }

  /** One main view only: a restored workspace may come back holding several. */
  private dedupeMainViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(MAIN_VIEW_TYPE).slice(1)) leaf.detach();
  }

  /** The offline box both views show: no server, so say how to start one. */
  renderOfflineBox(container: HTMLElement, retry: () => void): void {
    const box = container.createDiv({ cls: "pi-obs-offline" });
    box.createEl("p", { text: `Pi Obs 服务未启动（端口 ${this.settings.port}）。` });
    box.createEl("p", { text: "请到「设置 → Pi Obs」点击「启动」。" });
    const settings = box.createEl("button", { text: "打开设置" });
    settings.addEventListener("click", () => this.openSettings());
    const again = box.createEl("button", { text: "重试" });
    again.addEventListener("click", retry);
  }

  /** Open this plugin's settings page, when Obsidian exposes the API. */
  openSettings(): void {
    const setting = (this.app as unknown as {
      setting?: { open: () => void; openTabById?: (id: string) => void };
    }).setting;
    if (!setting) return;
    setting.open();
    setting.openTabById?.(this.manifest.id);
  }

  private async openPanelTab(url: string): Promise<void> {
    const { workspace } = this.app;
    const target = toAbsoluteUrl(this.baseUrl(), url);
    // The header icon must exist before the view first draws it.
    await this.ensurePanelIcon(target);
    // A tab already showing this page is focused instead of duplicated.
    for (const leaf of workspace.getLeavesOfType(PANEL_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof PiObsPanelView && view.getState().url === target) {
        await workspace.revealLeaf(leaf);
        return;
      }
    }
    // The placement preference only decides where a *new* panel goes: an
    // already open one is revealed wherever it was opened.
    const leaf = this.settings.panelPlacement === "right-sidebar"
      ? workspace.getRightLeaf(false) ?? workspace.getLeaf("tab")
      : workspace.getLeaf("tab");
    await leaf.setViewState({ type: PANEL_VIEW_TYPE, active: true, state: { url: target } });
    await workspace.revealLeaf(leaf);
  }
}

/**
 * The plugin's single settings page: a live server-status card on top, the
 * npm package card under it, then the preferences. Detection runs when the
 * page opens and on the card's 刷新 button -- there is no polling.
 */
class PiObsSettingTab extends PluginSettingTab {
  private readonly plugin: PiObsPlugin;
  private statusEl: HTMLElement | null = null;
  private pkgEl: HTMLElement | null = null;
  /** An install / update / uninstall is running; the card shows a busy line. */
  private pkgBusy = false;

  constructor(app: unknown, plugin: PiObsPlugin) {
    super(app as never, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("pi-obs-settings");
    containerEl.createEl("h2", { text: "Pi Obs" });
    this.statusEl = containerEl.createDiv({ cls: "pi-obs-card" });
    this.pkgEl = containerEl.createDiv({ cls: "pi-obs-card" });
    containerEl.createDiv({ cls: "pi-obs-section-label", text: "偏好设置" });
    this.renderRunModeSetting(containerEl);
    this.renderPortSetting(containerEl);
    this.renderStopOnExitSetting(containerEl);
    this.renderPanelPlacementSetting(containerEl);
    void this.refreshStatus();
    void this.refreshPackage();
  }

  /** The 刷新 button re-detects both cards at once. */
  private refreshAll(): void {
    void this.refreshStatus();
    void this.refreshPackage();
  }

  // --- preferences ---------------------------------------------------------

  private renderRunModeSetting(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("运行模式")
      .setDesc("默认使用发布到 npm 的 pi-obs 包运行；「本地目录」是开发调试方式，固定以 npm run dev 启动。切换时会先停止正在运行的服务器。")
      .addDropdown((dropdown) => dropdown
        .addOption("npm", "npm 包（推荐）")
        .addOption("local", "本地目录（开发调试）")
        .setValue(this.plugin.settings.runMode)
        .onChange(async (value) => {
          const ok = await this.plugin.setRunMode(value === "local" ? "local" : "npm");
          if (!ok) {
            // The server survived, so the mode did not change: put the
            // dropdown back (the page is not rebuilt on a switch).
            dropdown.setValue(this.plugin.settings.runMode);
            new Notice("当前服务器未能停止，运行模式未切换。");
            return;
          }
          // A switch never redraws the page; only the status card re-detects.
          void this.refreshStatus();
        }));

    new Setting(containerEl)
      .setName("启动目录")
      .setDesc("本地模式使用：Pi Obs 源码检出目录，启动时在其中运行 npm run dev。")
      .addText((text) => {
        text.setPlaceholder("C:\\path\\to\\pi-obs")
          .setValue(this.plugin.settings.dir)
          .onChange(async (value) => {
            this.plugin.settings.dir = value;
            await this.plugin.saveSettings();
          });
      });
  }

  private renderPortSetting(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("端口")
      .setDesc("Pi Obs 监听的端口。改动后请先在上方停止旧端口上的服务，再重新启动。")
      .addText((text) => {
        text.setPlaceholder("30141")
          .setValue(String(this.plugin.settings.port))
          .onChange(async (value) => {
            const port = Number(value);
            if (Number.isInteger(port) && port > 0 && port < 65536) {
              this.plugin.settings.port = port;
              await this.plugin.saveSettings();
            }
          });
      });
  }

  private renderStopOnExitSetting(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("退出时停止服务器")
      .setDesc("关闭 Obsidian 或禁用本插件时，结束监听该端口的服务器（包括外部启动的）。关闭则只结束本插件启动的那个。")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.stopOnExit).onChange(async (value) => {
          this.plugin.settings.stopOnExit = value;
          await this.plugin.saveSettings();
        });
      });
  }

  private renderPanelPlacementSetting(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("面板位置")
      .setDesc("文件、终端、子代理或完整历史面板的打开位置：主区域的新标签页，或右侧边栏的标签页。")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("tab", "新标签页")
          .addOption("right-sidebar", "右侧边栏")
          .setValue(this.plugin.settings.panelPlacement)
          .onChange(async (value) => {
            this.plugin.settings.panelPlacement = value === "right-sidebar" ? "right-sidebar" : "tab";
            await this.plugin.saveSettings();
          });
      });
  }

  // --- the server status card ----------------------------------------------

  /**
   * Fill the status card: a head row (state dot + label + the buttons the
   * current state allows) and click-to-copy value rows. The buttons follow
   * the state -- running: 刷新 + 停止; starting: 刷新 + a disabled 启动中…;
   * stopped: 启动 alone.
   */
  private async refreshStatus(): Promise<void> {
    const el = this.statusEl;
    if (!el) return;
    el.empty();
    const pending = el.createDiv({ cls: "pi-obs-card-head" });
    pending.createDiv({ cls: "pi-obs-dot pi-obs-dot-starting" });
    pending.createDiv({ cls: "pi-obs-state", text: "正在检测…" });
    const status = await this.plugin.serverStatus();
    if (this.statusEl !== el) return; // the page was rebuilt while we waited
    el.empty();

    const head = el.createDiv({ cls: "pi-obs-card-head" });
    const state = status.running ? "running" : status.starting ? "starting" : "stopped";
    head.createDiv({ cls: `pi-obs-dot pi-obs-dot-${state}` });
    head.createDiv({
      cls: "pi-obs-state",
      text: status.running ? "服务器运行中" : status.starting ? "服务器启动中…" : "服务器未运行",
    });
    const actions = head.createDiv({ cls: "pi-obs-card-actions" });
    if (status.running || status.starting) {
      const refresh = actions.createEl("button", { text: "刷新" });
      refresh.setAttribute("title", "重新检测服务器状态与 npm 包");
      refresh.addEventListener("click", () => this.refreshAll());
    }
    if (status.running) {
      const stop = actions.createEl("button", { text: "停止", cls: "mod-warning" });
      stop.setAttribute("title", "结束监听该端口的服务器（只结束 node/next 进程，不误杀别的程序）");
      stop.addEventListener("click", async () => {
        stop.setAttribute("disabled", "true");
        const stopped = await this.plugin.stopRunning();
        new Notice(stopped ? "服务器已停止。" : `端口 ${this.plugin.settings.port} 仍被占用。`);
        await this.refreshStatus();
      });
    } else {
      const start = actions.createEl("button", {
        text: status.starting ? "启动中…" : "启动",
        cls: "mod-cta",
      });
      start.setAttribute("title", "按当前运行模式在后台启动服务器（最长等 5 分钟）");
      if (status.starting) start.setAttribute("disabled", "true");
      start.addEventListener("click", async () => {
        start.setAttribute("disabled", "true");
        start.setText("启动中…");
        const result = await this.plugin.startServerManually();
        new Notice(result.message);
        await this.refreshStatus();
      });
    }

    if (status.running) this.kvLine(el, "地址", status.url);
    this.kvLine(el, "端口", String(status.port));
    this.kvLine(el, "模式", status.modeLabel);
    if (status.listeners.length) {
      this.kvLine(
        el,
        "进程",
        `${status.listeners.map((listener) => listener.pid).join("，")}（${status.ours ? "本插件启动" : "外部进程"}）`,
        status.listeners.map((listener) => String(listener.pid)).join(" "),
      );
    }
  }

  /** A label + monospace value row; clicking the value copies it. */
  private kvLine(container: HTMLElement, label: string, value: string, copyValue = value): void {
    const row = container.createDiv({ cls: "pi-obs-kv" });
    row.createSpan({ cls: "pi-obs-kv-k", text: label });
    const v = row.createSpan({ cls: "pi-obs-kv-v", text: value });
    v.setAttribute("title", "点击复制");
    v.addEventListener("click", () => void copyText(copyValue));
  }

  // --- the npm package card --------------------------------------------------

  /**
   * Fill the package card: name + version (or 未安装) on the left, the
   * state-appropriate buttons on the right, and the install path as a small
   * click-to-copy note below.
   */
  private async refreshPackage(): Promise<void> {
    const el = this.pkgEl;
    if (!el) return;
    el.empty();
    const pending = el.createDiv({ cls: "pi-obs-card-head" });
    pending.createDiv({ cls: "pi-obs-state", text: PACKAGE_NAME });
    el.createDiv({ cls: "pi-obs-note", text: this.pkgBusy ? "正在操作 npm，请稍候…" : "正在检测…" });
    if (this.pkgBusy) return;
    const info = await this.plugin.npmPackageInfo();
    if (this.pkgEl !== el) return; // the page was rebuilt while we waited
    el.empty();

    const installed = info.installed;
    const head = el.createDiv({ cls: "pi-obs-card-head" });
    head.createDiv({ cls: "pi-obs-state", text: PACKAGE_NAME });
    head.createSpan({
      cls: "pi-obs-version",
      text: installed
        ? info.updateAvailable ? `v${installed.version} → v${info.latest}` : `v${installed.version}`
        : "未安装",
    });
    const actions = head.createDiv({ cls: "pi-obs-card-actions" });
    if (!installed) {
      const install = actions.createEl("button", { text: "安装", cls: "mod-cta" });
      install.addEventListener("click", () => {
        new InstallScopeModal(this.app, (scope) => void this.runPackageAction(() => this.plugin.installPackage(scope))).open();
      });
    } else {
      if (info.updateAvailable) {
        const update = actions.createEl("button", { text: "更新", cls: "mod-cta" });
        update.addEventListener("click", () => void this.runPackageAction(() => this.plugin.updatePackage()));
      }
      const uninstall = actions.createEl("button", { text: "卸载", cls: "mod-warning" });
      uninstall.addEventListener("click", () => void this.runPackageAction(() => this.plugin.uninstallPackage()));
    }

    const note = el.createDiv({
      cls: installed ? "pi-obs-note pi-obs-copy" : "pi-obs-note",
      text: installed ? installed.location : "点击「安装」选择安装位置（全局，或插件目录）",
    });
    if (installed) {
      // The install path copies like the status card's values do.
      note.setAttribute("title", "点击复制");
      const location = installed.location;
      note.addEventListener("click", () => void copyText(location));
    }
  }

  private async runPackageAction(action: () => Promise<NpmActionResult>): Promise<void> {
    if (this.pkgBusy) return;
    this.pkgBusy = true;
    void this.refreshPackage(); // redraw as busy
    try {
      const result = await action();
      new Notice(result.message);
    } finally {
      this.pkgBusy = false;
    }
    this.refreshAll();
  }
}

/** Asks where an install should land: inside the plugin folder, or globally. */
class InstallScopeModal extends Modal {
  private readonly onPick: (scope: NpmInstallScope) => void;

  constructor(app: unknown, onPick: (scope: NpmInstallScope) => void) {
    super(app as never);
    this.onPick = onPick;
  }

  onOpen(): void {
    this.titleEl.setText(`安装 ${PACKAGE_NAME}`);
    this.contentEl.empty();
    const options: { scope: NpmInstallScope; name: string; desc: string }[] = [
      { scope: "plugin", name: "插件目录", desc: "安装到本插件自己的目录（删除插件时一并删除）。" },
      { scope: "global", name: "全局", desc: "安装到系统的 npm 全局目录，所有项目共用。" },
    ];
    for (const option of options) {
      const row = this.contentEl.createDiv({ cls: "pi-obs-install-option" });
      row.createDiv({ cls: "pi-obs-install-name", text: option.name });
      row.createDiv({ cls: "pi-obs-install-desc", text: option.desc });
      row.addEventListener("click", () => {
        this.close();
        this.onPick(option.scope);
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
