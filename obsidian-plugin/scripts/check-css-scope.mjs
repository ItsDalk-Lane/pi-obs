// 静态断言：生成的 styles.css 不会碰到 Obsidian 自己的界面。
//
// 为什么值得单做一个脚本：这一条**无法目视验证** —— 样式泄漏的表现是"Obsidian 别处坏了"，
// 而坏的地方可能离插件很远。作用域化是靠改写选择器实现的，改写错了就是全局事故，
// 所以把不变量写成断言，让它跟着构建一起跑。
//
// 不变量：生成的每条规则的每个选择器，必须
//   a) 包含 .pi-obs-host（界面样式只能命中宿主及其后代），或
//   b) 以 .pi-obs- 开头（插件自己的宿主元素），或
//   c) 以 .workspace-leaf-content[data-type="pi-obs-main"] 开头（视图外壳）
//
// 用法：node scripts/check-css-scope.mjs

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { splitSelectorList } from "./selector-utils.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(scriptDir, "..");
const stylesPath = path.join(pluginDir, "styles.css");

/** 这些 at-rule 里没有选择器，或选择器不进 DOM 匹配（keyframes 的 0%/from 等）。 */
const NON_SELECTOR_AT_RULES = new Set([
  "keyframes", "-webkit-keyframes", "-moz-keyframes", "-o-keyframes",
  "font-face", "page", "property", "counter-style", "font-feature-values", "viewport",
]);

const VIEW_SHELL_PREFIX = '.workspace-leaf-content[data-type="pi-obs-main"]';

function isSelectorAllowed(selector) {
  const sel = selector.trim();
  if (!sel) return true;
  if (sel.includes(".pi-obs-host")) return true;
  if (sel.startsWith(".pi-obs-")) return true;
  if (sel.startsWith(VIEW_SHELL_PREFIX)) return true;
  return false;
}

function insideNonSelectorAtRule(node) {
  let parent = node.parent;
  while (parent) {
    if (parent.type === "atrule" && NON_SELECTOR_AT_RULES.has(parent.name.toLowerCase())) return true;
    parent = parent.parent;
  }
  return false;
}

const css = await fs.readFile(stylesPath, "utf8");
const root = postcss.parse(css, { from: stylesPath });

const violations = [];
let checked = 0;

root.walkRules((rule) => {
  if (insideNonSelectorAtRule(rule)) return;
  checked += 1;
  for (const selector of splitSelectorList(rule.selector)) {
    if (isSelectorAllowed(selector)) continue;
    violations.push({ selector: selector.trim(), line: rule.source?.start?.line });
  }
});

console.log(`[check-css-scope] 检查了 ${checked} 条规则`);

if (violations.length > 0) {
  console.error(`[check-css-scope] 发现 ${violations.length} 个会泄漏到 Obsidian 的选择器：`);
  for (const violation of violations.slice(0, 25)) {
    console.error(`  styles.css:${violation.line}  ${violation.selector}`);
  }
  if (violations.length > 25) console.error(`  …还有 ${violations.length - 25} 个`);
  process.exit(1);
}

// 反向检查：宿主规则必须在场，否则界面会变成一个没有高度的空盒子。
const required = [".pi-obs-host", ".pi-obs-mount", ".pi-obs-portal"];
const missing = required.filter((needle) => !css.includes(needle));
if (missing.length > 0) {
  console.error(`[check-css-scope] 缺少宿主规则：${missing.join(", ")}`);
  process.exit(1);
}

// 反向检查 2：布局关键的工具类必须在场。
//
// 这一条是被真 bug 逼出来的（2026-10-16）：Tailwind v4 默认从**构建时的 cwd** 扫描源文件，
// 而样式构建跑在 obsidian-plugin/ 下，那里没有界面源码 → 一个工具类都没生成 →
// .chat-content 从 flex 列退化成 display:block、高度归零，输入框顶到了视图最上面。
// 当时"零泄漏"断言全绿，界面却是坏的 —— 所以泄漏之外还得断言"该有的有"。
const requiredUtilities = ["h-full", "flex", "flex-col", "min-w-0", "overflow-hidden"];
const missingUtilities = requiredUtilities.filter(
  (name) => !new RegExp(`\\.pi-obs-host \\.${name}\\s*\\{`).test(css),
);
if (missingUtilities.length > 0) {
  console.error(`[check-css-scope] 布局关键工具类没生成：${missingUtilities.map((n) => `.${n}`).join(", ")}`);
  console.error("[check-css-scope] 检查 app-css.entry.css 的 @source 是否覆盖了界面源码目录");
  process.exit(1);
}

console.log("[check-css-scope] 通过：没有选择器能命中宿主之外的元素，布局工具类齐全");
