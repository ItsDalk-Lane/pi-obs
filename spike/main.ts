// Pi Obs Spike —— 第四轮：React 在 Obsidian 渲染进程里的行为专项诊断
//
// 背景：第三轮里 React 能挂载渲染，但点击按钮后状态不更新；原生 addEventListener 却能被触发。
// 说明 DOM 事件派发正常，是 React 侧的某一环断了。整个界面（约 39k 行）都依赖 React，必须查清。
//
// 本轮对两种挂载方式各测四条更新路径：
//   A. queueMicrotask 里 setState（测 React 更新通道）
//   B. setTimeout 里 setState（测异步调度）
//   C. 原生 addEventListener 里 setState（绕过 React 事件委托）
//   D. React onClick（测 React 事件委托本身）
// 挂载方式对比：直接挂 .view-content  vs  挂一个新建的子 div
import { ItemView, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { writeFileSync } from "fs";
import { join } from "path";
import React, { useState } from "react";
import { createRoot, Root } from "react-dom/client";

const FALLBACK_REPORT_DIR = "C:/Users/Its_D/Desktop/0/.obsidian/plugins/pi-obs-spike";
export const VIEW_A = "pi-obs-spike-react-a";
export const VIEW_B = "pi-obs-spike-react-b";

interface Report {
  timestamp: string;
  globals: Record<string, unknown>;
  mountOnViewContent: Record<string, unknown>;
  mountOnChildDiv: Record<string, unknown>;
  verdict: Record<string, string>;
}

function snippet(value: unknown, max = 300): string {
  try { return (typeof value === "string" ? value : JSON.stringify(value) ?? "").slice(0, max); } catch { return String(value).slice(0, max); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeProbeApp() {
  return function ProbeApp() {
    const [log, setLog] = useState<string[]>([]);
    const add = React.useCallback((tag: string) => { setLog((prev) => [...prev, tag]); }, []);

    React.useEffect(() => {
      queueMicrotask(() => add("microtask"));
      setTimeout(() => add("timer"), 250);
    }, [add]);

    React.useEffect(() => {
      const el = document.getElementById("spike-native-btn");
      if (el) el.addEventListener("click", () => add("native-listener"));
    }, [add]);

    return React.createElement(
      "div",
      null,
      React.createElement("button", { id: "spike-native-btn", onClick: () => add("react-onclick") }, "probe"),
      React.createElement("div", { id: "spike-log" }, `LOG:${log.join("|")}`),
    );
  };
}

abstract class BaseProbeView extends ItemView {
  root: Root | null = null;
  constructor(leaf: WorkspaceLeaf) { super(leaf); }

  protected mountInto(el: HTMLElement): void {
    this.root = createRoot(el);
    this.root.render(React.createElement(makeProbeApp()));
  }

  async onClose(): Promise<void> { this.root?.unmount(); this.root = null; }

  logText(): string {
    const el = this.containerEl.querySelector("#spike-log");
    return el ? (el.textContent ?? "") : "(#spike-log 不存在)";
  }
  button(): HTMLElement | null {
    return this.containerEl.querySelector("#spike-native-btn") as HTMLElement | null;
  }
}

class ViewA extends BaseProbeView {
  static last: ViewA | null = null;
  constructor(leaf: WorkspaceLeaf) { super(leaf); ViewA.last = this; }
  getViewType(): string { return VIEW_A; }
  getDisplayText(): string { return "Spike React A"; }
  async onOpen(): Promise<void> { this.mountInto(this.containerEl.children[1] as HTMLElement); }
}

class ViewB extends BaseProbeView {
  static last: ViewB | null = null;
  constructor(leaf: WorkspaceLeaf) { super(leaf); ViewB.last = this; }
  getViewType(): string { return VIEW_B; }
  getDisplayText(): string { return "Spike React B"; }
  async onOpen(): Promise<void> {
    const host = document.createElement("div");
    host.className = "spike-react-host";
    (this.containerEl.children[1] as HTMLElement).appendChild(host);
    this.mountInto(host);
  }
}

async function runProbe(plugin: Plugin, viewType: string, grab: () => BaseProbeView | null): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  try {
    plugin.registerView(viewType, (leaf) => (viewType === VIEW_A ? new ViewA(leaf) : new ViewB(leaf)));
    const leaf = plugin.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: viewType, active: true });
    await wait(900); // 等 microtask + timer 两条异步更新

    const view = grab();
    if (!view) { out.error = "视图实例未创建"; return out; }
    out.afterAsync = snippet(view.logText());
    out.microtaskWorked = (out.afterAsync as string).includes("microtask");
    out.timerWorked = (out.afterAsync as string).includes("timer");

    const button = view.button();
    out.buttonFound = Boolean(button);
    out.buttonConnected = Boolean(button && button.isConnected);
    if (button) {
      button.click();
      await wait(600);
      out.afterClick = snippet(view.logText());
      out.nativeListenerWorked = (out.afterClick as string).includes("native-listener");
      out.reactOnClickWorked = (out.afterClick as string).includes("react-onclick");
    }
    leaf.detach();
  } catch (error) {
    out.error = snippet(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }
  return out;
}

export default class PiObsSpikePlugin extends Plugin {
  async onload(): Promise<void> {
    this.addRibbonIcon("flask-conical", "Pi Obs Spike: React 诊断", () => { void this.run(); });
    this.addCommand({
      id: "run-all-tests",
      name: "Pi Obs Spike: 运行第二轮验证（写入 spike-report.json）",
      callback: () => { void this.run(); },
    });
    new Notice("Pi Obs Spike 已加载。Ctrl+P 运行「Pi Obs Spike: 运行第二轮验证」");
  }

  private reportDir(): string {
    try {
      const anyThis = this as unknown as { app: { vault: { adapter: { getBasePath?: () => string } } }; manifest: { dir?: string } };
      const base = anyThis.app.vault.adapter.getBasePath?.();
      if (typeof base === "string" && this.manifest.dir) return join(base, this.manifest.dir);
    } catch { /* 退回固定路径 */ }
    return FALLBACK_REPORT_DIR;
  }

  private async run(): Promise<void> {
    const report: Report = {
      timestamp: new Date().toISOString(),
      globals: {
        reactVersion: React.version,
        hasDocument: typeof document !== "undefined",
        hasWindow: typeof window !== "undefined",
        messageChannel: typeof (globalThis as unknown as { MessageChannel?: unknown }).MessageChannel,
        setTimeoutHasUnref: typeof (setTimeout(() => { /* noop */ }, 1) as unknown as { unref?: unknown }).unref,
      },
      mountOnViewContent: {},
      mountOnChildDiv: {},
      verdict: {},
    };

    new Notice("Spike：测试挂载到 .view-content …");
    report.mountOnViewContent = await runProbe(this, VIEW_A, () => ViewA.last);
    new Notice("Spike：测试挂载到新建子 div …");
    report.mountOnChildDiv = await runProbe(this, VIEW_B, () => ViewB.last);

    const pick = report.mountOnViewContent.reactOnClickWorked === true ? report.mountOnViewContent : report.mountOnChildDiv;
    report.verdict = {
      reactMount: report.mountOnViewContent.afterAsync ? "渲染正常" : "渲染失败",
      asyncUpdate: pick.timerWorked === true ? "异步 setState 可用" : "异步 setState 不可用（更新通道断）",
      eventDelegation: pick.reactOnClickWorked === true ? "React 事件委托可用" : "React 事件委托不可用",
      nativePath: pick.nativeListenerWorked === true ? "原生事件 + setState 可用" : "原生事件路径也不可用",
      recommendation: report.mountOnChildDiv.reactOnClickWorked === true && report.mountOnViewContent.reactOnClickWorked !== true
        ? "改挂载到新建子 div"
        : (pick.reactOnClickWorked === true ? "React 可直接使用" : "需要进一步排查（见各项明细）"),
    };

    const path = join(this.reportDir(), "spike-report.json");
    try {
      writeFileSync(path, JSON.stringify(report, null, 2), "utf8");
      new Notice(`React 诊断完成，报告已写入 ${path}`);
    } catch (error) {
      new Notice(`写盘失败：${snippet(error, 150)}，请打开控制台（Ctrl+Shift+I）`);
    }
    console.log("[pi-obs-spike] 第四轮：", JSON.stringify(report, null, 2));
  }
}
