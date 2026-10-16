"use client";

// 平台适配层 · 导航：`next/navigation` 的两处用法的替身。
//
// AppShell 只用到 `useRouter().replace()`（同步地址栏查询串）和 `useSearchParams()`
// （首屏导航 + embed 标记）。插件里没有 Next 路由，所以这里用 Obsidian 文档自身的
// URL 查询串顶上：真实地址栏能写就写，写不了（自定义协议可能拒绝）就退回模块内存值。
//
// 绑定方式是构建期别名，不是改源码：esbuild.config.mjs 把 `next/navigation`
// 指到本文件，Web 版（Next/Turbopack）不受影响，仍走真正的 next/navigation。

import { useMemo, useSyncExternalStore } from "react";

type NavigateOptions = { scroll?: boolean };
type NavigateTarget = string;

const listeners = new Set<() => void>();

/** 真实地址栏写不进去时的兜底值（null 表示以地址栏为准）。 */
let fallbackSearch: string | null = null;

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function readSearch(): string {
  if (typeof window === "undefined") return "";
  if (fallbackSearch !== null) return fallbackSearch;
  return window.location.search;
}

function writeSearch(next: string): void {
  if (typeof window === "undefined") {
    fallbackSearch = next;
    emit();
    return;
  }
  try {
    const { pathname, hash } = window.location;
    window.history.replaceState(window.history.state, "", `${pathname}${next}${hash}`);
    fallbackSearch = null;
  } catch {
    // 自定义协议下 replaceState 可能被拒；内存值仍能驱动 useSearchParams。
    fallbackSearch = next;
  }
  emit();
}

/** 把一个 `"?session=x"` 形式的目标并进当前地址，只保留查询串与 fragment。 */
function navigate(target: NavigateTarget): void {
  let resolved: URL;
  try {
    resolved = new URL(target, window.location.href);
  } catch {
    return;
  }
  if (resolved.pathname !== window.location.pathname && !target.startsWith("?")) {
    // 插件里没有页面路由可切；把路径变化降级成查询串变化，避免整页跳走。
    console.warn(`[pi-obs] ignores path navigation to ${target}`);
  }
  writeSearch(`${resolved.search}${resolved.hash}`);
}

/** 稳定引用：AppShell 把它放进 useCallback 依赖数组，每次新建会导致回调失效。 */
const router = {
  push: (target: NavigateTarget, _options?: NavigateOptions) => navigate(target),
  replace: (target: NavigateTarget, _options?: NavigateOptions) => navigate(target),
  back: () => window.history.back(),
  forward: () => window.history.forward(),
  refresh: () => { /* 没有服务端渲染，无需刷新 */ },
  prefetch: () => { /* 没有路由预取 */ },
};

export function useRouter(): typeof router {
  return router;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getServerSnapshot(): string {
  return "";
}

export function useSearchParams(): URLSearchParams {
  const search = useSyncExternalStore(subscribe, readSearch, getServerSnapshot);
  return useMemo(() => new URLSearchParams(search), [search]);
}

export function usePathname(): string {
  return typeof window === "undefined" ? "/" : window.location.pathname;
}
