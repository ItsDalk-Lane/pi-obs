// 直连 Obsidian 的调试端口，读控制台、启用 pi-obs、打开视图 —— 把真实报错抓出来。
//
// 为什么需要它：纯 Node 冒烟和 jsdom 渲染都跑通了，但 Obsidian 自己的插件加载环境
// 无法在仓库里复现。与其让你描述现象，不如直接接上调试协议看。
//
// 用法：
//   1) 完全退出 Obsidian（不是关窗口）
//   2) "C:\Users\<你>\AppData\Local\Programs\Obsidian\Obsidian.exe" --remote-debugging-port=9222
//   3) node spike/obsidian-cdp.mjs [pluginId]
//
// 端口可用 PI_OBS_CDP_PORT 改。脚本只读 + 启用插件，不改动你的笔记。

import http from "node:http";

const PORT = Number(process.env.PI_OBS_CDP_PORT ?? 9222);
const PLUGIN_ID = process.argv[2] ?? "pi-obs";

/** 注意：必须绕开系统代理，本机 127.0.0.1 的调试端口走代理会 502。 */
function httpGetJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: pathname, timeout: 4000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(new Error(`${pathname}: ${body.slice(0, 200)}`)); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("debug port timed out")));
    req.on("error", reject);
  });
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.logs = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
        return;
      }
      this.#handleEvent(message);
    });
  }

  #handleEvent(message) {
    const { method, params } = message;
    if (method === "Runtime.consoleAPICalled") {
      const text = (params.args ?? []).map((arg) => arg.value ?? arg.unserializableValue ?? arg.description ?? `<${arg.type}>`).join(" ");
      this.logs.push(`[${params.type}] ${text}`);
    } else if (method === "Runtime.exceptionThrown") {
      const details = params.exceptionDetails ?? {};
      const description = details.exception?.description ?? details.text ?? "";
      this.logs.push(`[exception] ${description}`);
    } else if (method === "Log.entryAdded") {
      const entry = params.entry ?? {};
      this.logs.push(`[log:${entry.level}] ${entry.text ?? ""}`);
    }
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 30_000);
    });
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
      includeCommandLineAPI: true,
    });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      return { error: details.exception?.description ?? details.text };
    }
    return { value: result.result?.value };
  }
}

async function main() {
  console.log(`CDP: 连接 127.0.0.1:${PORT} …`);
  const targets = await httpGetJson("/json/list");
  const page = targets.find((target) => target.type === "page") ?? targets[0];
  if (!page?.webSocketDebuggerUrl) {
    console.error("找不到调试目标。请确认 Obsidian 是用 --remote-debugging-port=9222 启动的。");
    process.exit(1);
  }
  console.log(`CDP: 目标 ${page.title} — ${page.url}`);

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", (event) => reject(new Error(`WebSocket 失败：${event.message ?? "unknown"}`)), { once: true });
  });
  const cdp = new Cdp(socket);
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");

  const step = async (label, expression) => {
    const outcome = await cdp.evaluate(expression);
    console.log(`\n=== ${label} ===`);
    console.log(outcome.error ? `  ✗ ${outcome.error}` : `  ${JSON.stringify(outcome.value)}`);
    return outcome;
  };

  await step("Obsidian 版本", "app.version ?? (window.app && window.app.version) ?? 'unknown'");
  await step("已安装插件的 manifest", `Object.keys(app.plugins.manifests).filter((id) => id.includes("pi-obs"))`);
  await step("已启用的插件实例", `Object.keys(app.plugins.plugins).filter((id) => id.includes("pi-obs"))`);
  await step("enabledPlugins 集合", `[...(app.plugins.enabledPlugins ?? [])].filter((id) => String(id).includes("pi-obs"))`);
  await step("manifest 内容", `JSON.stringify(app.plugins.manifests["${PLUGIN_ID}"] ?? null)`);

  await step(
    `启用 ${PLUGIN_ID}`,
    `(async () => {
       try {
         await app.plugins.enablePlugin("${PLUGIN_ID}");
         return "enablePlugin 返回正常；实例存在=" + Boolean(app.plugins.plugins["${PLUGIN_ID}"]);
       } catch (error) {
         return "enablePlugin 抛错: " + (error && error.stack ? error.stack : String(error));
       }
     })()`,
  );

  await step(
    `打开 pi-obs-main 视图`,
    `(async () => {
       try {
         const leaf = app.workspace.getLeaf("tab");
         await leaf.setViewState({ type: "pi-obs-main", active: true });
         await new Promise((r) => setTimeout(r, 2500));
         const host = document.querySelector(".pi-obs-host");
         return "视图已设置；host=" + (host ? "存在，子元素 " + host.querySelectorAll("*").length + " 个" : "不存在")
           + "；文本=" + JSON.stringify((host ? host.textContent : document.body.textContent).replace(/\\s+/g, " ").slice(0, 300));
       } catch (error) {
         return "打开视图抛错: " + (error && error.stack ? error.stack : String(error));
       }
     })()`,
  );

  await step(
    "全局 fetch / EventSource 是否被接管",
    `JSON.stringify({
       fetchName: globalThis.fetch && globalThis.fetch.name,
       fetchHasApiWrapper: /parsed/.test(String(globalThis.fetch)),
       eventSourceName: globalThis.EventSource && globalThis.EventSource.name,
     })`,
  );

  await new Promise((resolve) => setTimeout(resolve, 1500));

  console.log(`\n=== 渲染进程控制台（${cdp.logs.length} 条）===`);
  for (const line of cdp.logs) console.log("  " + line.slice(0, 500));

  console.log("\n完成。");
  socket.close();
  process.exit(0);
}

main().catch((error) => {
  console.error(`失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
