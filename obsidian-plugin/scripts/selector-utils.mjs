// 选择器列表的切分工具 —— 作用域化插件与泄漏断言两边共用，避免"一边用真解析、一边用 split(',')"。
//
// 为什么不能用 `selector.split(",")`：`:is(h1, h2) code`、`[type="reset"], [type="submit"]`
// 里的逗号都在括号内，naive split 会把一条选择器切成几段，切出来的碎片看起来就像"泄漏到全局"。

/** 按顶层逗号切选择器列表：括号、方括号与引号里的逗号不算分隔符。 */
export function splitSelectorList(selector) {
  const parts = [];
  let current = "";
  let depth = 0;
  let quote = null;
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index];
    if (quote) {
      current += char;
      if (char === "\\") { index += 1; current += selector[index] ?? ""; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === "(" || char === "[") { depth += 1; current += char; continue; }
    if (char === ")" || char === "]") { depth -= 1; current += char; continue; }
    if (char === "," && depth === 0) { parts.push(current); current = ""; continue; }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}
