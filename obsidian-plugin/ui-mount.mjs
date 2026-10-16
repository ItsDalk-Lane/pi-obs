// jsdom 渲染验证：把真实的 React 界面挂进一个假 DOM，看它能不能在无 Obsidian 的环境里跑起来。
//
// 它验证什么：模块级浏览器 API 依赖、首屏渲染、挂载路径（I18nProvider + AppShell）、
// 以及界面是否真的从服务层取到了会话。
// 它不验证什么：Obsidian 的样式、事件循环、真实布局 —— 那些只能你开 Obsidian 看。
//
// 需要 jsdom（装在托管工作区，不在本仓库里）：
//   cd <node>/workspace && npm install jsdom
// 找不到 jsdom 时本脚本会跳过，不当失败。

import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiCall, installObsidianStubs, loadPluginClass } from "./stub-env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** jsdom 装在 node 运行时的同级 workspace 里，由 execPath 推导，不写死绝对路径。 */
function loadJsdom() {
  const workspace = path.resolve(path.dirname(process.execPath), "..", "..", "workspace");
  try {
    const workspaceRequire = createRequire(path.join(workspace, "index.js"));
    return workspaceRequire("jsdom");
  } catch {
    return null;
  }
}

const jsdomModule = loadJsdom();
if (!jsdomModule) {
  console.log("SKIP  jsdom not installed next to this Node runtime — skipping the render check");
  process.exit(0);
}

const dom = new jsdomModule.JSDOM("<!doctype html><html><body></body></html>", {
  url: "app://obsidian.md/index.html",
  pretendToBeVisual: true,
});
const { window } = dom;

// jsdom 的 window 上该有的全局量搬到 globalThis，让 bundle 里的浏览器代码能找到它们。
for (const key of Object.keys(window)) {
  if (key in globalThis) continue;
  try { globalThis[key] = window[key]; } catch { /* 只读的跳过 */ }
}
for (const key of ["window", "document", "location", "history", "navigator", "localStorage"]) {
  try {
    Object.defineProperty(globalThis, key, { value: window[key] ?? window, configurable: true, writable: true });
  } catch { /* 已经可写 */ }
}

// 上面把 window 的 postMessage 之类搬到了 globalThis；EventTarget 的方法在原型上，
// 不在 Object.keys(window) 里，得单独补，否则会出现"有 postMessage 没有 addEventListener"的半吊子状态。
// 真实的 Obsidian 里 window 就是 globalThis，不存在这个问题。
for (const method of ["addEventListener", "removeEventListener", "dispatchEvent"]) {
  Object.defineProperty(globalThis, method, {
    value: window[method].bind(window),
    configurable: true,
    writable: true,
  });
}

// jsdom 的 window 上有一部分是 Symbol/非可枚举属性，Object.keys 搬不过来。
// 这里按名字补一遍界面会用到的 DOM 构造器与工具函数。
const WINDOW_GLOBALS = [
  "MutationObserver", "DOMParser", "XMLHttpRequest", "Blob", "File", "FileReader", "FormData",
  "Image", "Node", "Element", "HTMLElement", "SVGElement", "HTMLInputElement", "HTMLTextAreaElement",
  "HTMLCanvasElement", "CustomEvent", "KeyboardEvent", "MouseEvent", "PointerEvent", "DragEvent",
  "ClipboardEvent", "DataTransfer", "DOMRect", "Range", "Selection", "Text", "DocumentFragment",
  "NodeFilter", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "customElements",
  "CSS", "CSSStyleSheet", "scrollTo", "scroll",
];
for (const name of WINDOW_GLOBALS) {
  if (globalThis[name] !== undefined) continue;
  try { globalThis[name] = window[name]; } catch { /* 只读的跳过 */ }
}
class NoopObserver {
  observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
}
globalThis.ResizeObserver ??= NoopObserver;
globalThis.IntersectionObserver ??= NoopObserver;
window.ResizeObserver ??= NoopObserver;
window.IntersectionObserver ??= NoopObserver;
window.matchMedia ??= () => ({
  matches: false, media: "", addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {}, dispatchEvent: () => false,
});
globalThis.matchMedia ??= window.matchMedia;
window.scrollTo ??= () => {};
window.HTMLElement.prototype.scrollIntoView ??= function scrollIntoView() {};
window.HTMLElement.prototype.scrollTo ??= function scrollTo() {};
if (!window.navigator.clipboard) {
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText: async () => {}, readText: async () => "" },
    configurable: true,
  });
}

// jsdom 对 app:// 这种非 http 源会拒绝 localStorage（"opaque origin"），
// 而 Electron 的 app:// 渲染进程是有 local/sessionStorage 的，所以这里补一个内存实现。
function memoryStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
    clear: () => { store.clear(); },
    key: (index) => [...store.keys()][index] ?? null,
    get length() { return store.size; },
  };
}
for (const name of ["localStorage", "sessionStorage"]) {
  let available;
  try { available = window[name]; } catch { available = undefined; }
  if (!available) {
    for (const target of [globalThis, window]) {
      try {
        Object.defineProperty(target, name, { value: memoryStorage(), configurable: true, writable: true });
      } catch { /* 只读的跳过 */ }
    }
  }
}

// Obsidian 给 Element 原型加的那套 DOM 辅助方法（empty / createDiv / createEl / addClass …）。
// 插件的视图代码直接用它们，所以 harness 必须补齐。
function applyOptions(element, options) {
  if (!options) return;
  if (options.cls) element.className = Array.isArray(options.cls) ? options.cls.join(" ") : options.cls;
  if (options.text) element.textContent = options.text;
  if (options.type) element.setAttribute("type", options.type);
  if (options.placeholder) element.setAttribute("placeholder", options.placeholder);
  if (options.title) element.setAttribute("title", options.title);
  if (options.href) element.setAttribute("href", options.href);
  if (options.attr) for (const [key, value] of Object.entries(options.attr)) element.setAttribute(key, String(value));
  if (options.value !== undefined) element.value = String(options.value);
}
Object.assign(window.Element.prototype, {
  createEl(tag, options) {
    const element = this.ownerDocument.createElement(tag);
    this.appendChild(element);
    applyOptions(element, options);
    return element;
  },
  createDiv(options) { return this.createEl("div", options); },
  createSpan(options) { return this.createEl("span", options); },
  empty() { while (this.firstChild) this.removeChild(this.firstChild); },
  addClass(...names) { this.classList.add(...names); },
  removeClass(...names) { this.classList.remove(...names); },
  toggleClass(name, on) { this.classList.toggle(name, on); },
  setText(text) { this.textContent = text; },
  setAttr(key, value) { this.setAttribute(key, String(value)); },
  detach() { this.remove(); },
});

// React 的报错都从 console.error 走；先记下来，失败时报出来。
const consoleErrors = [];
const originalError = console.error;
console.error = (...args) => {
  consoleErrors.push(args.map((value) => (value instanceof Error ? `${value.name}: ${value.message}` : String(value))).join(" "));
  originalError(...args);
};

installObsidianStubs();

const PluginClass = loadPluginClass();
const plugin = new PluginClass(null, { id: "pi-obs", dir: "obsidian-plugin", version: "0.1.0" });

const leaves = [];
const app = {
  vault: { adapter: { getBasePath: () => process.cwd() } },
  workspace: {
    layoutReady: true,
    onLayoutReady: (callback) => callback(),
    getLeavesOfType: (type) => leaves.filter((leaf) => leaf.type === type),
    getLeaf: () => {
      const leaf = {
        type: null,
        view: null,
        async setViewState(state) {
          this.type = state.type;
          const factory = plugin.registered.get(state.type);
          if (!factory) throw new Error(`no factory registered for ${state.type}`);
          this.view = factory(this);
          await this.view.onOpen();
        },
        detach() {},
      };
      leaves.push(leaf);
      return leaf;
    },
    revealLeaf: async () => {},
  },
};
plugin.app = app;

// 布局排查开关：把宿主子树的 元素/类名/计算样式 打出来。
// jsdom 不做真实布局，但会按样式表算出声明值，够用来找"哪一层没有 height/flex"。
// 用法：PI_OBS_DUMP_TREE=1 node ui-mount.mjs
async function dumpTree(host) {
  const stylesheet = await readFile(path.join(here, "styles.css"), "utf8");
  const styleEl = window.document.createElement("style");
  styleEl.textContent = stylesheet;
  window.document.head.appendChild(styleEl);

  const lines = [];
  const walk = (element, depth) => {
    if (depth > 14) return;
    const computed = window.getComputedStyle(element);
    const raw = element.getAttribute("class") ?? "";
    const cls = raw ? `.${raw.trim().split(/\s+/).join(".")}` : "";
    lines.push(
      `${"  ".repeat(depth)}<${element.tagName.toLowerCase()}${cls}>`
      + ` display=${computed.display} height=${computed.height} flex=${computed.flex}`
      + ` minH=${computed.minHeight} overflow=${computed.overflowY}`,
    );
    for (const child of element.children) walk(child, depth + 1);
  };
  walk(host, 0);
  console.log(`\n===== DOM 树（${lines.length} 层）=====\n${lines.join("\n")}\n===== 结束 =====\n`);
}

async function settle(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  await plugin.onload();
  check("onload() in a DOM environment", true);
  await plugin.openMain();

  const host = window.document.querySelector(".pi-obs-host");
  check("main view mounted .pi-obs-host", Boolean(host));
  if (host) {
    // 首屏是异步的（会话列表要读盘）。等 DOM 连续若干次不再增长，再判定。
    const deadline = Date.now() + 30_000;
    let previous = -1;
    let stable = 0;
    while (Date.now() < deadline && stable < 5) {
      await settle(400);
      const count = host.querySelectorAll("*").length;
      if (count === previous && count > 0) stable += 1;
      else stable = 0;
      previous = count;
    }
    const elementCount = host.querySelectorAll("*").length;
    check("React rendered content", elementCount > 20, `${elementCount} elements`);

    if (process.env.PI_OBS_DUMP_TREE) await dumpTree(host);

    // 把真实 React 界面的 DOM 快照写出去，供 layout-check.mjs 在真实 Chromium 里量布局。
    if (process.env.PI_OBS_SNAPSHOT) {
      await writeFile(process.env.PI_OBS_SNAPSHOT, host.outerHTML, "utf8");
      console.log(`      (snapshot) ${process.env.PI_OBS_SNAPSHOT}`);
    }

    // 组件会往树里塞 <style>（运行时注入的动效），它的文本不是界面内容，排除掉再看。
    const visibleText = [...host.querySelectorAll("*")]
      .filter((element) => !["STYLE", "SCRIPT"].includes(element.tagName))
      .map((element) => element.textContent ?? "")
      .join(" ");
    const list = await apiCall("GET", "/api/sessions");
    const sessions = list.body?.sessions ?? [];
    const named = sessions.filter((session) => {
      const value = session.name || session.firstMessage || "";
      return value && visibleText.includes(value.trim().slice(0, 24));
    });
    check(
      "session list reached the UI",
      sessions.length === 0 || named.length > 0,
      sessions.length === 0 ? "no sessions on disk" : `${named.length}/${sessions.length} session titles visible`,
    );
    if (named.length === 0) {
      console.log(`      (debug) visible text: ${JSON.stringify(visibleText.replace(/\s+/g, " ").slice(0, 500))}`);
      console.log(`      (debug) sessions: ${JSON.stringify(sessions.slice(0, 3).map((s) => ({ id: s.id, cwd: s.cwd, name: s.name, first: (s.firstMessage ?? "").slice(0, 40) })))}`);
    }

    const textarea = host.querySelector("textarea, [contenteditable='true']");
    check("composer is present", Boolean(textarea), textarea ? textarea.tagName.toLowerCase() : "none found");

    // 样式表是不是真的冲着这份 DOM 来的：作用域化只给选择器加前缀，不该动类名，
    // 而 Tailwind 工具类必须真的被生成出来。
    // 阈值 0.85 不是拍脑袋：工具类全部缺失那次的实测值是 83%，而正常值是 94% ——
    // 当初写成 0.5 就是为了让检查通过，结果把一个真 bug 放过去了。
    const stylesheet = await readFile(path.join(here, "styles.css"), "utf8");
    const cssClasses = new Set([...stylesheet.matchAll(/\.([A-Za-z_][\w-]+)/g)].map((match) => match[1]));
    const domClasses = new Set();
    for (const element of host.querySelectorAll("*")) {
      for (const name of element.classList) domClasses.add(name);
    }
    const styled = [...domClasses].filter((name) => cssClasses.has(name));
    const coverage = domClasses.size === 0 ? 0 : styled.length / domClasses.size;
    check(
      "样式表覆盖渲染出来的类名",
      coverage >= 0.85,
      `${styled.length}/${domClasses.size}（${(coverage * 100).toFixed(0)}%，正常 ≥94%）`,
    );
    if (coverage < 0.85) {
      const unstyled = [...domClasses].filter((name) => !cssClasses.has(name)).slice(0, 12);
      console.log(`      (debug) 未出现在样式表里的类名：${unstyled.join(", ")}`);
    }
  }
} catch (error) {
  check("main view renders", false, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  if (error instanceof Error && error.stack) originalError(error.stack.split("\n").slice(0, 6).join("\n"));
}

// 未迁移路由的 501 是阶段 1 的预期状态（界面会各自降级），不算渲染错误。
const IGNORED_CONSOLE_ERRORS = [
  /KaTeX doesn't work in quirks mode/,
  /Not implemented: HTMLCanvasElement's getContext/,
  /Not implemented: window\.scrollTo/,
  /Not implemented: navigation/,
  /Not available in the Obsidian plugin yet/,
  /route not migrated yet/,
];
const meaningfulErrors = consoleErrors.filter((line) => !IGNORED_CONSOLE_ERRORS.some((pattern) => pattern.test(line)));
check("no console errors during render", meaningfulErrors.length === 0, meaningfulErrors.slice(0, 3).join(" | "));

plugin.onunload();

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
