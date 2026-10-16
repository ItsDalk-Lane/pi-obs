# C2 原生插件：阶段 1 完成报告

> 目标（计划书 §5 阶段 1）：在 Obsidian 里真正跑通「打开会话 → 发消息 → 看回复」。
>
> 结论：**接线全部打通，无头验证全绿。剩下一步是你在 Obsidian 里做真机验收**（见文末）。
> 本文记录交付内容、与计划书的偏离、实测发现和遗留问题。

日期：2026-10-15 ｜ 前置：[c2-phase0-spike.md](c2-phase0-spike.md)

---

## 1. 交付内容

### 新增

| 文件 | 作用 |
| --- | --- |
| `obsidian-plugin/platform-fetch.ts` | 平台适配层 · 网络。Phase 0 的 `spike/node-fetch-shim.ts` 迁入；`http/https` 走 `node:http`，其余协议（`app://`、`blob:`）回落 Chromium 实现 |
| `obsidian-plugin/api-dispatch.ts` | 接入层。拦截 `fetch` 的 `/api/` 前缀 + `EventSource` 替身 + 统一错误围栏 + 未迁移路由的 501 兜底 |
| `obsidian-plugin/services/respond.ts` | 处理器形状（`(request, ctx) => Response`）与 JSON 响应 |
| `obsidian-plugin/services/routes.ts` | 调度表 + 匹配器（全静态优先，`/api/agent/new` 不会被 `/api/agent/:id` 抢走） |
| `obsidian-plugin/services/sessions.ts` | 会话列表 / 打开 / 实时状态 / 改名 / 删除 |
| `obsidian-plugin/services/agent.ts` | 新建会话 / 发命令 / agent 状态 / 事件流 |
| `obsidian-plugin/services/platform.ts` | 运行中会话轮询 / 主目录 / 模型列表 |
| `obsidian-plugin/services/sdk-internals.ts` | MCP：把 SDK 的"未导出模块"换成已打进 bundle 的那一份（见 §3.2） |
| `obsidian-plugin/views/main-view.tsx` | 主视图 ItemView，挂 `I18nProvider + AppShell`；建宿主结构、指定弹层容器、回写视口高度 |
| `obsidian-plugin/shims/next-navigation.ts` | `next/navigation` 的替身（构建期别名绑定，见 §2.2） |
| `obsidian-plugin/boot-banner.js` | 引导段，前置到产物最前面：算出 `import.meta` 等价物（**真机加载失败就是这里修的**，见 §3.2） |
| `obsidian-plugin/app-css.entry.css` | 界面样式入口：katex + 四份 app CSS（给 `build-css.mjs` 用，不参与 Next 构建） |
| `obsidian-plugin/plugin-shell.css` | 宿主规则（不作用域化）：钉宿主高度、补 `--font-noto-mono`、弹层容器（见 §4） |
| `obsidian-plugin/scripts/build-css.mjs` | Tailwind + PostCSS 编译样式并作用域化，产出 `styles.css` |
| `obsidian-plugin/scripts/scope-to-host.mjs` | 作用域化 PostCSS 插件（见 §4 的改写规则表） |
| `obsidian-plugin/scripts/check-css-scope.mjs` | 泄漏断言：没有选择器能命中宿主之外的元素（见 §4） |
| `obsidian-plugin/scripts/selector-utils.mjs` | 选择器列表切分器，作用域化与泄漏断言共用 |
| `lib/portal-host.ts` | 弹层挂载点：Web 版 = `document.body`，插件版 = 宿主内的容器（见 §4） |
| `obsidian-plugin/css-modules.d.ts` | `*.module.css` 的类型声明（Next 项目里由 `next-env.d.ts` 提供） |
| `obsidian-plugin/pi-obs-sdk.d.ts` | `@pi-obs-sdk/*` 别名与引导段全局的类型声明 |
| `obsidian-plugin/stub-env.mjs` | 纯 Node 验证的桩环境（DOM + Obsidian 模块） |
| `obsidian-plugin/smoke.mjs` | 冒烟：加载 bundle、跑插件生命周期、直接打服务层 |
| `obsidian-plugin/smoke-hostile.mjs` | 敌意环境：`.asar` 路径 + 拿不到 `app` + Worker 构造不可用，三种退化都断言能活 |
| `obsidian-plugin/ui-mount.mjs` | jsdom 渲染：把真实 React 界面挂进假 DOM，核对会话列表、输入框与样式覆盖率 |
| `obsidian-plugin/layout-check.mjs` | 真实 Chromium 里量布局，并以 Web 版为基准比对比例（`PI_OBS_DUMP_TREE=1 node ui-mount.mjs` 可导出 DOM 树+计算样式） |
| `obsidian-plugin/e2e-agent.mjs` | 端到端：建会话 → 订阅事件流 → 发消息 → 收流式回复（真调 LLM），并断言 MCP 没被关掉 |

### 修改

| 文件 | 改动 |
| --- | --- |
| `obsidian-plugin/main.ts` | 1248 行 → 90 行。服务器/npm/iframe/设置页那一整套生命周期管理全部删除 |
| `obsidian-plugin/esbuild.config.mjs` | `platform: node`；`next/navigation` 与 7 个 `@pi-obs-sdk/*` 别名；`import.meta` 整体替换；CSS Modules 替身 |
| `obsidian-plugin/tsconfig.json` | 加 `jsx`、`paths`（`@/*` 与 `next/navigation`）、`moduleResolution: bundler`，include 子目录 |
| `obsidian-plugin/styles.css` | **从手写改为生成物**（`scripts/build-css.mjs` 产出，不要手改） |
| `obsidian-plugin/package.json` | 加 `build:css`，`build` 串上样式编译 + 泄漏断言，另有 `smoke` / `smoke:hostile` / `ui-mount` / `e2e` |
| `lib/pi-sdk-internals.ts` | 加 `buildPiSdkInternals()` 与 `registerBundledPiSdkInternalsLoader()` 两个接缝；导出模块/成员映射表供插件复用（Web 版行为不变） |
| `components/ChatWindow.tsx`、`DirectoryPicker.tsx`、`SidebarMenu.tsx` | 弹层容器从 `document.body` 改为 `getPortalHost()`（见 §4） |
| `tsconfig.json`（仓库根） | `exclude` 加 `spike` —— 那个目录里的 Phase 0 探针从 `spike/` 解析不到 `obsidian` 类型，会让整仓库类型检查长期报错 |

已删除：`spike/node-fetch-shim.ts`（迁入 `platform-fetch.ts`，避免两份副本漂移）。

---

## 2. 与计划书的偏离（三处，都有理由）

### 2.1 迁移的路由从 5 个扩到 12 个

计划书写的是 5 个路由。按验收标准（列出→打开→发送→流式）逐条追调用链后发现不够：

| 追加的路由 | 为什么非它不可 |
| --- | --- |
| `GET /api/agent/[id]` | 与 `POST` 同一文件；`useAgentSession` 用它探测会话是否在跑 |
| `GET /api/sessions/[id]/state` | 打开会话时读取运行状态、模型、上下文用量。缺它不崩，但会话会当作"非运行中"渲染 |
| `GET /api/agent/running` | 侧栏的轮询端点 |
| `GET /api/home` | 侧栏据此把绝对路径显示成相对路径 |
| `GET /api/models` | 输入框上方的模型选择器 |
| `PATCH` / `DELETE /api/sessions/[id]` | 改名、删除。与 `GET` 同文件，顺手迁完这个路由模块 |

未映射的路由现在返回 **501 + 一条去重的控制台警告**，界面各自降级，不会崩。

### 2.2 `AppShell` 的 `next/navigation` 依赖用构建期别名解决，而不是改源码

计划书写"移除 AppShell 里对 Next 的那一处依赖"。实际做法是**在 esbuild 配置里把 `next/navigation` 指向 `shims/next-navigation.ts`**，源码一行不改。

理由：`AppShell` 用的是 `useRouter().replace()`（同步地址栏查询串）和 `useSearchParams()`。要把它换成不依赖 Next 的实现，就得让首屏导航从 `window.location` 读——而 Web 版是 SSR 预渲染的，`window` 在服务端不存在，会引入 hydration 不一致。别名方案对 Web 版零影响，等阶段 4 删掉 Next 时别名自然成为唯一绑定。

### 2.3 `import.meta` 的替换方式换了两次（最终方案见 §3.2）

Phase 0 用 `--define:import.meta.url='"file:///C:/.../<插件目录>/main.js"'`，把路径写死。我一度改成运行期从 `__filename` 推导，理由是"可移植"。**这个改动导致插件在真机上完全加载不了**，详见 §3.2。现在由 `boot-banner.js` 分层取值，并把替换范围从 `import.meta.url` 扩大到整个 `import.meta`。

---

## 3. 三个实测发现

### 3.1 服务层搬进进程后，传输层的东西应该一并丢掉

原路由里的 `jsonResponse()`（gzip 压缩、`Vary`、`Server-Timing`）在进程内调用没有任何意义——没有网络往返，没有压缩收益。服务层统一用 `Response.json` + `Cache-Control: no-store`（`no-store` 必须显式给：界面走的是 HTTP 缓存语义，缺它会拿到陈旧数据）。`startServerPerf` 也未沿用。

这不是偷懒，是"包装层与宿主解耦"的必然结果；签名形状（`(request) => Response`）保持不变，阶段 2 批量迁移时照这个模板走。

### 3.2 【已修复】打包后 `import.meta` 定位错误 —— 真机加载失败的根因

这是阶段 1 唯一一次真机失败，也是最有价值的一条经验。**记录完整，因为它推翻了 Phase 0 的一个隐含前提。**

**真机报错**：

```
Plugin failure: pi-obs Error: Invalid package
  C:\Users\Its_D\AppData\Local\Programs\Obsidian\resources\electron.asar
  at createError (node:electron/js2c/node_init:2:2356)
  at readFileFromArchiveSync (node:electron/js2c/node_init:2:10117)
  at t.readFileSync (node:electron/js2c/node_init:2:10982)
  at @earendil-works/pi-coding-agent/dist/config.js (plugin:pi-obs:1707:61)
  at __init … → dist/cli/args.js → dist/index.js
```

**因果链**（每一步都实证过）：

1. pi SDK 的 `config.js` **在模块顶层**就定位自己的包：`getPackageJsonPath()` = `join(getPackageDir(), "package.json")`，然后 `readFileSync` 它。
2. `getPackageDir()` = `findNodePackageDir(dirname(fileURLToPath(import.meta.url)))`——从模块自身位置向上找 `package.json`。
3. 我当时的 `import.meta.url` 从 `__filename` 推导。**但 Obsidian 不用 Node 的 CommonJS 包装器求值插件代码**：插件里看到的 `__filename` 指向 Electron 自己的 `...\Programs\Obsidian\resources\electron.asar\...`。
4. 于是向上查找在 `electron.asar` 里**命中了一个 `package.json`**（Electron 自带的），`getPackageJsonPath()` 落进 asar 内部。
5. Electron 拒绝读 `electron.asar`（受保护归档），抛的是 **"Invalid package"**，而 SDK 的容错分支只接受 `ENOENT` → 直接 rethrow → 插件加载失败。

**为什么 Phase 0 通过了、纯 Node 冒烟也通过**：Phase 0 的路径是**写死**的，指向真实插件目录；那个目录下没有 `package.json`，`readFileSync` 抛的是 `ENOENT`，正好被 SDK 吞掉。纯 Node 里 `__filename` 是真的 main.js，同样走 ENOENT。**两个绿灯都掩盖了同一件事：值对不对不重要，"那个目录下有没有 package.json"才重要。**

**修复**（`obsidian-plugin/boot-banner.js`，以 `banner` 原文前置到产物最前面，在 esbuild 的模块初始化之前执行）：

| 取值顺序 | 适用场景 |
| --- | --- |
| `__filename`（先校验：是真实文件、且**不含 `.asar`**） | 纯 Node（冒烟测试） |
| Obsidian 自己的状态：`app.vault.adapter.getBasePath()` + `manifest.dir`（回退 `.obsidian/plugins/pi-obs`） | 真机 |
| 一个合法但不存在的 `file:///C:/pi-obs/main.js` | 兜底 |

并把 `define` 从 `"import.meta.url"` 扩成 **`"import.meta"`** 整体替换，顺带修好了 jiti 用的 `import.meta.resolve`（原来的写法会在产物里留下 `import_meta3 = {}`，`resolve` 调用必崩）。重建后产物里 **`import_meta` 残留为 0**。

**关键不变量（回归测试守的就是它）**：算出的 URL **绝不能落在 `.asar` 里**。Node 里没有 Electron 的 asar fs，复现不出最后那步抛错，所以 `smoke-hostile.mjs` 造出"路径含 `.asar` 且其中确有 `package.json`"的条件，断言 URL 避开了它——包括拿不到 `app` 的退化分支。

**同类问题的处置（2026-10-15 23:40 处理完）**：SDK 里相对 `import.meta.url` 找**资源**的几处，现在分三种情况，结论各不相同：

| 位置 | 处置 | 结果 |
| --- | --- | --- |
| `getPackageDir()` → `lib/pi-sdk-internals.ts` 的同实例校验 | **已修**：打包后那些「未导出模块」就在同一个 bundle 里，改成直接 import（`services/sdk-internals.ts` + 构建期别名），不再需要"SDK 在磁盘上的位置"这个概念 | MCP **已启用**（e2e 断言 `MCP is off` 不再出现） |
| `new URL("./image-resize-worker.js", import.meta.url)` | **无需处理**：`resizeImage()` 本来就是 `try { worker } catch { return resizeImageInProcess(...) }` | 图片缩放走进程内回退，功能不缺 |
| `new URL("./worker.js", …)` + `quickjs-wasi/quickjs.wasm`（codemode） | **不可修** | codemode 关闭（与终端同级，见下） |

**codemode 为什么救不回来 —— 这条推翻了我先前"随包附带 worker 资源"的建议。** `pi-codemode` 的 `workerLauncher` 里是 `new (require("node:worker_threads").Worker)(workerUrl, { workerData })`，**没有任何回退路径**；而 Phase 0 实测 Electron 渲染进程的 Node 不支持 Worker 线程（`ERR_MISSING_PLATFORM_FOR_WORKER` —— `node-pty` 正是死在这上面）。把 `worker.js`、`quickjs.wasm` 复制进插件目录，只会把报错从「找不到模块」换成「Failed to start worker」，白搭几十 MB。**所以这三样一律不附带**，`spike/` 之外不再新增二进制资源。

一个精确的区别（已用测试钉住）：`require("node:worker_threads")` 在渲染进程里**是成功的**（真机那次插件加载成功、直到 worker 文件那一步才报错），失败的只有**构造 Worker**。`smoke-hostile.mjs` 就按这个条件模拟：让 `Worker` 构造函数抛错，断言插件仍能加载、`onload()` 仍能完成。

### 3.3 界面会往 DOM 里塞 `<style>`

jsdom 验证里发现，渲染出来的子树里带着 `@keyframes session-info-pop` 这样的 CSS 文本——**组件在运行时注入了一部分样式**。所以"完全不接入 CSS"并不是一个可选项的极端，现状是"运行时那部分生效、构建时那四份文件不生效"，两者混在一起反而是最难看的状态。这直接推高了下一件事的优先级（见 §4）。

---

## 4. 界面样式：方案 A 已落地

原问题：`app/globals.css`、`settings.css`、`sidebar.css`、`sidebar-menu.css` 共 **7637 行**由 Next 的 PostCSS/Tailwind 流水线产出，插件构建里没有对应步骤，所以界面功能可用、外观不可用。而这些样式**不能直接塞进** `obsidian-plugin/styles.css` —— Obsidian 的 `styles.css` 是全局的，四份文件里有 `* { box-sizing }`、`html, body { overflow: hidden; background: var(--bg) }`、`:root { --bg: … }`，直接注入会把整个 Obsidian 一起改掉。

### 实现：三段

| 文件 | 职责 |
| --- | --- |
| `scripts/build-css.mjs` | PostCSS + `@tailwindcss/postcss` 编译 `app-css.entry.css`（katex → globals → settings → sidebar → sidebar-menu，顺序照抄 `app/layout.tsx`），跑作用域化，再拼上 shell，产出 `styles.css`（**生成物，不要手改**） |
| `scripts/scope-to-host.mjs` | 作用域化改写，见下表 |
| `plugin-shell.css` | 宿主规则，不作用域化、拼在最后。钉宿主高度、补 `--font-noto-mono`、放弹层容器 |

作用域化的四条改写规则：

| 原选择器 | 改写成 | 理由 |
| --- | --- | --- |
| `:root` / `html` / `body` / `:host` | `.pi-obs-host` | 页面级 → 宿主本身。`html, body { height: 100vh; overflow: hidden; … }` 因此变成宿主的尺寸约束 |
| `*` | `.pi-obs-host, .pi-obs-host *` | Tailwind preflight 的 `box-sizing` 只作用于宿主子树 |
| `html.dark` / `html[data-theme="x"]` / `html.dark .foo` | `html.dark .pi-obs-host` / `html[data-theme="x"] .pi-obs-host` / `html.dark .pi-obs-host .foo` | **保留原条件**：`useTheme` 就是把 `data-theme`/`class="dark"` 写在 `documentElement` 上的，条件不能丢 |
| `::view-transition-*` | 丢弃 | 页面级伪元素，插件里没有对应物 |

`selector-utils.mjs` 里有一个按括号/引号深度切逗号的切分器，作用域化与泄漏断言共用 —— 不能用 `split(",")`，否则 `:is(h1, h2) code` 会被切碎，看起来像泄漏。

### 弹层：`lib/portal-host.ts`

三处 `createPortal` 原本挂 `document.body`，落在作用域之外，会完全没有样式。新增 `lib/portal-host.ts`（纯函数，无 React/JSX，符合跨边界约束）：

- Web 版不设置它 → 仍是 `document.body`，行为完全不变
- 插件在 `onOpen` 里 `setPortalHost(宿主内的 .pi-obs-portal)`，`onClose` 置回 null

调用点只改取值，不改结构：`ChatWindow`（引用气泡）、`DirectoryPicker`、`SidebarMenu`（后两者本来就有 `portalTarget` 状态）。

### 无法目视验证，所以把它写成断言

`scripts/check-css-scope.mjs` 解析生成的 `styles.css`，断言**每条规则的每个选择器**必须满足其一：含 `.pi-obs-host`、或以 `.pi-obs-` 开头、或以视图外壳 `.workspace-leaf-content[data-type="pi-obs-main"]` 开头。**反向验证过**：故意追加一条 `body { … }`，脚本必须失败 —— 实测输出 `styles.css:7750 body` 并 exit 1。

`ui-mount.mjs` 另加一条：渲染出的 DOM 里 **83%（69/83）** 的类名能在样式表里找到。作用域化若把类名改坏，这条会掉下去。

### 真机反馈后补修的两个 bug（2026-10-16）

用户反馈"聊天输入框跑到了顶部，应该在底部"。一查是**两个独立原因叠在一起**：

**① Tailwind 工具类一个都没生成。** Tailwind v4 默认从**构建时的 cwd** 扫描源文件，而样式构建跑在 `obsidian-plugin/` 下 —— 那里没有界面源码，于是 `.flex` / `.h-full` / `.overflow-hidden` 全部缺失：

```
<div.chat-content.relative.flex.h-full.min-w-0.flex-col.overflow-hidden>
   display=block   height=auto   overflow=visible      ← 工具类全没生效
```

`.chat-content` 从"占满高度的 flex 列"退化成"高度自适应的块"，聊天列高度归零，输入框于是顶到最上面。Next 构建的 cwd 是仓库根，自动扫描拿得到，所以 Web 版没这个问题。

修法：在 `app-css.entry.css` 里显式列扫描范围 —— `@source "../app"` / `"../components"` / `"../hooks"` / `"../lib"`。

**② `--app-viewport-height` 被写成了 `0px`。** 视图在 `onOpen()` 里同步读 `host.clientHeight` 回写这个变量，但那一刻布局还没发生，读到的就是 0；而界面的根元素高度正是 `height: var(--app-viewport-height, 100dvh)` —— 0 让它整棵树塌到顶上。修法：**只在高度 > 0 时回写**，其余交给 `ResizeObserver`（元素拿到布局后一定会回调），另补一帧 `requestAnimationFrame` 处理"先建后挂"。

### 因此新增的验证：`layout-check.mjs`（真实 Chromium 里对照 Web 版）

这两个 bug 都是**静态断言全绿、界面却是坏的**，所以补了一层真正量布局的检查：

1. 让 `ui-mount` 把真实 React 界面的 DOM 快照写到临时文件（`PI_OBS_SNAPSHOT`）
2. 快照 + 生成的 `styles.css` 丢进真实 Chromium（Playwright，复用缓存里的 Chromium）
3. 在同一个 Chromium、同一视口下打开 Web 版，量同一批元素
4. **断言两边比例一致** —— 不猜"应该在哪"，以 Web 版为基准

为什么不能用 jsdom：**jsdom 解析 `@layer` 但不应用其中的规则**，而 Tailwind 的工具类全在 `@layer utilities` 里 —— 于是 DOM 树 dump 里看不出 `.flex` 有没有生效。这是漏掉 ① 的直接原因。

修复后的实测（视口 1000×700）：

| 指标 | 插件 | Web 版 |
| --- | --- | --- |
| `chat-content` display / flex-direction | flex / column | flex / column |
| 聊天列高度 / 视口 | 1.000 | 1.000 |
| 输入框底边 / 视口 | **0.598** | **0.598** |
| 侧栏宽度 / 视口 | 1.000 | 1.000 |

另加两条静态断言（`check-css-scope.mjs`）：布局关键工具类必须生成；`ui-mount` 的类名覆盖率阈值从 0.5 提到 **0.85**（工具类缺失那次的实测值是 83%，正常 94% —— 原来的 0.5 就是为了让检查通过，等于把真 bug 放过去了）。

> **注意一个预期差**：在这个"还没打开会话"的欢迎界面里，输入框本来就在视口 **59.8%** 处（Web 版同样如此），不是贴底。贴底是打开会话后的聊天界面。所以"应该在底部"这个预期只对后者成立。

### 结果与已知副作用

| 项 | 值 |
| --- | --- |
| `styles.css` | 215.2 KiB / 7765 行（含 katex、xterm、Tailwind preflight 与工具类） |
| 泄漏检查 | 1469 条规则全部通过；布局关键工具类齐全 |
| 宿主高度 | 由 shell 钉成 `100%`；`--app-viewport-height` 由 `ResizeObserver` 回写宿主真实高度（**只在 > 0 时写**，见上） |
| **已知副作用** | `useTheme` 会把 `.dark` / `data-theme` 写到 `documentElement`，等于作用到 Obsidian 根节点。Obsidian 自己用的是 `.theme-dark` 与 `--background-*` 命名，不冲突；但这是真实副作用，记在这里 |
| 视觉保真度 | **我无法目视验证**。作用域化只做选择器改写、不动类名，覆盖率达 83%，但最终好不好看只能你看一眼 |


---

## 5. 验证方式与命令

五个脚本都在 `obsidian-plugin/` 下，互不替代：

```bash
# 0. 构建（含：样式编译 + 泄漏断言 + 类型检查 + 打包）
npm run build:plugin
# 或只跑样式那一段：
node obsidian-plugin/scripts/build-css.mjs && node obsidian-plugin/scripts/check-css-scope.mjs

# 1. 冒烟：加载 bundle、跑插件生命周期、直接打服务层（不需要网络）
node obsidian-plugin/smoke.mjs

# 2. 敌意环境：.asar 路径 / 拿不到 app / Worker 造不出来，三种退化都要能活
node obsidian-plugin/smoke-hostile.mjs

# 3. jsdom 渲染：真实 React 界面挂进假 DOM（需要 jsdom，见脚本头注释）
node obsidian-plugin/ui-mount.mjs

# 4. 端到端：真调 LLM 跑一轮「建会话 → 事件流 → 发消息 → 收回复」（用完即删会话）
node obsidian-plugin/e2e-agent.mjs [cwd]

# 5. 布局对照：真实 Chromium 里量尺寸，并以 Web 版（npm run dev）为基准比对比例
node obsidian-plugin/layout-check.mjs
```

本次实测结果：

| 脚本 / 检查 | 结果 |
| --- | --- |
| `scripts/check-css-scope.mjs` | **通过**，1469 条规则无一条能命中宿主之外，布局工具类齐全；两类断言都反向验证过（故意加 `body {…}`、故意改掉 `.h-full` → 都会失败） |
| `smoke.mjs` | **13/13 通过**。bundle 能在纯 Node 加载、`onload` 完成、`fetch`/`EventSource` 被接管、`GET /api/sessions` 返回 6 个真实会话、打开会话拿到上下文、实时状态、`/api/agent/running`、`/api/home`、未迁移路由降级成 501、`onunload` 正常 |
| `smoke-hostile.mjs` | **14/14 通过**。`.asar` 路径、拿不到 `app`、`Worker` 构造不可用三种退化下都能加载 |
| `ui-mount.mjs` | **7/7 通过**。真实界面渲染出 290 个元素，侧栏显示出 6 个会话里的 5 个标题，输入框在位，**样式表覆盖 94%（80/85）的 DOM 类名**，渲染期无真实报错 |
| `layout-check.mjs` | **6/6 通过**。聊天列 100% 视口高、输入框底边 59.8%（与 Web 版逐项一致）——见上面两个 bug 的说明 |
| `e2e-agent.mjs` | 管道 **全通过**（握手 / 事件流 / 回合收尾 / MCP / 会话清理）；**模型回复这一项目前失败，原因是 provider 的密钥已失效（`401 无效的令牌`），不是插件问题** —— 脚本已把这条诊断打出来 |

其他实测数字：

| 项 | 值 |
| --- | --- |
| `main.js` 体积 | 28.3 MiB（未 minify 的生产构建）——阶段 5 的体积议题，现在只是记录 |
| `styles.css` 体积 | 215.2 KiB / 7765 行（生成物，含 katex + xterm + Tailwind preflight 与工具类） |
| `tsc --noEmit` | 插件 tsconfig **0 错误**；仓库根 tsconfig **0 错误**（`exclude` 掉 `spike` 之后） |
| 产物里的 `import_meta` 残留 | **0**（`define` 覆盖到整个 `import.meta` 之后） |
| 未迁移路由 | 12 个已迁移，其余 53 个返回 501 + 一次控制台警告 |

---

## 6. 需要你做的验收（约 2 分钟）

**修复版已装进测试 vault（`Desktop/0`）。这一轮的主题是"布局到底对不对"。**

1. 完全退出 Obsidian（不是关窗口，是退出进程），重开。
2. 设置 → 第三方插件 → 把 **Pi Obs** 打开。
3. 命令面板（`Ctrl+P`）搜「打开 Pi Obs」回车。
4. 先看**没打开会话时的欢迎界面**（就是上一轮你截图那个）：输入框应该落在视口中部偏下（约 60%），**不再贴着顶部**。
   注意：它不是贴底的 —— Web 版在这个界面同样在 60% 处，贴底是"打开会话之后"的聊天界面。
5. 再点开一个会话，看聊天界面：
   - 消息区占满剩余高度、可滚动；输入框贴住底部
   - 侧栏是独立窄栏、会话按项目分组
   - 消息有底色区分，用户与助手一眼分开
6. 再确认**没有伤到 Obsidian 本身**：打开一个笔记、点开设置、看看侧栏，一切正常（这是作用域化最要紧的一条）。

已知的、不用报的现象：控制台里成片的 `route not migrated yet`；`Code mode is off`（§3.2 已论证不可修，与终端同级）。

**顺手报一个环境问题**：`~/.pi/agent/models.json` 里 `agnes` provider 的密钥现在是 **401 无效的令牌**（我直连它的 API 验过），所以你的 pi agent 用这个 provider 也调不通。要么密钥已吊销、要么本该走环境变量。这个不修的话，插件里的对话会"发出去但回空"。

有报错就贴给我；如果是样式对不上，**描述"哪一块看起来不对"比截图更好用**（我知道每个类该是什么样，你说位置我就能定位）。

---

## 7. 下一步

两项待办（样式 A、SDK 资源）都已落地。阶段 2 可以开工了，开工前只剩一个技术选择：

1. **`lib/pi-sdk-internals.ts` 的那两个接缝要不要留**（§3.2）——现在 Web 版不注册它就完全不变，插件注册它就走打包路径。留着是零成本的，但阶段 4 删掉 Web 侧之后可以把它简掉。
2. **阶段 2 的路由迁移顺序**：建议先迁 `files` / `git` / `worktrees` / `cwd`（侧栏与文件面板的骨架），再迁 `mcp` / `auth` / `tools` / `ui-state`，最后 `terminal`（它要改造成管道模式，是阶段 3 的前置）。

