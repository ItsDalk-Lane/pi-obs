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
  manifest.json      插件元数据（id `pi-web`，仅桌面端，要求 Obsidian >= 1.5.0）
  main.ts            插件本体：视图、服务生命周期、设置面板
  main.js            esbuild 产物（已 git 忽略）
  styles.css         iframe 尺寸、连接中与断线状态
  esbuild.config.mjs 打包：main.ts + ../lib/file-icon-names.ts -> main.js
  package.json       仅插件自身的 devDependencies（obsidian、esbuild、typescript）
```

`lib/file-icon-names.ts` 位于分支的**Web 侧**，插件直接import 它。该文件是纯数据和函数 —— 没有 JSX、没有 React —— 所以 esbuild 可以把同一份映射打进 `main.js`，两侧的图标表不会各自漂移。

## 构建与安装

插件除了 esbuild 没有额外构建步骤。在仓库根目录：

```bash
npm install
npm run build                       # 服务要用的 Next.js 生产构建

cd obsidian-plugin
npm install
npm run build                       # 先 tsc --noEmit，再 esbuild -> main.js
```

然后把 `main.js`、`manifest.json`、`styles.css` 复制到库（vault）的插件目录：

```text
<vault>/.obsidian/plugins/pi-web/
  main.js
  manifest.json
  styles.css
```

`main.js` 已被 git 忽略，因此它在本地生成而不是提交进仓库。在**设置 → 第三方插件**中启用。侧边栏功能区会出现一个机器人图标，命令面板里是 **Pi Web: Open Pi Web**。

Obsidian 只在桌面应用里加载插件，所以 `manifest.json` 设了 `isDesktopOnly: true`。

## 设置

**设置 → Pi Web**。

| 设置项 | 默认值 | 含义 |
| --- | --- | --- |
| Pi Web directory | *(空)* | 要运行的代码目录。启动命令在**该目录**里执行，这是开发模式：指向一个 clone，改代码即时热更新。 |
| Start command | `npm run dev` | 启动服务的 shell 命令。仅在设置了目录时读取。 |
| Pi Web package | `pi-obs` | 安装到插件目录里的 npm 包。仅在未设置目录时读取。 |
| Port | `30141` | 服务监听端口，必须与启动命令或插件传入的端口一致。 |
| Start Pi Web automatically | 开 | 视图打开而端口无响应时，自动（首次）安装并启动服务。 |
| Panel placement | New tab | 文件、终端、子智能体、完整历史面板打开的位置：主区域的新标签页，或右侧栏的标签页。 |

### 服务的两种提供方式

**设置了目录** — 插件在该目录里执行启动命令，等待端口响应最多90 秒。改 Web 界面代码时用这个。

**目录为空** — 插件在启用时把 `packageName` 安装到 `<插件目录>/pi-web-app`，并用 `node …/bin/pi-web.js -p <端口> --no-open` 启动。插件目录之外不留任何东西，删掉插件目录就连服务一起删掉。首次安装要拉 `next` 和 `node-pty`，所以这里的等待上限是 300 秒。

##嵌入模式

插件用 `?embed=1` 加载界面。该标记以 `pi-web:embed-mode` 为键写入 `sessionStorage`，以便客户端路由跳转后仍然保留；`components/AppShell.tsx` 每次挂载都会读取它。

嵌入期间，凡是原本会在 Web 界面右侧面板里打开的东西，都改为**交给 Obsidian，请求一个独立页面**：

| 面板 | 路由 | 查询参数 |
| --- | --- | --- |
| 文件 | `/panel/file` | `path`、`cwd`、`sourceSessionId`、`page`、`mode` |
| 终端 | `/panel/terminal` | `cwd`、`id` |
| 子智能体 | `/panel/agent` | `session`、`label` |
| 完整历史 | `/panel/history` | `session` |

请求是向父窗口发的一条 `postMessage`：

```js
{ source: "pi-web", type: "open-panel", panel: "file", url: "http://127.0.0.1:30141/panel/file?path=…" }
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

插件直接复用 Web 界面自己的图稿。`lib/file-icon-names.ts` 把文件名映射到 Catppuccin 图标名；插件从运行中的服务取 `/icons/catppuccin/<latte|mocha>/<name>.svg`，以 `pi-web-cat-<name>` 为 id 注册，Obsidian 深色主题选 `mocha`，浅色选 `latte`。

Obsidian 在 100×100 的画布上画图标，而这些 SVG 是按 16×16 画的。原样注册只占画布的 16% —— 在标签页尺寸下就是一个小点。插件改为把内部标记包进 `<g transform="scale(6.25)" stroke-width="1">`。终端、子智能体、完整历史面板用 Obsidian 内置的 `terminal`、`bot`、`history` 图标。

## 失败行为

- **打开视图时服务未运行** — 显示重试按钮，绝不给一个空白 frame。工作区在重启期间被恢复就会走到这条路径。
- **会话中途服务挂掉** — 在端口重新应答之前不会重建 iframe。
- **停用插件** — 卸载时结束它自己启动的进程树（Windows 用 `taskkill /T /F`，其他平台用 `kill`）。用户手工启动的服务不受影响。

## 发布

`pi-obs` 是本分支要发布到 npm 的包名（`package.json` 的 `bin` 声明）。发布后，插件的两种安装方式都可用：

- **Pi Web directory留空** —— 插件在启用时自动 `npm install pi-obs` 到自己的目录，用户无需手动装任何东西。
- **Pi Web directory 指向本仓库的 clone**（<https://github.com/ItsDalk-Lane/pi-obs>）—— 开发模式，改代码即时热更新。

发布流程见 [release.md](./release.md)。该清单原本是上游针对 `@agegr/pi-web` 和 `agegr/pi-web` Release
写的，其中的 `--repo` 已改成本仓库 `ItsDalk-Lane/pi-obs`，可以照着跑。

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