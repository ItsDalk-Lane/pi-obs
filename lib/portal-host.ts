/**
 * 弹层的挂载点。
 *
 * Web 版挂在 `document.body` 上；插件版必须挂在界面宿主内部 —— 插件的样式全部
 * 作用域化到 `.pi-obs-host` 之下（见 obsidian-plugin/scripts/scope-to-host.mjs），
 * 挂在 body 上的弹层会完全丢失样式。
 *
 * 宿主在挂载时用 `setPortalHost()` 指定容器，卸载时置回 null，Web 版不受影响。
 * 本文件必须保持纯数据与函数：插件会把它打进 bundle（无 JSX、无 React）。
 */

let portalHost: HTMLElement | null = null;

/** 由宿主（插件视图）调用；传 null 表示回到默认的 document.body。 */
export function setPortalHost(element: HTMLElement | null): void {
  portalHost = element;
}

/**
 * 弹层的实际容器。调用点都在客户端（弹层只在用户交互后出现），
 * 所以这里可以直接回落到 document.body。
 */
export function getPortalHost(): HTMLElement {
  if (portalHost) return portalHost;
  return document.body;
}
