# C2 原生 Obsidian 插件：迁移计划书

> 目标：把 Pi Obs 从「外部服务器 + iframe」重构为**单 `main.js` 的原生 Obsidian 插件**——
> 无服务器进程、无 iframe、无 HTTP 端口、不依赖用户安装 Node.js。
>
> 前置：Phase 0 全部未知项已实测通过，见 [c2-phase0-spike.md](c2-phase0-spike.md)。
> 本文是执行计划；每阶段结束都可独立运行、可提交、可回退。

---

## 0. 范围：做什么，不做什么

**做**

- 消灭外部服务器进程与 iframe，UI 挂进 Obsidian 原生标签页
- 65 个 API 路由转为进程内服务层调用
- 单版本线（只留 `manifest.json`），BRAT 装完即用

**不做（本轮明确排除）**

- 不重写界面。现有 React 界面（约 39k 行）整体保留，外观不变
- 不跟随上游 `agegr/pi-web` 同步（用户已拍板）
- 不做浏览器互通（`/panel/*` 独立路由、`?embed=1`、postMessage 协议最终删除）
- 不做 UI 的 Obsidian 原生化（配色/控件改成 Obsidian 风格）——那是更后面的独立议题

---

## 1. 现状盘点（实测数字，非估算）

| 项 | 实测值 | 对迁移的含义 |
| --- | --- | --- |
| API 路由 | 65 个 `route.ts`，合计 6501 行 | 迁移面清晰可数 |
| 路由厚度 | 薄壳，业务逻辑在 `lib/`（如 `rpc-manager.ts` 2691 行） | **真正要改的是包装层，业务逻辑基本不动** |
| UI 调用点 | **32 个文件、121 处 `fetch("/api/...")`** | 散落但形态统一 → 可单点接管 |
| SSE | 4 个文件用 `EventSource`（`FileViewer`、`ModelsConfig`、`TerminalPanel`、`hooks/useAgentSession`） | 需替身或改写（共 8 处） |
| UI 对 Next 的依赖 | 仅 `components/AppShell.tsx` 一处 | 去 Next 化成本极低 |
| UI 根组件 | `app/page.tsx` = `I18nProvider` + `AppShell` | 挂载目标明确 |
| 面板路由 | 4 个：`agent` / `file` / `history` / `terminal` | 对应 4 种 ItemView |
| 插件入口现状 | `obsidian-plugin/main.ts` 1248 行，主体是服务器生命周期管理 | 这一大块将被删除 |
| React | 19.2.4，已在 Obsidian 内实测四条路径全通 | 无风险 |
| 会话数据 | `~/.pi/agent/sessions/*.jsonl` | **不动**，与 pi 终端共用 |

---

## 2. 目标架构

四层，全部运行在同一个 Obsidian 进程内：

```
┌─ UI 层        components/ + hooks/ 原样保留，挂进 ItemView
├─ 接入层        fetch 拦截 + EventSource 替身（唯一改动点）
├─ 服务层        原 65 个路由的处理器，按 path + method 调度
├─ 引擎层        lib/rpc-manager、session-reader、terminal-manager…（原样保留）
└─ 平台适配层    fetch shim、Obsidian API、fs/vault 访问
```

**关键：UI 层与接入层之间只有两个接触面**（`fetch` 与 `EventSource`）。把这两个面接管住，39k 行界面代码一行都不用改。

---

## 3. 关键技术决策（含理由与备选）

### D1. UI 接入：拦截 `fetch` + 提供 `EventSource` 替身（推荐）

在插件初始化时接管这两个浏览器 API：

- `fetch("/api/...")` → 直接调用服务层，返回标准 `Response`
- `new EventSource("/api/.../events")` → 返回一个替身对象，内部订阅进程内事件流，照常派发 `message` 事件

**理由**：121 处调用点 + 8 处 SSE 全部不用改；界面逻辑零风险。

**备选**：逐处把 `fetch` 换成 `api()` 辅助函数。更"干净"（不动全局），但 121 处改动、回归面大，且每次上游/本地改动都要同步。**不推荐**。

**风险控制**：拦截器只认 `/api/` 前缀，其余请求原样转发给浏览器（再转 shim），不影响 Obsidian 自身与其他插件。

### D2. 服务层：保留 path + method 形状的调度表

把 65 个路由的处理逻辑抽成 `(request) => Response` 形式的处理器，注册进一张调度表。
过渡期 Next 路由退化成"转发到处理器"的薄壳，保证浏览器版继续可用，直到阶段 4 再删。

### D3. 网络层：自写 fetch shim（已在 Phase 0 验证）

`node:http/https` 发请求 + 浏览器 `Response`/`Headers`/`ReadableStream` 包装。
源码现位于 `spike/node-fetch-shim.ts`，阶段 1 迁入 `obsidian-plugin/`。
**必带打包参数** `--define:import.meta.url='"file:///C:/.../main.js"'`（含盘符），否则 pi SDK 加载即崩。

### D4. 终端：降级为 `child_process` 管道模式

`node-pty` 在渲染进程不可用（不支持 Worker 线程，无回退开关）。
替代：起常驻 shell 进程 + stdio 管道 + xterm 显示；UI 提供"停止"按钮替代 Ctrl+C。
代价：失去 vim/htop 这类交互式与全屏程序、进度条与颜色默认关闭、窗口宽度固定。

### D5. 稳定性：服务层统一错误围栏

引擎崩溃的风险从"崩服务器"变成"可能带崩 Obsidian"。对策：
所有服务层入口包一层 try/catch，异常转成标准错误响应 + 通知，绝不让异常冒泡到 Obsidian 的事件循环。
会话本身实时落盘在 `~/.pi/agent`，即使崩溃，损失面与现在服务器崩溃等同（重启即恢复）。

### D6. 配置与密钥：不引入新的配置体系

继续读 `~/.pi/agent/models.json` / `settings.json`，不在插件里另建设置存储、不硬编码任何密钥。
插件自己的设置项（视图相关）走 Obsidian 的 `loadData/saveData`。

---

## 4. 目录调整（目标态）

```
obsidian-plugin/
  main.ts              启动、视图注册、命令、设置（由 1248 行瘦身为数百行）
  platform-fetch.ts    fetch shim（从 spike/ 迁入）
  api-dispatch.ts      fetch 拦截 + EventSource 替身（接入层，唯一 UI 接触面）
  services/            原 app/api/** 的处理器 + 调度表
  views/               4 个面板 ItemView + 主视图
  styles.css
lib/                   业务逻辑不动（rpc-manager、session-reader…）
components/ hooks/     UI 不动
（阶段 4 删除：app/api/**、app/panel/**、bin/、proxy.ts、lib/embed-mode.ts、登录/PWA/LAN 相关）
```

---

## 5. 分阶段计划

每阶段都有**可验证的验收标准**；验证顺序固定为「先纯 Node 冒烟 → 再 Obsidian 实跑」，把你重启 Obsidian 的次数压到最少（每阶段 1 次左右）。

### 阶段 1：骨架与最小闭环（体量：中）

**目标**：在 Obsidian 里真正跑通"打开会话 → 发消息 → 看回复"。

任务

1. 把 `spike/node-fetch-shim.ts` 迁入 `obsidian-plugin/platform-fetch.ts`，插件加载时接管 `globalThis.fetch`
2. 实现 `api-dispatch.ts`：路由前缀判断 + 调度表骨架
3. 迁移首批最小路由：`GET /api/sessions`、`GET /api/sessions/[id]`、`POST /api/agent/new`、`POST /api/agent/[id]`、`GET /api/agent/[id]/events`
4. `EventSource` 替身：先只支持 agent events（内部用 `session.subscribe()`）
5. 主视图 ItemView：挂载 `I18nProvider` + `AppShell`；移除 `AppShell` 里对 Next 的那一处依赖
6. 装进测试 vault 实跑

**验收**：Obsidian 里能列出历史会话、打开一个会话、发一句话、看到流式回复；不崩、不卡 UI。

### 阶段 2：服务层全量迁移（体量：大）

**目标**：65 个路由全部可用。

任务

1. 按路由分组批量迁移处理器（`sessions` / `agent` / `files` / `git` / `worktrees` / `mcp` / `auth` / `tools` / `terminal` / `ui-state` …）
2. `EventSource` 替身补齐：文件监听（改用 `fs.watch`）、终端事件、OAuth 登录流
3. Next 侧路由改为转发薄壳，浏览器版继续可用（保住对照基线）
4. 错误围栏落地 + 统一日志

**验收**：在 Obsidian 里逐个走查功能清单（见第 7 节），全部可用；浏览器版回归无差异。

### 阶段 3：面板 ItemView 化（体量：中）

**目标**：4 个面板变成 Obsidian 原生标签页。

任务

1. 注册 `agent` / `file` / `history` / `terminal` 四种 ItemView，参数从 query string 改为构造参数，逻辑复用现有组件
2. 删除 `lib/embed-mode.ts` 的 `openPanel` postMessage 调用，改为打开标签页
3. 终端面板切到管道模式，补"停止"按钮

**验收**：四个面板都能在新标签页打开并正常工作；终端能跑命令看输出、能停止。

### 阶段 4：清理与单版本线（体量：中）

**目标**：只剩一个发行物。

任务

1. 删除：`app/api/**`、`app/panel/**`、`bin/`、`proxy.ts`、`lib/embed-mode.ts`、登录/PWA/LAN/web-push 相关代码与文档
2. 设置页瘦身：删掉"服务器状态""npm 包"卡片
3. npm 包发行线废止，版本只剩 `manifest.json`；产出 GitHub Release 流程文档
4. 重写 `docs/obsidian.md`，删除四份 README 里关于 npm/浏览器的安装说明

**验收**：`npm run build:plugin` 产出单一 `main.js`；BRAT 从 Release 安装后开箱即用（无需任何额外环境）。

### 阶段 5：加固与收尾（体量：中）

任务

1. 实测 `main.js` 体积与加载耗时；必要时 esbuild 分片 + 懒加载重屏
2. 长任务不阻塞 UI 的验证（跑一个大任务时 Obsidian 仍可操作）
3. 崩溃恢复验证（强杀后重启 Obsidian，会话完好）
4. 清理：删除 `spike/` 目录与测试插件

**验收**：冷启动耗时可接受、大任务期间 UI 不卡、崩溃后可恢复。

---

## 6. 验证策略（尽量少打扰你）

1. **纯 Node 冒烟**：用桩模块加载 bundle，抓打包期/加载期错误（已在 Phase 0 证明有效，它抓到了 `import.meta.url` 那个必崩的雷）
2. **纯 Node 端到端**：用脚本驱动服务层跑真实调用（Phase 0 已验证 pi SDK 链路）
3. **Obsidian 实跑**：每个阶段末才需要你做一次「完全退出 → 重开 → 跑命令/点按钮」，预计全程 4~5 次

---

## 7. 功能验收清单（阶段 2 末逐条走查）

- 会话：列表、打开、新建、重命名、删除、导出、分叉、搜索、归档/置顶
- 对话：发送、流式回复、中断、自动重试、模型切换、思考级别、工具调用展示
- 文件：浏览、读取、上传、下载、预览、@ 提及、文件索引
- Git：状态、diff、worktree 管理
- 终端：创建、输入输出、停止、多会话
- MCP：服务器列表、启停、测试、登录
- 设置：模型/Provider 配置、默认工具、项目信任、界面偏好
- 扩展 UI：pi 扩展弹出的交互（dialog / select / confirm）正常显示

---

## 8. 风险清单

| 风险 | 等级 | 对策 | 触发后怎么办 |
| --- | --- | --- | --- |
| 引擎异常带崩 Obsidian | 高 | 服务层统一错误围栏 + 结构化日志 | 已隔离在 `engine/`，必要时退回子进程方案 |
| 打包体积过大导致启动慢 | 中 | 阶段 5 实测，必要时分片 + 懒加载 | 拆分 release 附件 |
| 拦截 `fetch` 影响其他插件 | 中 | 只处理 `/api/` 前缀，其余原样转发 | 改为逐点替换（D1 备选方案） |
| 长任务卡住 Obsidian UI | 中 | 阶段 5 实测；必要时把重活切片 | 退回子进程跑引擎 |
| 65 个路由迁移面大、易漏 | 中 | 按分组迁移 + 功能清单逐条走查 | — |
| SSE 替身行为与浏览器不一致 | 低 | 按现有 SSE 报文格式派发事件 | 个别组件改写 |
| 用户的 Obsidian 安装器偏旧（Electron < 39） | 低 | 用最新安装器重装一次（一次性） | Node 版本不满足则整体方案需重评 |

---

## 9. 遗留与将来可选项

- **完整终端**：若将来确实需要 vim 这类程序，可让终端跑在独立子进程里（那里无 Worker 限制）。代价是插件需附带一个几十 MB 的运行环境，**会牺牲"装完即用"这个最大收益**，因此不进本轮。
- **界面逐步原生化**：本轮保持现有外观。之后可按屏幕逐个换成 Obsidian 原生控件，属独立议题。
- **`lib/pi-sdk-internals.ts`**：用 `pathToFileURL` 动态 import SDK 未导出模块并做同实例校验，是 SDK 升级时最易碎的点，**不参与打包**，须在阶段 1 明确其加载方式。

---

## 10. 需要你拍板的三点

1. **接入方式**：推荐「拦截 fetch + EventSource 替身」（界面零改动）。若你更在意"绝不动全局对象"，则改为逐处改写 121 个调用点，工期显著变长。
2. **终端**：推荐先按降级版做（能跑命令看结果，无 vim）。若你第一版就不需要终端，可先整块跳过，阶段 3 直接不做。
3. **旧版本保留时机**：推荐保留浏览器/服务器版到阶段 3 结束再删，全程有对照基线可回退。
