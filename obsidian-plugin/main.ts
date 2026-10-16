import { Plugin, type WorkspaceLeaf } from "obsidian";
import { installPlatformFetch } from "./platform-fetch";
import { installApiLayer } from "./api-dispatch";
import { installBundledSdkInternals } from "./services/sdk-internals";
import { MAIN_VIEW_TYPE, PiObsMainView } from "./views/main-view";

/**
 * Pi Obs —— 原生 Obsidian 插件。
 *
 * 没有服务器进程、没有 iframe、没有 HTTP 端口：pi 引擎与 65 个 API 路由
 * 全部跑在本进程内，界面通过接入层（api-dispatch.ts）调用它们。
 *
 * 服务器生命周期管理（原来的 npm 安装、端口探测、进程启停）已整块删除；
 * 旧实现见 git 历史里的 `obsidian-plugin/main.ts`。
 */
export default class PiObsPlugin extends Plugin {
  private disposers: Array<() => void> = [];

  async onload(): Promise<void> {
    // 顺序有要求：先把网络层换成 node:http 实现，接入层再包在外面，
    // 这样非 /api/ 的请求最终落到 shim，而不是 Chromium 的网络栈。
    this.disposers.push(installPlatformFetch());
    this.disposers.push(installApiLayer());

    // MCP 的 SDK 内部模块：换成已打进 bundle 的那一份。
    // 只是注册一个惰性加载器，但必须早于任何 loadPiSdkInternals() 调用（结果会缓存）。
    installBundledSdkInternals();

    this.registerView(MAIN_VIEW_TYPE, (leaf: WorkspaceLeaf) => new PiObsMainView(leaf));

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

    // 恢复的工作区可能带回多个主视图，只留一个。
    this.app.workspace.onLayoutReady(() => this.dedupeMainViews());
  }

  onunload(): void {
    // 逆序拆：先摘接入层，再恢复原来的 fetch。
    for (const dispose of this.disposers.reverse()) {
      try {
        dispose();
      } catch (error) {
        console.warn("[pi-obs] teardown failed", error);
      }
    }
    this.disposers = [];
  }

  /** 打开（或聚焦）唯一的主视图。 */
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

  /** 一个主视图就够：恢复的工作区可能带回好几个。 */
  private dedupeMainViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(MAIN_VIEW_TYPE).slice(1)) leaf.detach();
  }
}
