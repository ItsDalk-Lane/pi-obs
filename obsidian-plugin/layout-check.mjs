// 真实 Chromium 里的布局对照：插件 vs Web 版。
//
// 这个脚本是被一个真 bug 逼出来的：
//   jsdom 不做布局，而且**不应用 @layer 里的规则** —— Tailwind 的工具类全在 @layer utilities 里。
//   于是"DOM 树 dump + 静态断言"这套全绿，界面却塌了：构建时 Tailwind 从 obsidian-plugin/ 起步
//   做源扫描，一个工具类都没生成，.chat-content 变成 display:block，聊天列高度归零，
//   输入框顶到了最上面。
//
// 所以这里换一种验证方式：不猜"应该在哪"，而是**以 Web 版为基准量比例**。
//   1. 用 ui-mount 生成真实 React 界面的 DOM 快照（PI_OBS_SNAPSHOT）
//   2. 快照 + 生成的 styles.css 丢进真实 Chromium（Playwright 已装）
//   3. 在同一个 Chromium、同一视口下打开 Web 版（默认 http://127.0.0.1:30141）
//   4. 量同一批元素，断言两边比例一致
//
// Web 版不可达时退化成"绝对断言"：聊天列必须撑满（h-full 生效）、输入框必须落在容器下部。
//
// 用法：node layout-check.mjs [--web-url http://127.0.0.1:30141] [--viewport 1000x700]

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const webUrl = arg("web-url", "http://127.0.0.1:30141");
const [viewportWidth, viewportHeight] = arg("viewport", "1000x700").split("x").map(Number);

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const requireFromRepo = createRequire(path.join(repoRoot, "package.json"));
let chromium;
try {
  ({ chromium } = requireFromRepo("playwright"));
} catch {
  console.log("SKIP  playwright 不可用 —— 跳过布局对照");
  process.exit(0);
}

// --- 1. 拿界面的 DOM 快照 -----------------------------------------------------
const snapshotPath = path.join(os.tmpdir(), `pi-obs-dom-${process.pid}.html`);
const mount = spawnSync(process.execPath, [path.join(here, "ui-mount.mjs")], {
  env: { ...process.env, PI_OBS_SNAPSHOT: snapshotPath },
  encoding: "utf8",
});
if (!existsSync(snapshotPath)) {
  console.error("拿不到 DOM 快照，ui-mount 的输出：");
  console.error((mount.stdout ?? "").split("\n").slice(-20).join("\n"));
  console.error(mount.stderr ?? "");
  process.exit(1);
}
const hostHtml = await readFile(snapshotPath, "utf8");
await rm(snapshotPath, { force: true });
const stylesheet = await readFile(path.join(here, "styles.css"), "utf8");

/**
 * 探针页面刻意复刻 Obsidian 的视图骨架：
 * .workspace-leaf-content（列向 flex）> .view-content（flex:1，高度确定）> 宿主。
 * 这样宿主上的 height:100% 才有确定的参照 —— 这正是 jsdom 里量不出来的东西。
 *
 * `--app-viewport-height` 由视图代码用 ResizeObserver 回写成宿主真实高度，
 * 这里直接按稳定值给上：界面的根元素拿它当高度（height: var(--app-viewport-height, 100dvh)），
 * 所以稳定态下它就等于宿主高度。
 */
function pluginPage() {
  return `<!doctype html><html><head><style>${stylesheet}</style></head>
<body style="margin:0">
  <div class="workspace-leaf-content" data-type="pi-obs-main"
       style="height:${viewportHeight}px;display:flex;flex-direction:column">
    <div class="view-content" style="flex:1 1 auto;min-height:0;--app-viewport-height:${viewportHeight}px">
      ${hostHtml}
    </div>
  </div>
</body></html>`;
}

/** 在页面里量关键元素，返回相对视口的比例 —— 两边容器结构不同，比例才可比。 */
const MEASURE = () => {
  const pick = (selector) => document.querySelector(selector);
  const box = (element) => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height, top: rect.top, bottom: rect.bottom, left: rect.left };
  };
  const chatElement = pick(".chat-content");
  const composerElement = pick(".chat-input-shell");
  const toolbarElement = pick(".composer-toolbar");
  const sidebarElement = pick(".session-sidebar");
  const chat = chatElement?.getBoundingClientRect() ?? null;
  const composer = composerElement?.getBoundingClientRect() ?? null;
  const sidebar = sidebarElement?.getBoundingClientRect() ?? null;
  const viewportH = window.innerHeight;
  const viewportW = window.innerWidth;
  return {
    viewportH,
    viewportW,
    hasChat: Boolean(chat),
    hasComposer: Boolean(composer),
    chatContent: box(chatElement),
    composer: box(composerElement),
    toolbar: box(toolbarElement),
    sidebar: box(sidebarElement),
    chatDisplay: chatElement ? window.getComputedStyle(chatElement).display : null,
    chatFlexDirection: chatElement ? window.getComputedStyle(chatElement).flexDirection : null,
    chatHeightRatio: chat ? chat.height / viewportH : 0,
    composerBottomRatio: composer ? composer.bottom / viewportH : 0,
    composerTopRatio: composer ? composer.top / viewportH : 0,
    sidebarWidthRatio: sidebar ? sidebar.width / viewportW : 0,
  };
};

/**
 * 本机装着的 Playwright 可能比缓存里的 Chromium 新（"Executable doesn't exist at …-1243"）。
 * 这种版本错位不该让验证跑不起来，所以退回缓存里版本号最大的那一份。
 * 布局用的是 flex / @layer 这些老特性，小版本差异不影响结论。
 */
function findCachedChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH
    || path.join(os.homedir(), "AppData", "Local", "ms-playwright");
  try {
    const { readdirSync, existsSync: exists } = requireFromRepo("node:fs");
    const candidates = [];
    for (const entry of readdirSync(root)) {
      const match = /^chromium-(\d+)$/.exec(entry);
      if (!match) continue;
      for (const relative of [
        path.join("chrome-win64", "chrome.exe"),
        path.join("chrome-linux", "chrome"),
        path.join("chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
      ]) {
        const candidate = path.join(root, entry, relative);
        if (exists(candidate)) candidates.push({ version: Number(match[1]), candidate });
      }
    }
    candidates.sort((left, right) => right.version - left.version);
    return candidates[0]?.candidate ?? null;
  } catch {
    return null;
  }
}

const browser = await (async () => {
  try {
    return await chromium.launch();
  } catch (error) {
    const executablePath = findCachedChromium();
    if (!executablePath) throw error;
    console.log(`（Playwright 自带的 Chromium 缺失，改用缓存里的：${executablePath}）`);
    return await chromium.launch({ executablePath });
  }
})();

async function measurePlugin() {
  const page = await browser.newPage({ viewport: { width: viewportWidth, height: viewportHeight } });
  await page.setContent(pluginPage(), { waitUntil: "load" });
  const host = page.locator(".pi-obs-host").first();
  const hostHeight = await host.evaluate((element) => element.getBoundingClientRect().height);
  const metrics = await page.evaluate(MEASURE);
  await page.close();
  return { hostHeight, ...metrics };
}

async function measureWeb() {
  const page = await browser.newPage({ viewport: { width: viewportWidth, height: viewportHeight } });
  try {
    await page.goto(webUrl, { waitUntil: "domcontentloaded", timeout: 8000 });
  } catch {
    await page.close();
    return null;
  }
  // 等界面渲染出输入框
  try {
    await page.waitForSelector(".chat-input-shell", { timeout: 15_000 });
  } catch {
    await page.close();
    return null;
  }
  const metrics = await page.evaluate(MEASURE);
  await page.close();
  return metrics;
}

const plugin = await measurePlugin();
const web = await measureWeb();
await browser.close();

console.log(`\n视口 ${viewportWidth}x${viewportHeight}；宿主高度 ${plugin.hostHeight}px`);
console.log("指标                插件      Web 版");
const rows = [
  ["chatDisplay", plugin.chatDisplay, web?.chatDisplay],
  ["chatFlexDirection", plugin.chatFlexDirection, web?.chatFlexDirection],
  ["chatHeightRatio", plugin.chatHeightRatio?.toFixed(3), web?.chatHeightRatio?.toFixed(3)],
  ["composerBottomRatio", plugin.composerBottomRatio?.toFixed(3), web?.composerBottomRatio?.toFixed(3)],
  ["sidebarWidthRatio", plugin.sidebarWidthRatio?.toFixed(3), web?.sidebarWidthRatio?.toFixed(3)],
];
for (const [label, mine, theirs] of rows) {
  console.log(`${label.padEnd(20)}${String(mine).padEnd(10)}${theirs ?? "（Web 版不可达）"}`);
}

// --- 绝对断言（与 Web 版是否可达无关）----------------------------------------
check("宿主撑满了视图高度", Math.abs(plugin.hostHeight - viewportHeight) < 2, `${plugin.hostHeight}px / ${viewportHeight}px`);
check("聊天列是 flex 列（.flex/.flex-col 生效）",
  plugin.chatDisplay === "flex" && plugin.chatFlexDirection === "column",
  `display=${plugin.chatDisplay} flex-direction=${plugin.chatFlexDirection}`);
check("聊天列高度撑满（.h-full 生效）", plugin.chatHeightRatio > 0.9, `${(plugin.chatHeightRatio * 100).toFixed(1)}% 视口高`);

if (web) {
  check("输入框纵向位置与 Web 版一致（±5% 视口高）",
    Math.abs(plugin.composerBottomRatio - web.composerBottomRatio) < 0.05,
    `插件 ${(plugin.composerBottomRatio * 100).toFixed(1)}% vs Web ${(web.composerBottomRatio * 100).toFixed(1)}%`);
  check("聊天列高度比例与 Web 版一致（±5%）",
    Math.abs(plugin.chatHeightRatio - web.chatHeightRatio) < 0.05,
    `插件 ${(plugin.chatHeightRatio * 100).toFixed(1)}% vs Web ${(web.chatHeightRatio * 100).toFixed(1)}%`);
  check("侧栏宽度比例与 Web 版一致（±5%）",
    Math.abs(plugin.sidebarWidthRatio - web.sidebarWidthRatio) < 0.05,
    `插件 ${(plugin.sidebarWidthRatio * 100).toFixed(1)}% vs Web ${(web.sidebarWidthRatio * 100).toFixed(1)}%`);
} else {
  check("输入框落在容器下部（Web 版不可达时的绝对判据）", plugin.composerBottomRatio > 0.6,
    `${(plugin.composerBottomRatio * 100).toFixed(1)}% 视口高`);
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
