// 纯 Node 冒烟：用桩环境加载 main.js，抓打包期/加载期错误。
//
// 为什么值得先跑它：Phase 0 就是靠这一步抓到 `import.meta.url` 那个会让 Obsidian 当场白屏的雷。
// 它不能替代真机验收，但能在打开 Obsidian 之前把"根本起不来"这类问题筛掉。
//
// 用法：node smoke.mjs

import { apiCall, fakeApp, installStubs, loadPluginClass } from "./stub-env.mjs";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

installStubs();
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

let PluginClass = null;
try {
  PluginClass = loadPluginClass();
  check("bundle loads in plain Node", true);
} catch (error) {
  check("bundle loads in plain Node", false, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  if (error instanceof Error && error.stack) console.error(error.stack.split("\n").slice(0, 8).join("\n"));
  process.exit(1);
}

check("default export is a plugin class", typeof PluginClass === "function", typeof PluginClass);

const plugin = new PluginClass(fakeApp(), { id: "pi-obs", dir: "obsidian-plugin", version: "0.1.0" });
try {
  await plugin.onload();
  check("onload() completes", true);
} catch (error) {
  check("onload() completes", false, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exit(1);
}

check("registers the main view", plugin.registered.has("pi-obs-main"), JSON.stringify([...plugin.registered.keys()]));
check("globalThis.fetch was taken over", globalThis.fetch !== originalFetch);
check(
  "globalThis.EventSource was replaced",
  typeof globalThis.EventSource === "function" && globalThis.EventSource !== originalEventSource,
  globalThis.EventSource?.name,
);

const list = await apiCall("GET", "/api/sessions");
check("GET /api/sessions", list.status === 200 && Array.isArray(list.body?.sessions),
  `status=${list.status} count=${list.body?.sessions?.length ?? "?"}`);

const sessions = list.body?.sessions ?? [];
if (sessions.length === 0) {
  check("GET /api/sessions/[id]", false, "no session on disk to open");
} else {
  const id = sessions[0].id;
  const one = await apiCall("GET", `/api/sessions/${encodeURIComponent(id)}`);
  check("GET /api/sessions/[id]", one.status === 200 && Boolean(one.body?.context),
    `status=${one.status} entries=${one.body?.context?.messages?.length ?? "?"}`);

  const state = await apiCall("GET", `/api/sessions/${encodeURIComponent(id)}/state`);
  check("GET /api/sessions/[id]/state", state.status === 200, `status=${state.status} running=${state.body?.running}`);
}

const running = await apiCall("GET", "/api/agent/running");
check("GET /api/agent/running", running.status === 200 && Array.isArray(running.body?.runningSessionIds), `status=${running.status}`);

const home = await apiCall("GET", "/api/home");
check("GET /api/home", home.status === 200 && typeof home.body?.home === "string", `status=${home.status}`);

const unmapped = await apiCall("GET", "/api/definitely-not-migrated");
check("unmapped /api/ route degrades to 501", unmapped.status === 501, `status=${unmapped.status}`);

try {
  plugin.onunload();
  check("onunload() completes", true);
} catch (error) {
  check("onunload() completes", false, error instanceof Error ? error.message : String(error));
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
