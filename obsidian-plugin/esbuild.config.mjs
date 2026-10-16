// Pi Obs 原生插件的打包配置（方案 C2）。
//
// 与旧配置的三点差别，都是实测逼出来的：
//
// 1. `platform: node` —— 渲染进程带 Node 集成，pi SDK、lib/* 都要真的 Node 内建模块，
//    不能像浏览器构建那样把它们当外部依赖丢掉。
// 2. `next/navigation` 别名 —— AppShell 仍然写着 `from "next/navigation"`，
//    插件构建期把它指到 shims/next-navigation.ts。Web 版（Turbopack）不受影响。
// 3. `import.meta` 整体替换 —— pi SDK 在模块顶层就读它定位自己的包目录，打成 CJS 后是
//    undefined（加载即崩）。替换成什么由 boot-banner.js 决定：**不能用 `__filename`**，
//    Obsidian 插件里它是 Electron 的 asar 路径，会让 SDK 去读 asar 内部文件而致命报错。

import esbuild from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import builtinModules from "builtin-modules";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const prod = process.argv[2] === "production";

/**
 * SDK 的"未导出模块"在包内是深路径，包的 exports 字段不允许外部按路径导入。
 * 构建期把它们别名成绝对路径，让 esbuild 直接读文件 —— 这样 plugins 里
 * `import * as x from "@pi-obs-sdk/..."` 拿到的就是 bundle 里那一份，
 * 与 SDK 根导出的是同一个模块实例（MCP 的同实例校验依赖这一点）。
 * 路径与 lib/pi-sdk-internals.ts 的 SDK_MODULES 一一对应，改那边要同步改这里。
 */
const sdkDist = path.join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
const mcpDist = path.join(repoRoot, "node_modules", "@earendil-works", "pi-mcp", "dist");

const sdkInternalsAlias = {
  "@pi-obs-sdk/mcp-extension": path.join(sdkDist, "extensions", "mcp", "index.js"),
  "@pi-obs-sdk/mcp-runtime": path.join(sdkDist, "extensions", "mcp", "runtime.js"),
  "@pi-obs-sdk/mcp-config": path.join(sdkDist, "extensions", "mcp", "config.js"),
  "@pi-obs-sdk/mcp-oauth": path.join(sdkDist, "extensions", "mcp", "oauth.js"),
  "@pi-obs-sdk/mcp-servers": path.join(sdkDist, "core", "mcp-servers.js"),
  "@pi-obs-sdk/config-values": path.join(sdkDist, "core", "resolve-config-value.js"),
  "@pi-obs-sdk/mcp-client": path.join(mcpDist, "index.js"),
};

/** 引导段以原文前置到产物最前面，必须在 esbuild 的模块初始化之前跑。 */
const bootBanner = await fs.readFile(path.join(here, "boot-banner.js"), "utf8");

/**
 * CSS Modules 的临时替身。
 *
 * 全仓库只有一个 `ChatMinimap.module.css`，但它在 ChatWindow 里，必然进包。
 * 阶段 1 不带样式，所以这里只把类名原样导出一个映射：类名留在 DOM 里，
 * 等样式方案落地时直接补 CSS 即可（届时替换本插件）。
 */
const cssModulesStandin = {
  name: "pi-obs-css-modules-standin",
  setup(build) {
    build.onLoad({ filter: /\.module\.css$/ }, async (args) => {
      const css = await fs.readFile(args.path, "utf8");
      const names = [...new Set([...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((match) => match[1]))];
      const entries = names.map((name) => `${JSON.stringify(name)}: ${JSON.stringify(name)}`);
      return { contents: `export default { ${entries.join(", ")} };`, loader: "js" };
    });
  },
};

const context = await esbuild.context({
  entryPoints: [path.join(here, "main.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2022",
  outfile: path.join(here, "main.js"),
  external: [
    "obsidian",
    "electron",
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
  ],
  alias: {
    "next/navigation": path.join(here, "shims", "next-navigation.ts"),
    ...sdkInternalsAlias,
  },
  define: {
    // 整体替换 import.meta（含 .url / .dirname / .resolve），裸 import.meta 也覆盖。
    "import.meta": "__PI_OBS_IMPORT_META",
  },
  banner: {
    js: bootBanner,
  },
  jsx: "automatic",
  plugins: [cssModulesStandin],
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
});

if (prod) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
