# C2 原生插件：Phase 0 实测报告

> 目标：把 Pi Obs 从「外部服务器 + iframe」重构为**单 `main.js` 的原生 Obsidian 插件**——无服务器进程、无 iframe、无 HTTP 端口。
>
> 本文记录 Phase 0 在真实 Obsidian 里跑出来的实测结论。所有数字来自实际运行，不是推断。
> 验证插件源码在 `spike/`，属一次性产物，进入阶段 1 后可整目录删除。

## 总结论

**方案 C2 可行。** 五个未知项全部实测通过，其中两个被推翻了原先的判断（见下）。

## 实测环境

| 项 | 实测值 |
| --- | --- |
| Obsidian | 1.12.7（安装器 Electron **39.8.3**） |
| 渲染进程 Node | **22.22.1**（满足 pi SDK 要求的 ≥ 22.19） |
| Node ABI / NAPI | 140 / 10 |
| `require` | 可用（Node 集成开启） |
| `http` / `https` 模块 | 可用 |
| Worker 线程 | `Worker` 类存在，但**构造即失败**（见下） |
| 测试 vault | `Desktop/0` |

## 五项验证结果

| # | 验证项 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | pi SDK 在渲染进程内建会话、发消息、收事件 | ✅ | 会话创建成功，事件流完整 |
| 2 | 真实 LLM 对话（本机 LM Studio / qwen3.8-27b） | ✅ | **1571ms，36 条 `message_update`，回复「成功」** |
| 3 | 网络层修法（自写 fetch shim） | ✅ | 直连 200（1446ms）；流式 30 chunks / 8042 bytes |
| 4 | 终端 | ⚠️ 降级可用 | `node-pty` 不可用；`child_process` 管道 297ms 通过 |
| 5 | React 19.2.4 挂 ItemView | ✅ | 渲染 / 异步 setState / 事件委托 / 原生事件四条路径全通 |

## 被推翻的两个判断

### 1. node-pty 不需要重编译，但也救不回来

原判断：需要按 Electron ABI 重新编译。**错**——它是 NAPI 编译（`.node` 在 ABI 140 下加载成功，跨版本兼容）。

真死因：`ERR_MISSING_PLATFORM_FOR_WORKER` —— Electron 渲染进程的 Node **不支持 Worker 线程**，而 node-pty 1.2.0-beta.15 在 Windows 上靠 Worker 跑 conout 连接，`windowsConoutConnection.js` 里无条件 `new Worker()`，**没有回退开关**。

结论：**终端降级为 `child_process` 管道模式**。xterm 界面照用，能跑命令、看输出；失去交互式程序（vim 等）与窗口 resize。

### 2. 网络层用 undici 也不行

原判断：把 `globalThis.fetch` 换成 undici 即可。**错**——
`TypeError: fetch failed | cause: fastNowTimeout?.unref is not a function`
渲染进程里的 `setTimeout` 是 **DOM 版**，`typeof timer.unref === "undefined"`，undici 的定时器直接崩。

同时确认 Chromium fetch 的失败原因：`TypeError: Failed to fetch`（5ms）——页面来源是 `app://obsidian.md`，受 CORS / 混合内容限制，连本机 `127.0.0.1` 都不通。

## 最终修法：自写 fetch shim

**源码**：`spike/node-fetch-shim.ts`（进入阶段 1 时迁入 `obsidian-plugin/`）

**为什么只需满足标准 `Response` 契约**：本项目的 provider 是 `api: "openai-completions"`，pi-ai **不用裸 fetch**，而是走官方 OpenAI SDK（`client.chat.completions.create().withResponse()`）。所以只要给它一个标准 `Response`，整条链路就通。

**原理**：

- 用 `node:http` / `node:https` 发请求 —— 绕开 Chromium 网络栈（CORS 的来源）
- 借浏览器环境现成的 `Response` / `Headers` / `ReadableStream` 包装结果 —— 绕开 undici 的定时器坑，且下游拿到的是完全标准的对象
- 支持：method / headers / body / AbortSignal / 重定向跟随 / gzip-deflate-br 自动解压

**两个实现陷阱（都踩过）**：

1. **背压必须靠 `pull()` 恢复**。只在 `data` 回调里 `pause()` 而无处 `resume()` 会**静默死锁**——进程 exit 0 且无任何输出，极难排查。正确写法：`start` 里 `pause`、`pull` 里 `resume`。
2. 打包时 `--define:import.meta.url` 的值**必须是含盘符的合法 Windows file URL**（`file:///C:/...`）。写成 `file:///probe.js` 会在 `fileURLToPath` 处抛 `ERR_INVALID_FILE_URL_PATH`。

## 打包命令（阶段 1 直接复用）

```bash
esbuild main.ts --bundle --platform=node --format=cjs --target=es2022 \
  --external:obsidian --external:electron \
  --define:import.meta.url='"file:///C:/.../<插件目录>/main.js"' \
  --outfile=main.js
```

**必带 `--define:import.meta.url`**：pi SDK 的 ESM 代码在模块顶层就依赖 `import.meta.url`（11 处），打成 CJS 后为 `undefined`，**加载即崩**。这是阶段 0 抓到的第一个会在 Obsidian 里当场白屏的雷。

## 阶段 0 之后确定的架构取舍

| 部件 | 处置 |
| --- | --- |
| `app/api/**` 65 个路由 | 迁为进程内服务层，保留 path+method 形状做同签名调度表 |
| SSE 事件流 | 直接 `session.subscribe()`，去掉 HTTP 皮 |
| iframe / `?embed=1` / `openPanel` postMessage | 删除，改为 Obsidian 原生标签页 |
| `/panel/{file,terminal,agent,history}` | 注册为 4 种 ItemView |
| `bin/`、`proxy.ts`、登录、PWA、LAN 模式 | 删除 |
| npm 包发行线 | 废止，只剩 `manifest.json` 一条版本线 |
| `~/.pi/agent/sessions` | 原样不动，与 pi 终端继续共用 |

## 下一步：阶段 1

主视图 ItemView + 服务层最小闭环（会话列表 → 发消息 → 收回复）。详见阶段 1 开工时的计划。
