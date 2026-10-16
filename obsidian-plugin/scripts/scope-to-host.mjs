// PostCSS 插件：把整套界面样式限定到 .pi-obs-host 之下。
//
// 为什么必须作用域化：Obsidian 插件的 styles.css 是**全局**的，而这四份 app CSS 里有
//   * { box-sizing: border-box }
//   html, body { overflow: hidden; background: var(--bg); color: var(--text); … }
//   :root { --bg: #ffffff; … }
// 直接注入会把整个 Obsidian 一起改掉（body 高度、滚动、配色全变）。
//
// 三条改写规则：
//   1. 页面级选择器（:root / html / body / :host）→ 宿主元素本身
//   2. `*` → 宿主及其后代
//   3. 其余 → 宿主后代；`html.dark` / `html[data-theme=x]` 这类主题条件**保留原条件**，
//      并把宿主插在它后面 —— 因为 useTheme 就是往 documentElement 上写 data-theme/class
//   4. 页面级伪元素（::view-transition-*）在插件里没有意义，直接丢掉

import { splitSelectorList } from "./selector-utils.mjs";

const HOST = ".pi-obs-host";

/** 这些 at-rule 内部的"规则"不是选择器（keyframe 的 0%/from，font-face 的 src 等）。 */
const NON_SELECTOR_AT_RULES = new Set([
  "keyframes",
  "-webkit-keyframes",
  "-moz-keyframes",
  "-o-keyframes",
  "font-face",
  "page",
  "property",
  "counter-style",
  "font-feature-values",
  "viewport",
]);

function insideNonSelectorAtRule(rule) {
  let parent = rule.parent;
  while (parent) {
    if (parent.type === "atrule" && NON_SELECTOR_AT_RULES.has(parent.name.toLowerCase())) {
      return true;
    }
    parent = parent.parent;
  }
  return false;
}

/** 判断首个复合选择器是不是"文档级"起点（html / :root / 裸 [data-theme]）。 */
function isDocumentLevelHead(head) {
  return /^html\b/.test(head) || /^:root\b/.test(head) || /^\[data-/.test(head);
}

/** 把一段复合选择器拆成 token：只用空白分隔（属性选择器里的空格极少见，且本仓库没有）。 */
function tokens(selector) {
  return selector.split(/\s+/).filter(Boolean);
}

function scopeSelector(raw, host) {
  const selector = raw.trim();
  if (!selector) return null;

  // 页面过渡伪元素：Obsidian 里没有对应的东西，留着只会误伤
  if (/^::view-transition/.test(selector)) return null;

  if (selector === "*") return `${host}, ${host} *`;

  const parts = tokens(selector);
  const head = parts[0];

  // 文档级单选择器 → 宿主本身
  if (parts.length === 1 && (head === ":root" || head === ":host" || head === "html" || head === "body")) {
    return host;
  }

  if (isDocumentLevelHead(head)) {
    // 保留主题/键盘条件，把宿主插到条件后面
    const normalizedHead = /^\[data-/.test(head) ? `html${head}` : head.replace(/^:root/, "html");
    const rest = parts.slice(1).join(" ");
    return rest ? `${normalizedHead} ${host} ${rest}` : `${normalizedHead} ${host}`;
  }

  return `${host} ${selector}`;
}

/** 一条规则的每个选择器单独改，然后去重（`html, body` 会都映射成宿主）。 */
function scopeSelectorList(selector, host) {
  const scoped = [];
  for (const part of splitSelectorList(selector)) {
    const result = scopeSelector(part, host);
    if (result && !scoped.includes(result)) scoped.push(result);
  }
  return scoped;
}

export default function scopeToHost(options = {}) {
  const host = options.host ?? HOST;
  return {
    postcssPlugin: "pi-obs-scope-to-host",
    Rule(rule) {
      if (insideNonSelectorAtRule(rule)) return;
      const scoped = scopeSelectorList(rule.selector, host);
      if (scoped.length === 0) {
        rule.remove();
        return;
      }
      rule.selector = scoped.join(", ");
    },
  };
}
scopeToHost.postcss = true;
