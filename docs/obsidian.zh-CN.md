# Obsidian 插件

本仓库是 [agegr/pi-web](https://github.com/agegr/pi-web) 的分支（fork），把它的Web 界面改造为**在 Obsidian 内以本地桌面插件的形式运行**。本文说明这个分支增加了什么；Web 界面本身已有的能力见 [README](../README.zh-CN.md)。

## 分支增加了什么

| 方面 | 上游 | 本分支 |
| --- | --- | --- |
| npm 包名 | `@agegr/pi-web` | `pi-obs`（`package.json` 的 `bin` 声明） |
| 宿主应用 | 浏览器标签页 | Obsidian 视图（`iframe` 加载本地启动的服务） |
| 右侧面板 | 在页面内渲染 | 交给 Obsidian，各自成为独立标签页 |
| 文件类型图标 | Web 界面自身标签栏里的 Catppuccin SVG | 同一批 SVG，注册为 Obsidian 标签页图标 |
| 发布目标 | `agegr/pi-web` 的 GitHub Release | 无，见[发布](#发布) |

Web 界面的行为本身没有变化：会话文件、模型、配置完全共用 —— 在 Obsidian 里开的会话，浏览器里能接着看，反之亦然。

## 目录结构

```text
obsidian-plugin/
  manifest.json      插件元数据（id `pi-obs`，仅桌面端，要求 Obsidian >= 1.5.0）
  main.ts            插件本体：视图、服务生命周期、两个设置标签页（通用 + 服务器）
  main.js            esbuild 产物（已 git 忽略，但会随 npm 包发布）
  styles.css         iframe 尺寸、连接中与断线状态
  esbuild.config.mjs 打包：main.ts + ../lib/{file-icon-names,app-update,pi-obs-server}.ts -> main.js
  package.json       仅插件自身的 devDependencies（obsidian、esbuild、typescript）
```

`lib/file-icon-names.ts` 位于分支的**Web 侧**，插件直接import 它。该文件是纯数据和函数 —— 没有 JSX、没有 React —— 所以 esbuild 可以把同一份映射打进 `main.js`，两侧的图标表不会各自漂移。

## 构建

```bash
npm install
npm run build         # 服务要用的 Next.js 生产构建
npm run build:plugin  # tsc --noEmit + esbuild -> obsidian-plugin/main.js
```

`npm run build:plugin` 等价于 `npm --prefix obsidian-plugin run build`。改动 `main.ts`、`manifest.json`、`styles.css`，或任何会被打进 `main.js` 的文件之后，都要重跑它。`npm run release` 会自动执行。

可分发的文件是三个：`main.js`、`manifest.json`、`styles.css`。`main.js` 已被 git 忽略 —— 它是构建出来的而非提交上去的 —— 但**会随包发布**：它列在 `package.json` 的 `files` 里，打进 npm tarball。

## 安装

### 用 BRAT

1. 从社区插件浏览器安装 **BRAT**。
2. **设置 → BRAT → Add Beta Plugin**，粘贴 `ItsDalk-Lane/pi-obs`。
3. 在**设置 → 第三方插件**中启用 **Pi Obs**。

BRAT 读的是仓库的 GitHub Release，不是 npm 包。它需要 `main.js`、`manifest.json`、`styles.css`
作为 release 附件；放在 `obsidian-plugin/` 子目录没问题，因为 BRAT 读的是 release，不是源码树。

**release tag、release 名称、`manifest.json` 里的 `version` 三者必须完全一致。** 三者不一致时
Obsidian 会拒绝安装，BRAT 会警告并强制以 tag 为准。见 [release.md](./release.md)。

### 手动安装

把三个文件复制到库（vault）的插件目录，目录名必须与 `manifest.json` 里的 `id` 一致：

```text
<vault>/.obsidian/plugins/pi-obs/
  main.js
  manifest.json
  styles.css
```

然后在**设置 → 第三方插件**中启用。侧边栏功能区会出现一个机器人图标，命令面板里是 **Pi Obs: Open Pi Obs**。

Obsidian 只在桌面应用里加载插件，所以 `manifest.json` 设了 `isDesktopOnly: true`。

## 版本策略

插件有**自己独立的版本线**，与 npm 包互不牵连：

| 位置 | 字段 | 当前值 |
| --- | --- | --- |
| `obsidian-plugin/manifest.json` | `version` | `0.1.0` |
| `package.json` | `version` | `0.1.0` |

用户通过 BRAT 更新插件、通过 npm 更新服务，两者很少同时变动。**未经用户明确要求，不得改动任何版本号**——两条版本线现在都由用户掌握。

## 设置

**设置 → Pi Obs** 只有一个页面：顶部是实时服务器状态卡片，其下是 npm 包卡片，再往下是偏好设置。检测在打开页面时进行一次，之后由状态卡片的「刷新」按钮手动触发——不再定时轮询。卡片中显示的每一项——地址、端口、模式、进程 pid、包的安装路径——点击即可复制。

### 服务器状态（卡片）

状态圆点加文字（运行中 / 启动中… / 未运行）、若干值行，以及只出现当前状态允许的按钮：运行中 →「刷新」「停止」；启动中 →「刷新」和禁用的「启动中…」；未运行 → 只有「启动」。「启动」按当前运行模式在后台拉起服务器，最长等 5 分钟。「停止」会结束监听该端口的东西，不论是谁启动的：先结束插件自己的进程，再结束在那里找到的 node/next 进程；两者都不是的监听者不动，只作提示。

### npm 包（卡片）

左侧是 `pi-obs` 和版本号（有更新时显示 `v0.1.0 → v0.1.1`），下方小字是安装路径（点击复制）；右侧只出现当前状态允许的操作——未安装：「安装」；已安装且有新版本：「更新」「卸载」；已安装且是最新：「卸载」。「安装」弹出对话框选择安装位置：插件目录（`<插件目录>/pi-obs-app`）或 npm 全局目录。「更新」「卸载」作用于实际存在的那一份安装。`pi-obs` 尚未发布时 `npm view` 查不到，因此不显示「更新」，只有「卸载」。

### 偏好设置

| 设置项 | 默认值 | 含义 |
| --- | --- | --- |
| 运行模式 | npm 包（推荐） | 服务的两种提供方式，互斥；切换时会先停止正在运行的服务器。「本地目录（开发调试）」供开发 Web 界面时使用，固定以 `npm run dev` 启动——没有启动命令配置项。切换时页面不变、所有配置项都保留，只有状态卡片重新检测。 |
| 启动目录 | *(空)* | 始终显示；本地模式使用：在其中运行 `npm run dev` 的源码检出目录。 |
| 端口 | `30141` | 服务监听端口。 |
| 退出时停止服务器 | 开 | 卸载时结束服务器（关闭 Obsidian 或禁用插件）。也会结束外部启动的那个；关闭则只结束插件自己启动的进程。 |
| 面板位置 | New tab | 文件、终端、子智能体、完整历史面板打开的位置：主区域的新标签页，或右侧栏的标签页。 |

### 服务的两种提供方式

启动是**手动**的：用状态卡片的「启动」按钮，等待端口应答最长 5 分钟。打开视图不会启动或安装任何东西——端口无应答时，视图显示离线提示（「打开设置」「重试」），并且主视图始终只有一个。

**启动时自动恢复。** 退出 Obsidian 总会结束插件拉起的服务器；如果退出时它在运行，下次插件加载会按当时的运行模式再次启动（本地 → 启动目录，npm → 已安装的包）。手动「停止」或服务崩溃会清除该标记，这两种情况不会恢复。启动时若端口已有人应答，则不再启动。

**运行模式 = 本地目录（开发调试）** — 插件在「启动目录」里执行 `npm run dev`。改 Web 界面代码时用这个。

**运行模式 = npm 包（推荐）** — 插件启动已安装的 `pi-obs` 包：优先插件目录里那份（`<插件目录>/pi-obs-app`），否则全局那份。启动的前提是已经安装——启动本身不做任何安装，安装由 npm 包卡片的「安装」按钮完成，安装位置由弹窗选择。启动命令是推导出来的，不提供配置：`node "<安装目录>/node_modules/pi-obs/bin/pi-obs.js" -p <端口> --no-open`（插件目录）或 `pi-obs -p <端口>`（全局）。

两种模式都不会自行做全局安装。

##嵌入模式

插件用 `?embed=1` 加载界面。该标记以 `pi-obs:embed-mode` 为键写入 `sessionStorage`，以便客户端路由跳转后仍然保留；`components/AppShell.tsx` 每次挂载都会读取它。

嵌入期间，凡是原本会在 Web 界面右侧面板里打开的东西，都改为**交给 Obsidian，请求一个独立页面**：

| 面板 | 路由 | 查询参数 |
| --- | --- | --- |
| 文件 | `/panel/file` | `path`、`cwd`、`sourceSessionId`、`page`、`mode` |
| 终端 | `/panel/terminal` | `cwd`、`id` |
| 子智能体 | `/panel/agent` | `session`、`label` |
| 完整历史 | `/panel/history` | `session` |

请求是向父窗口发的一条 `postMessage`：

```js
{ source: "pi-obs", type: "open-panel", panel: "file", url: "http://127.0.0.1:30141/panel/file?path=…" }
```

`lib/embed-mode.ts` 刻意把 URL 拼成绝对路径：插件的文档是 `app://obsidian.md`，相对 URL 会按这个协议解析，iframe 只会得到一片空白。

插件只接受 `origin` 等于自身 base URL 的消息。每个被接受的面板成为一个 Obsidian 标签页；再次打开同一个 URL 是聚焦已有标签页，而不是新建。

另有两条消息方向相反，从文件面板发往宿主：

| 消息 | 载荷 | 用途 |
| --- | --- | --- |
| `mention-lines` | `path`、`startLine`、`endLine` | 把选中的行变成聊天里的 `@` 提及 |
| `mention` | `path`、`isDir` | 对整个文件或文件夹做 `@` 提及 |

在独立浏览器标签页里（非嵌入），`openPanel` 回退到 `window.open`，所以 `/panel/*` 路由不装 Obsidian 也能测。

## 面板标签页图标

插件直接复用 Web 界面自己的图稿。`lib/file-icon-names.ts` 把文件名映射到 Catppuccin 图标名；插件从运行中的服务取 `/icons/catppuccin/<latte|mocha>/<name>.svg`，以 `pi-obs-cat-<name>` 为 id 注册，Obsidian 深色主题选 `mocha`，浅色选 `latte`。

Obsidian 在 100×100 的画布上画图标，而这些 SVG 是按 16×16 画的。原样注册只占画布的 16% —— 在标签页尺寸下就是一个小点。插件改为把内部标记包进 `<g transform="scale(6.25)" stroke-width="1">`。终端、子智能体、完整历史面板用 Obsidian 内置的 `terminal`、`bot`、`history` 图标。

## 失败行为

- **打开视图时服务未运行** — 显示离线提示（「打开设置」「重试」），绝不给一个空白 frame，也不会自行启动服务器。主视图始终只有一个；工作区恢复留下的多余视图会在布局就绪时被移除。
- **会话中途服务挂掉** — 在端口重新应答之前不会重建 iframe。
- **停用插件** — 卸载时结束服务器。开着「退出时停止服务器」（默认）时，会停掉监听该端口的服务，包括用户手工启动的；关掉时只结束插件自己启动的进程树（Windows 用 `taskkill /T /F`，其他平台用 `kill`）。

## 发布

本仓库产出**两个产物**，版本线互相独立：

| 产物 | 发布到哪里 | 版本字段 |
| --- | --- | --- |
| 服务（`pi-obs`） | npm | `package.json`的 `version` |
| 插件（`pi-obs`） | `ItsDalk-Lane/pi-obs` 的 GitHub Release 附件 | `obsidian-plugin/manifest.json` 的 `version` |

`npm run release` 会构建两者 —— Next.js 生产构建和 `npm run build:plugin` —— 并把插件的三个文件
打进 npm 包一起发布。GitHub Release 要单独创建，因为它承载 BRAT 下载的插件附件，见 [release.md](./release.md)。

插件走 BRAT 分发，不进 Obsidian 官方社区列表。这有一个具体后果：官方列表要求 `manifest.json` 放在
**仓库根目录**，而本仓库把它放在 `obsidian-plugin/` 下。要提交进社区列表就得把插件文件移到根目录；
BRAT 没有这个要求。

**首次发布前**需要先推一次代码，仓库目前是空的：

```bash
git remote add origin https://github.com/ItsDalk-Lane/pi-obs.git
git push -u origin main
```

## 与上游的关系

上游是 `agegr` 的<https://github.com/agegr/pi-web>，MIT 许可，[LICENSE](../LICENSE) 中记录的版权为 `Copyright (c) 2026 agegr`。本分支保留该版权与许可不变，Obsidian 相关的工作是叠加式的。

与上游同步的方式是 rebase 到更新的 tag，并按「最容易被破坏」的程度复查三个集成点：

1. `components/AppShell.tsx` — 打开面板的调用必须继续走 `lib/embed-mode.ts` 的 `openPanel`。
2. `lib/file-icon-names.ts` — 插件跨仓库边界 import 它，改动导出会打断 esbuild 打包。
3. `manifest.json` 与设置面板 — 插件与库之间的契约。