import { ItemView, type WorkspaceLeaf } from "obsidian";
import { createRoot, type Root } from "react-dom/client";
import { AppShell } from "../../components/AppShell";
import { I18nProvider } from "../../hooks/useI18n";
import { setPortalHost } from "../../lib/portal-host";

export const MAIN_VIEW_TYPE = "pi-obs-main";

/**
 * 主视图：把现有的 React 界面整块挂进 Obsidian 标签页。
 *
 * 界面的数据来源全部走 `fetch("/api/...")`，由接入层（api-dispatch.ts）接管，
 * 所以这里只负责挂载，不改任何组件逻辑。
 *
 * 宿主结构：
 *   .pi-obs-host      ← 样式作用域根，整套界面 CSS 都限定在它之下
 *     .pi-obs-mount   ← React 根
 *     .pi-obs-portal  ← createPortal 的容器（见 lib/portal-host.ts）
 */
export class PiObsMainView extends ItemView {
  private root: Root | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
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
    this.contentEl.empty();

    const host = this.contentEl.createDiv({ cls: "pi-obs-host" });

    // 弹层容器必须是宿主的后代：界面样式全部作用域化在 .pi-obs-host 之下，
    // 挂在 document.body 上的弹层会完全没有样式。
    setPortalHost(host.createDiv({ cls: "pi-obs-portal" }));

    // useViewportHeight 把 --app-viewport-height 设成 window.innerHeight ——
    // 那是整个 Obsidian 窗口的高度，不是这个标签页的高度；界面的根元素恰恰用它当高度
    // （height: var(--app-viewport-height, 100dvh)），所以必须回写成宿主的真实高度。
    //
    // 关键：**布局还没发生时 clientHeight 是 0，绝不能把 0 写进去** —— 那会让界面根元素
    // 高度归零、整棵树塌到顶上（输入框跑到最上面就是这个原因）。等 ResizeObserver 报出真实尺寸即可，
    // 它在元素拿到布局后一定会回调，尺寸变化时也会再报。
    let lastHeight = 0;
    const syncViewportHeight = () => {
      if (!host.isConnected) return;
      const height = host.clientHeight;
      if (height <= 0 || height === lastHeight) return;
      lastHeight = height;
      host.style.setProperty("--app-viewport-height", `${height}px`);
    };
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(syncViewportHeight);
      this.resizeObserver.observe(host);
    }
    // ResizeObserver 之外再补一帧：视图可能是先建后挂的，挂上那一刻才会被量到。
    window.requestAnimationFrame(syncViewportHeight);

    this.root = createRoot(host.createDiv({ cls: "pi-obs-mount" }));
    this.root.render(
      <I18nProvider>
        <AppShell />
      </I18nProvider>,
    );
  }

  async onClose(): Promise<void> {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    setPortalHost(null);
    this.root?.unmount();
    this.root = null;
    this.contentEl.empty();
  }
}
