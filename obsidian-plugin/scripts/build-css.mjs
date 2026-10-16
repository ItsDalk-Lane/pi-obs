// 把界面样式编译进插件：Tailwind + 四份 app CSS → 作用域化 → 拼上 shell → obsidian-plugin/styles.css
//
// 为什么需要这一步：界面样式由 Next 的 PostCSS/Tailwind 流水线产出，插件构建里没有它，
// 结果就是"功能可用、外观不可用"。而 Obsidian 插件的 styles.css 是全局的，
// 不能把 7600 行含 html/body/:root 的 CSS 直接塞进去 —— 所以必须作用域化。
//
// 用法：node scripts/build-css.mjs

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import scopeToHost from "./scope-to-host.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(scriptDir, "..");

const entryPath = path.join(pluginDir, "app-css.entry.css");
const shellPath = path.join(pluginDir, "plugin-shell.css");
const outputPath = path.join(pluginDir, "styles.css");

const entry = await fs.readFile(entryPath, "utf8");

const started = Date.now();
const result = await postcss([tailwind(), scopeToHost()]).process(entry, {
  from: entryPath,
  to: outputPath,
});
result.warnings().forEach((warning) => console.warn(`[build-css] ${warning.toString()}`));

const shell = await fs.readFile(shellPath, "utf8");

const banner = [
  "/* 本文件由 obsidian-plugin/scripts/build-css.mjs 生成，不要手改。",
  " * 要改外观：改 app/*.css（界面样式）或 obsidian-plugin/plugin-shell.css（宿主规则），",
  " * 然后跑 npm run build:plugin。 */",
  "",
].join("\n");

// 分隔标记：check-css-scope.mjs 靠它区分"生成段"与"shell 段"，别改。
const SHELL_MARKER = "/* ===== pi-obs-shell ===== */";

await fs.writeFile(outputPath, `${banner}${result.css}\n\n${SHELL_MARKER}\n${shell}`, "utf8");

const bytes = (await fs.stat(outputPath)).size;
console.log(`[build-css] ${path.relative(process.cwd(), outputPath)} — ${(bytes / 1024).toFixed(1)} KiB, ${Date.now() - started}ms`);
