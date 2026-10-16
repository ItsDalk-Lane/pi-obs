// 敌意环境回归测试：复刻真机上让插件加载失败的两个条件。
//
// 真机报错（2026-10-15）：
//   Plugin failure: pi-obs Error: Invalid package
//     C:\Users\Its_D\AppData\Local\Programs\Obsidian\resources\electron.asar
//     at ... pi-coding-agent/dist/config.js
//
// 机制：插件里看到的 __filename 落在 Electron 的 electron.asar 里，而那里有 Electron 自己的
// package.json，于是 SDK 的 getPackageJsonPath() 指向 asar 内部文件，Electron 拒绝读 asar →
// 抛的不是 ENOENT，SDK 的容错接不住 → 加载失败。
//
// 本测试把这两个条件造出来：
//   1) main.js 放在 <scratch>/resources/electron.asar/plugins/pi-obs/ 下（路径含 .asar）
//   2) 该 .asar 目录里放一个 package.json（Electron 也有）
//   3) 同时给出 Obsidian 的 vault 路径，让引导段能算出真位置
//
// 断言的不变量：引导段算出的 import.meta 等价 URL **绝不能落在 .asar 里**。
// Node 里没有 Electron 的 asar fs，复现不出最终的 "Invalid package" 抛错，
// 所以这里守的是"不走进那条路"的前置条件 —— 那才是根因。

import { existsSync } from "node:fs";
import { cp, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const scratch = await mkdtemp(path.join(os.tmpdir(), "pi-obs-hostile-"));
const asarPluginDir = path.join(scratch, "resources", "electron.asar", "plugins", "pi-obs");
const vaultPluginDir = path.join(scratch, "vault", ".obsidian", "plugins", "pi-obs");
await mkdir(asarPluginDir, { recursive: true });
await mkdir(vaultPluginDir, { recursive: true });

// Electron 的 electron.asar 里有 package.json —— 这正是让 SDK 走错路的东西。
await writeFile(path.join(scratch, "resources", "electron.asar", "package.json"), JSON.stringify({ name: "electron", version: "0.0.0" }));

const bundle = path.join(here, "main.js");
for (const target of [asarPluginDir, vaultPluginDir]) {
  await cp(bundle, path.join(target, "main.js"));
}
for (const name of ["stub-env.mjs"]) {
  await cp(path.join(here, name), path.join(asarPluginDir, name));
}

console.log(`scratch: ${scratch}`);
console.log(`  插件被放在 asar 路径下: ${asarPluginDir}`);
console.log(`  Obsidian 真实位置:      ${vaultPluginDir}`);

// 这是"敌意条件确实成立"的证据：单纯用 __filename 会得到一个 .asar 路径。
const naiveUrl = pathToFileURL(path.join(asarPluginDir, "main.js")).href;
check(
  "敌意条件成立（__filename 落在 .asar 内）",
  /\.asar([\\/]|$)/i.test(fileURLToPath(naiveUrl)),
  naiveUrl,
);

// 用真机同款方式加载：从 asar 目录里 require，并给出 Obsidian 的 vault 路径。
globalThis.app = { vault: { adapter: { getBasePath: () => path.join(scratch, "vault") } } };

const { installObsidianStubs } = await import(pathToFileURL(path.join(asarPluginDir, "stub-env.mjs")).href);
installObsidianStubs();

const requireFromAsar = createRequire(path.join(asarPluginDir, "throwaway.cjs"));
let PluginClass = null;
try {
  PluginClass = requireFromAsar(path.join(asarPluginDir, "main.js")).default;
  check("bundle 在 asar 路径下仍能加载", true);
} catch (error) {
  check("bundle 在 asar 路径下仍能加载", false, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
}

const meta = globalThis.__PI_OBS_IMPORT_META;
check("引导段产出了 import.meta 等价物", Boolean(meta && typeof meta.url === "string"));
if (meta) {
  check("算出的 URL 避开了 .asar", !/\.asar([\\/]|$)/i.test(meta.url), meta.url);
  const expected = pathToFileURL(path.join(vaultPluginDir, "main.js")).href;
  check("算出的 URL 指向 Obsidian 里的真实插件位置", meta.url === expected, `期望 ${expected}`);
  check("dirname 指向插件目录", meta.dirname === vaultPluginDir, String(meta.dirname));
  check(
    "resolve() 返回 file URL（真机 import.meta.resolve 的契约）",
    (() => {
      try { return meta.resolve("path").startsWith("file://"); } catch { return false; }
    })(),
  );
}

if (PluginClass) {
  const plugin = new PluginClass(
    { vault: { adapter: { getBasePath: () => path.join(scratch, "vault") } },
      workspace: { layoutReady: true, onLayoutReady: (cb) => cb(), getLeavesOfType: () => [], getLeaf: () => ({ setViewState: async () => {}, detach() {} }), revealLeaf: async () => {} } },
    { id: "pi-obs", dir: ".obsidian/plugins/pi-obs", version: "0.1.0" },
  );
  try {
    await plugin.onload();
    check("onload() 在敌意环境下完成", true);
    plugin.onunload();
  } catch (error) {
    check("onload() 在敌意环境下完成", false, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }
}

// --- 退化分支：拿不到 Obsidian 的 app（引导段的第 3 条路）-------------------------
// 这条也必须避开 .asar：只要落在 .asar 里，SDK 就会去读 Electron 的 package.json 而致命。
delete globalThis.app;
delete globalThis.__PI_OBS_IMPORT_META;
delete requireFromAsar.cache[requireFromAsar.resolve(path.join(asarPluginDir, "main.js"))];
requireFromAsar(path.join(asarPluginDir, "main.js"));
const fallbackMeta = globalThis.__PI_OBS_IMPORT_META;
check("拿不到 app 时仍产出了 import.meta 等价物", Boolean(fallbackMeta && typeof fallbackMeta.url === "string"));
if (fallbackMeta) {
  check("兜底 URL 也避开了 .asar", !/\.asar([\\/]|$)/i.test(fallbackMeta.url), fallbackMeta.url);
  // SDK 的容错分支只接受 ENOENT，所以兜底目录下必须没有 package.json。
  const fallbackPkg = path.join(fallbackMeta.dirname ?? "", "package.json");
  check(
    "兜底目录下确实没有 package.json（SDK 会拿到 ENOENT 而不是别的错）",
    !existsSync(fallbackPkg),
    fallbackPkg,
  );
}

// --- 敌意条件 2：Electron 渲染进程"能 require worker_threads，但造不出 Worker" -----
//
// Phase 0 实测：渲染进程里 `new (require("node:worker_threads").Worker)()` 抛
// ERR_MISSING_PLATFORM_FOR_WORKER（node-pty 就是死在这上面）。pi 的 codemode 沙箱
// 与图片缩放都用这个 API。
//
// 注意区别：**模块本身能 require**（真机那次插件加载成功了，说明 require 没问题），
// 只有构造 Worker 才失败。所以这里只让 Worker 构造函数抛错，而不是让 require 抛错 ——
// 后者会把 bundle 直接拦在加载期，那是比真机更严苛的、不真实的场景。
const Module = createRequire(import.meta.url)("module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const loaded = originalLoad.call(this, request, parent, isMain);
  if (request === "node:worker_threads" || request === "worker_threads") {
    return {
      ...loaded,
      Worker: class UnsupportedRendererWorker {
        constructor() {
          throw Object.assign(new Error("ERR_MISSING_PLATFORM_FOR_WORKER"), {
            code: "ERR_MISSING_PLATFORM_FOR_WORKER",
          });
        }
      },
    };
  }
  return loaded;
};

delete globalThis.__PI_OBS_IMPORT_META;
delete requireFromAsar.cache[requireFromAsar.resolve(path.join(asarPluginDir, "main.js"))];
let noWorkerPlugin = null;
try {
  noWorkerPlugin = requireFromAsar(path.join(asarPluginDir, "main.js")).default;
  check("Worker 构造不可用时 bundle 仍能加载", true);
} catch (error) {
  check("Worker 构造不可用时 bundle 仍能加载", false, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
}

if (noWorkerPlugin) {
  const plugin = new noWorkerPlugin(
    { vault: { adapter: { getBasePath: () => path.join(scratch, "vault") } },
      workspace: { layoutReady: true, onLayoutReady: (cb) => cb(), getLeavesOfType: () => [], getLeaf: () => ({ setViewState: async () => {}, detach() {} }), revealLeaf: async () => {} } },
    { id: "pi-obs", dir: ".obsidian/plugins/pi-obs", version: "0.1.0" },
  );
  try {
    await plugin.onload();
    check("Worker 构造不可用时 onload() 仍能完成", true);
    plugin.onunload();
  } catch (error) {
    check("Worker 构造不可用时 onload() 仍能完成", false, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }

  // 记录 codemode 的真实处境：它靠 Worker 跑沙箱，没有回退路径，所以文件补齐也救不回来。
  // 这里只是确认"本机的 Worker 是好的"，上面那条失败纯属模拟。
  const realWorkerThreads = createRequire(import.meta.url)("node:worker_threads");
  check("真实 Worker 在本机可用（说明上面的失败只是模拟）", typeof realWorkerThreads.Worker === "function");
}
Module._load = originalLoad;

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
