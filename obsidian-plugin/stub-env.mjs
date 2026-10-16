// 纯 Node 验证用的桩环境：把 Obsidian 的宿主对象与最小 DOM 顶上，
// 让 obsidian-plugin/main.js 能在 Node 里被加载并驱动。
//
// 它不能替代真机验收（渲染、Obsidian 的事件循环都不在），
// 但能在打开 Obsidian 之前抓到打包期/加载期/服务层接线的问题。

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

class StubElement {
  constructor(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.textContent = "";
    this.className = "";
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  }
  empty() { this.children = []; }
  createDiv(o) { return this.#append(new StubElement("div"), o); }
  createEl(tag, o) { return this.#append(new StubElement(tag), o); }
  createSpan(o) { return this.#append(new StubElement("span"), o); }
  appendChild(child) { this.children.push(child); return child; }
  #append(child, o) {
    if (o?.cls) child.className = o.cls;
    if (o?.text) child.textContent = o.text;
    this.children.push(child);
    return child;
  }
  addClass() {}
  removeClass() {}
  setText(text) { this.textContent = text; }
  setAttribute() {}
  getAttribute() { return null; }
  querySelector() { return null; }
  addEventListener() {}
  removeEventListener() {}
  remove() {}
}

/** 安装最小 DOM 桩。已经在用 jsdom 的调用方跳过这一步（见 installStubs 的参数）。 */
export function installDomStubs() {
  globalThis.window ??= {};
  Object.assign(globalThis.window, {
    location: { href: "app://obsidian.md/index.html", pathname: "/index.html", search: "", hash: "" },
    history: { state: null, replaceState() {}, back() {}, forward() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
  });
  globalThis.document ??= {};
  Object.assign(globalThis.document, {
    body: new StubElement("body"),
    documentElement: new StubElement("html"),
    createElement: (tag) => new StubElement(tag),
    addEventListener() {},
    removeEventListener() {},
    visibilityState: "visible",
  });
  globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  if (!globalThis.navigator) globalThis.navigator = { clipboard: { writeText: async () => {} } };
}

/**
 * 安装 Obsidian 模块桩。必须在加载 bundle 之前调用。
 *
 * `ItemView` 的 containerEl / contentEl 用调用方提供的 document 真造元素，
 * 这样 jsdom 测试里 React 能真的挂进去。
 */
export function installObsidianStubs() {
  const makeElement = (tag) => (typeof document !== "undefined" && typeof document.createElement === "function"
    ? document.createElement(tag)
    : new StubElement(tag));

  class ItemView {
    constructor(leaf) {
      this.leaf = leaf;
      this.containerEl = makeElement("div");
      this.contentEl = makeElement("div");
      this.containerEl.appendChild(this.contentEl);
      if (typeof document !== "undefined" && document.body) document.body.appendChild(this.containerEl);
    }
    addChild() {}
  }
  class Plugin {
    constructor(app, manifest) {
      this.app = app;
      this.manifest = manifest;
      this.registered = new Map();
    }
    registerView(type, factory) { this.registered.set(type, factory); }
    addRibbonIcon() {}
    addCommand() {}
    registerEvent() {}
    registerDomEvent() {}
  }

  const obsidianStub = {
    ItemView,
    Plugin,
    WorkspaceLeaf: class {},
    Notice: class { constructor(message) { console.log(`  [Notice] ${message}`); } },
    Modal: class {},
    PluginSettingTab: class {},
    Setting: class {},
    FileSystemAdapter: class {},
    addIcon() {},
    removeIcon() {},
    requestUrl: async () => ({ status: 200, text: "" }),
    normalizePath: (value) => value,
  };

  const Module = require("module");
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "obsidian") return obsidianStub;
    if (request === "electron") return { app: {} };
    return originalLoad.call(this, request, parent, isMain);
  };
}

/** DOM + Obsidian 桩一起装（纯 Node 冒烟用）。 */
export function installStubs() {
  installDomStubs();
  installObsidianStubs();
}

/** 加载打包产物，返回插件类。 */
export function loadPluginClass() {
  const module = require(path.join(here, "main.js"));
  return module?.default;
}

/** 一个够 onload() 跑起来的假 app。 */
export function fakeApp() {
  return {
    vault: { adapter: { getBasePath: () => process.cwd() } },
    workspace: {
      layoutReady: true,
      onLayoutReady: (callback) => callback(),
      getLeavesOfType: () => [],
      getLeaf: () => ({ setViewState: async () => {}, detach() {} }),
      revealLeaf: async () => {},
    },
  };
}

/** 通过接入层发一个请求（走的是被接管的 globalThis.fetch）。 */
export async function apiCall(method, urlPath, init = {}) {
  const response = await globalThis.fetch(`app://obsidian.md${urlPath}`, { method, ...init });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}
