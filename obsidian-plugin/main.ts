import { existsSync } from "fs";
import { join } from "path";
import { ChildProcess, spawn } from "child_process";
import { addIcon, FileSystemAdapter, ItemView, Notice, Plugin, PluginSettingTab, removeIcon, requestUrl, Setting, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { CATPPUCCIN_ICONS_ROOT, catppuccinIconFor } from "../lib/file-icon-names";

const MAIN_VIEW_TYPE = "pi-web-main";
const PANEL_VIEW_TYPE = "pi-web-panel";

/** Directory inside the plugin folder holding the plugin's own npm install. */
const BUNDLED_DIR_NAME = "pi-web-app";

interface PiWebSettings {
  /** Port Pi Web listens on. */
  port: number;
  /**
   * Pi Web checkout directory; the start command runs there (dev mode).
   * Empty = the plugin's own npm install of `packageName` (production mode).
   */
  dir: string;
  /** Command that starts Pi Web, run with the shell in `dir`. */
  startCommand: string;
  /** npm package installed into the plugin folder when `dir` is empty. */
  packageName: string;
  /** Start Pi Web when a view opens and the server is not up yet. */
  autoStart: boolean;
  /** Where a panel page (files, terminals, subagents, full history) opens. */
  panelPlacement: PanelPlacement;
}

/** New tab in the main area, or a tab of the right sidebar's dock. */
type PanelPlacement = "tab" | "right-sidebar";

const DEFAULT_SETTINGS: PiWebSettings = {
  port: 30141,
  dir: "",
  startCommand: "npm run dev",
  packageName: "pi-obs",
  autoStart: true,
  panelPlacement: "tab",
};

/** Human tab title for a /panel/* URL, before the iframe's own title could be used. */
function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url, "http://localhost");
    const path = parsed.pathname;
    if (path === "/panel/terminal") {
      const cwd = parsed.searchParams.get("cwd") ?? "";
      return `Terminal — ${cwd.split(/[\\/]/).pop() || cwd}`;
    }
    if (path === "/panel/file") {
      return panelFileName(parsed) || "File";
    }
    if (path === "/panel/agent") {
      return parsed.searchParams.get("label") || "Subagent";
    }
    if (path === "/panel/history") {
      return "Full history";
    }
    return "Pi Web";
  } catch {
    return "Pi Web";
  }
}

/** The file name inside a /panel/file URL's `path` parameter. */
function panelFileName(parsed: URL): string {
  const path = parsed.searchParams.get("path") ?? "";
  return path.split(/[\\/]/).pop() ?? "";
}

/** Custom icon ids the plugin registers: Obsidian's own set carries no
    language icons, so a file panel borrows the icon the web UI's tab shows. */
const PANEL_ICON_PREFIX = "pi-web-cat-";

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

class PiWebMainView extends ItemView {
  private readonly plugin: PiWebPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: PiWebPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return MAIN_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Pi Web";
  }

  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    await this.renderFrame();
  }

  /** The iframe is only created once the server answers: a view mounted
      while Pi Web is down (a workspace restore during a restart) must come
      back with a retry button, never a dead blank frame. */
  private async renderFrame(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("pi-web-embed");
    this.contentEl.createEl("p", { cls: "pi-web-connecting", text: "连接 Pi Web… Connecting…" });
    const up = await this.plugin.ensureServer();
    this.contentEl.empty();
    if (!up) {
      const box = this.contentEl.createDiv({ cls: "pi-web-offline" });
      box.createEl("p", { text: `Pi Web is not reachable on port ${this.plugin.settings.port}.` });
      box.createEl("p", { text: `Pi Web 未连接（端口 ${this.plugin.settings.port}），请确认服务已启动后重试。` });
      const retry = box.createEl("button", { text: "重试 Retry" });
      retry.addEventListener("click", () => { void this.renderFrame(); });
      return;
    }
    const iframe = this.contentEl.createEl("iframe");
    iframe.src = `${this.plugin.baseUrl()}/?embed=1`;
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }
}

class PiWebPanelView extends ItemView {
  private readonly plugin: PiWebPlugin;
  private url = "";
  private title = "Pi Web";

  constructor(leaf: WorkspaceLeaf, plugin: PiWebPlugin) {
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
    this.contentEl.addClass("pi-web-embed");
    const iframe = this.contentEl.createEl("iframe");
    iframe.src = absolute;
  }

  async onOpen(): Promise<void> {
    if (!this.url) {
      // Restored without state (e.g. a manual addViewCall): nothing to show.
      this.contentEl.setText("Pi Web panel");
      return;
    }
    await this.renderFrame();
  }

  /** Same contract as the main view: no iframe before the server answers. */
  private async renderFrame(): Promise<void> {
    if (!this.url) return;
    this.contentEl.empty();
    this.contentEl.addClass("pi-web-embed");
    this.contentEl.createEl("p", { cls: "pi-web-connecting", text: "连接 Pi Web… Connecting…" });
    const up = await this.plugin.ensureServer();
    this.contentEl.empty();
    if (!up) {
      const box = this.contentEl.createDiv({ cls: "pi-web-offline" });
      box.createEl("p", { text: `Pi Web is not reachable on port ${this.plugin.settings.port}.` });
      box.createEl("p", { text: `Pi Web 未连接（端口 ${this.plugin.settings.port}），请确认服务已启动后重试。` });
      const retry = box.createEl("button", { text: "重试 Retry" });
      retry.addEventListener("click", () => { void this.renderFrame(); });
      return;
    }
    const iframe = this.contentEl.createEl("iframe");
    iframe.src = this.url;
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }
}

export default class PiWebPlugin extends Plugin {
  settings: PiWebSettings = DEFAULT_SETTINGS;
  private proc: ChildProcess | null = null;
  private starting: Promise<boolean> | null = null;
  private installing: Promise<boolean> | null = null;
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
      come from the running Pi Web server, so the two are the same artwork. */
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
      if (!(view instanceof PiWebPanelView)) continue;
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

    this.registerView(MAIN_VIEW_TYPE, (leaf) => new PiWebMainView(leaf, this));
    this.registerView(PANEL_VIEW_TYPE, (leaf) => new PiWebPanelView(leaf, this));

    this.addRibbonIcon("bot", "Open Pi Web", () => {
      void this.openMain();
    });

    this.addCommand({
      id: "open-pi-web",
      name: "Open Pi Web",
      callback: () => {
        void this.openMain();
      },
    });

    // Bundled install: without a Pi Web directory the plugin installs the
    // package into its own folder at enable time, so the first open is fast
    // and deleting the plugin folder removes Pi Web with it.
    if (!this.settings.dir.trim()) {
      void this.ensureBundledInstall();
    }

    // Panels of the embedded UI (files, terminals, subagents) ask the host to
    // show their standalone /panel page; each becomes a tab of its own.
    this.registerDomEvent(window, "message", (event: MessageEvent) => {
      const data = event.data as { source?: string; type?: string; url?: string } | null;
      if (event.origin !== this.baseUrl()) return;
      if (data?.source !== "pi-web" || data?.type !== "open-panel" || typeof data.url !== "string") return;
      void this.openPanelTab(data.url);
    });

    this.addSettingTab(new PiWebSettingTab(this.app, this));

    // A panel restored with the workspace drew its header before its icon was
    // registered; redo those headers once the layout is up.
    this.app.workspace.onLayoutReady(() => { void this.refreshPanelIcons(); });
  }

  onunload(): void {
    this.stopServer();
    for (const id of this.registeredIcons) removeIcon(id);
    this.registeredIcons.clear();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (this.settings.panelPlacement !== "right-sidebar") this.settings.panelPlacement = "tab";
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private isServerUp(): Promise<boolean> {
    return requestUrl({ url: `${this.baseUrl()}/`, method: "GET", throw: false })
      .then((res) => res.status >= 200 && res.status < 500)
      .catch(() => false);
  }

  /** Make sure the server is reachable, spawning it first when allowed. */
  async ensureServer(): Promise<boolean> {
    if (await this.isServerUp()) return true;
    if (!this.settings.autoStart) return false;
    this.starting ??= this.settings.dir.trim() ? this.startAndAwait() : this.startBundledAndAwait();
    const up = await this.starting;
    this.starting = null;
    return up;
  }

  private async startAndAwait(): Promise<boolean> {
    this.startServer();
    // A fresh `next dev` answers within seconds; keep a generous ceiling anyway.
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (await this.isServerUp()) return true;
      if (!this.proc) return false; // exited while we waited
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  }

  private async startBundledAndAwait(): Promise<boolean> {
    const installed = await this.ensureBundledInstall();
    if (!installed) return false;
    this.startServer();
    // The first install pulls next and node-pty; allow it far more time.
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      if (await this.isServerUp()) return true;
      if (!this.proc) return false; // exited while we waited
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  }

  private startServer(): void {
    if (this.proc) return;
    const dirSetting = this.settings.dir.trim();
    const proc = dirSetting
      ? spawn(this.settings.startCommand, [], { cwd: dirSetting, shell: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
      : spawn("node", [this.bundledBinPath(), "-p", String(this.settings.port), "--no-open"], {
          cwd: this.bundledInstallDir(),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
    this.proc = proc;
    proc.stdout?.on("data", (chunk: Buffer) => {
      console.log("[pi-web]", chunk.toString().trimEnd());
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      console.warn("[pi-web]", chunk.toString().trimEnd());
    });
    proc.on("exit", (code) => {
      if (this.proc === proc) this.proc = null;
      console.log(`[pi-web] server exited with code ${code}`);
    });
  }

  private stopServer(): void {
    const proc = this.proc;
    if (!proc || proc.pid === undefined) {
      this.proc = null;
      return;
    }
    this.proc = null;
    // A shell-wrapped start (`shell: true`) has children that must die with it.
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true });
    } else {
      proc.kill();
    }
  }

  /** Absolute path of the plugin's own Pi Web install, inside the plugin folder. */
  private bundledInstallDir(): string {
    const adapter = this.app.vault.adapter as FileSystemAdapter;
    return join(adapter.getBasePath(), this.manifest.dir ?? "", BUNDLED_DIR_NAME);
  }

  private bundledPackageDir(): string {
    const pkg = this.settings.packageName.trim();
    const parts = pkg.startsWith("@") ? pkg.split("/") : [pkg];
    return join(this.bundledInstallDir(), "node_modules", ...parts);
  }

  private bundledBinPath(): string {
    return join(this.bundledPackageDir(), "bin", "pi-web.js");
  }

  private isBundledInstalled(): boolean {
    return existsSync(join(this.bundledPackageDir(), "package.json"));
  }

  /** Install the npm package into the plugin folder once; reused afterwards. */
  private async ensureBundledInstall(): Promise<boolean> {
    if (this.isBundledInstalled()) return Promise.resolve(true);
    this.installing ??= this.runBundledInstall();
    const installed = await this.installing;
    this.installing = null;
    return installed;
  }

  private runBundledInstall(): Promise<boolean> {
    return new Promise((resolve) => {
      const dir = this.bundledInstallDir();
      const pkg = this.settings.packageName.trim();
      console.log(`[pi-web] installing ${pkg} into ${dir}`);
      const npm = spawn(`npm install "${pkg}" --prefix "${dir}"`, [], {
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      npm.stdout?.on("data", (chunk: Buffer) => {
        console.log("[pi-web]", chunk.toString().trimEnd());
      });
      npm.stderr?.on("data", (chunk: Buffer) => {
        console.warn("[pi-web]", chunk.toString().trimEnd());
      });
      npm.on("error", (error) => {
        console.error("[pi-web] install failed:", error);
        resolve(false);
      });
      npm.on("exit", (code) => {
        if (code !== 0) console.error(`[pi-web] install exited with code ${code}`);
        resolve(code === 0 && this.isBundledInstalled());
      });
    });
  }

  async openMain(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(MAIN_VIEW_TYPE)[0];
    if (existing) {
      await workspace.revealLeaf(existing);
      return;
    }
    const up = await this.ensureServer();
    if (!up) {
      new Notice(
        this.settings.dir.trim()
          ? `Pi Web is not reachable and did not start (check the start command and port ${this.settings.port}).`
          : `Pi Web could not be installed or started (check Node/npm in PATH and the package name; port ${this.settings.port}).`,
      );
      return;
    }
    const leaf = workspace.getLeaf("tab");
    await leaf.setViewState({ type: MAIN_VIEW_TYPE, active: true, state: {} });
    await workspace.revealLeaf(leaf);
  }

  private async openPanelTab(url: string): Promise<void> {
    const { workspace } = this.app;
    const target = toAbsoluteUrl(this.baseUrl(), url);
    // The header icon must exist before the view first draws it.
    await this.ensurePanelIcon(target);
    // A tab already showing this page is focused instead of duplicated.
    for (const leaf of workspace.getLeavesOfType(PANEL_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof PiWebPanelView && view.getState().url === target) {
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

class PiWebSettingTab extends PluginSettingTab {
  private readonly plugin: PiWebPlugin;

  constructor(app: unknown, plugin: PiWebPlugin) {
    super(app as never, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Pi Web" });

    new Setting(containerEl)
      .setName("Pi Web directory")
      .setDesc("Pi Web checkout directory (the start command runs there, e.g. npm run dev). Leave empty to use the plugin's own npm install of the package below.")
      .addText((text) => {
        text.setPlaceholder("C:\\path\\to\\pi-web")
          .setValue(this.plugin.settings.dir)
          .onChange(async (value) => {
            this.plugin.settings.dir = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Start command")
      .setDesc("Command that starts Pi Web, run with the shell in the directory above. Only used when a directory is set.")
      .addText((text) => {
        text.setPlaceholder("npm run dev")
          .setValue(this.plugin.settings.startCommand)
          .onChange(async (value) => {
            this.plugin.settings.startCommand = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Pi Web package")
      .setDesc("npm package installed into the plugin folder and started with node. Only used when no directory is set.")
      .addText((text) => {
        text.setPlaceholder("pi-obs")
          .setValue(this.plugin.settings.packageName)
          .onChange(async (value) => {
            this.plugin.settings.packageName = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Port")
      .setDesc("Port Pi Web listens on.")
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

    new Setting(containerEl)
      .setName("Start Pi Web automatically")
      .setDesc("Install (once) and spawn Pi Web when a Pi Web view opens and the server is not up yet.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.autoStart).onChange(async (value) => {
          this.plugin.settings.autoStart = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Panel placement")
      .setDesc("Where a file, terminal, subagent or full-history panel opens: a tab of the main area, or a tab of the right sidebar.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("tab", "New tab")
          .addOption("right-sidebar", "Right sidebar")
          .setValue(this.plugin.settings.panelPlacement)
          .onChange(async (value) => {
            this.plugin.settings.panelPlacement = value === "right-sidebar" ? "right-sidebar" : "tab";
            await this.plugin.saveSettings();
          });
      });
  }
}
