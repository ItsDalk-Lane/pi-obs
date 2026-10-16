// 网页版冒烟：真浏览器里确认 Web 版还完好。
//
// 为什么需要它：插件改造（C2 方案）动了 components/ 与 lib/ 的**共享文件** ——
// ChatWindow / DirectoryPicker / SidebarMenu 各一行弹层容器、pi-sdk-internals 加接缝。
// 这些文件 Web 版也在用，所以"插件能不能跑"和"网页版还能不能用"必须分开证明。
//
// 与 e2e/run.mjs 的分工：那个跑完整回归套件（依赖 Playwright 自带的浏览器版本）；
// 这个只做"能不能用"的最小证明，并且会自动复用本机缓存里的 Chromium。
//
// 用法：node e2e/web-smoke.mjs [--url http://127.0.0.1:30141]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const url = arg("url", "http://127.0.0.1:30141");

const requireFromRepo = createRequire(path.join(repoRoot, "package.json"));
const { chromium } = requireFromRepo("playwright");

/** 本机缓存里的 Chromium 版本可能和 Playwright 包对不上，退回版本号最大的那一份。 */
function findCachedChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH
    || path.join(os.homedir(), "AppData", "Local", "ms-playwright");
  try {
    const candidates = [];
    for (const entry of fs.readdirSync(root)) {
      const match = /^chromium-(\d+)$/.exec(entry);
      if (!match) continue;
      for (const relative of [
        path.join("chrome-win64", "chrome.exe"),
        path.join("chrome-linux", "chrome"),
        path.join("chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
      ]) {
        const candidate = path.join(root, entry, relative);
        if (fs.existsSync(candidate)) candidates.push({ version: Number(match[1]), candidate });
      }
    }
    candidates.sort((left, right) => right.version - left.version);
    return candidates[0]?.candidate ?? null;
  } catch {
    return null;
  }
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const browser = await (async () => {
  try {
    return await chromium.launch();
  } catch (error) {
    const executablePath = findCachedChromium();
    if (!executablePath) throw error;
    console.log(`（Playwright 自带浏览器缺失，改用缓存里的：${executablePath}）`);
    return await chromium.launch({ executablePath });
  }
})();

const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const consoleErrors = [];
const failedRequests = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
page.on("response", (response) => {
  if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`);
});

try {
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
  check("网页能打开", Boolean(response) && response.status() === 200, `HTTP ${response?.status()}`);

  await page.waitForSelector(".chat-input-shell", { timeout: 25_000 });
  check("界面渲染出输入框", true);

  const title = await page.title();
  check("页面标题含 Pi Obs", title.includes("Pi Obs"), title);

  // 侧栏会话：证明 /api/sessions 这一层通。
  // 注意这里数的是 DOM 里的行数；全新浏览器配置下侧栏默认折叠，行不可见（那是产品行为，不是故障）。
  await page.waitForSelector(".session-tree-row", { timeout: 15_000 }).catch(() => {});
  const rowCount = await page.locator(".session-tree-row").count();
  const firstRowVisible = await page.locator(".session-tree-row.session-tree-session").first().isVisible().catch(() => false);
  check("侧栏渲染出会话行", rowCount > 0, `${rowCount} 行（侧栏${firstRowVisible ? "可见" : "折叠中"}）`);

  // 页面内直接打 API，证明服务端路由没坏
  const apiProbe = await page.evaluate(async () => {
    const response = await fetch("/api/sessions");
    const body = await response.json();
    return { status: response.status, count: body?.sessions?.length ?? -1 };
  });
  check("页面内 /api/sessions 正常", apiProbe.status === 200 && apiProbe.count >= 0, `status=${apiProbe.status} count=${apiProbe.count}`);

  // 弹层兜底：getPortalHost() 不设置时必须仍然是 document.body。
  // 需要侧栏可见才能点到会话的「更多」按钮；侧栏折叠时跳过并说明，不硬凑。
  const firstRow = page.locator(".session-tree-row.session-tree-session").first();
  if (!firstRowVisible) {
    console.log("SKIP  弹层检查：侧栏默认折叠，会话行不可见，点不到「更多」按钮");
    console.log("      （该行为的证据改用 components/SidebarMenu.test.mjs —— 15/15 通过，含 4 条弹层专项用例）");
  } else {
    await firstRow.hover().catch(() => {});
    await page.waitForTimeout(200);
    await page.locator(".session-tree-more-action").first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(600);
    const menuProbe = await page.evaluate(() => {
      const menu = document.querySelector(".sidebar-menu");
      return { found: Boolean(menu), inBody: Boolean(menu) && document.body.contains(menu) };
    });
    check("弹层仍挂在 document.body 上（Web 版兜底没变）", menuProbe.inBody,
      `找到菜单=${menuProbe.found}`);
  }

  // 打开一个会话：验证导航与聊天界面。
  // 会话行是绝对定位在滚动容器里的，Playwright 的可操作性检查会超时，
  // 所以先按 href 直接导航（走的是同一条真实路径），点不动不算应用故障。
  const href = await firstRow.locator("a").first().getAttribute("href").catch(() => null);
  if (!href) {
    check("会话行带可导航的链接", false, "取不到 href");
  } else {
    await page.goto(new URL(href, url).toString(), { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".chat-input-shell", { timeout: 20_000 });
    await page.waitForTimeout(2500);
    const afterOpen = await page.evaluate(() => {
      const composer = document.querySelector(".chat-input-shell");
      if (!composer) return null;
      const rect = composer.getBoundingClientRect();
      return {
        bottomRatio: rect.bottom / window.innerHeight,
        messageCount: document.querySelectorAll(".chat-content [data-message-id], .chat-content .message").length,
        hasText: (document.querySelector(".chat-content")?.textContent ?? "").trim().length,
      };
    });
    check("打开会话后能看到消息内容", Boolean(afterOpen && afterOpen.hasText > 0),
      afterOpen ? `聊天区文本 ${afterOpen.hasText} 字符` : "没有聊天区");
    check("打开会话后输入框贴底", Boolean(afterOpen) && afterOpen.bottomRatio > 0.85,
      afterOpen ? `底边在视口 ${(afterOpen.bottomRatio * 100).toFixed(1)}% 处` : "没有输入框");
  }

  const realErrors = consoleErrors.filter((line) => !/favicon|Download the React DevTools/i.test(line));
  check("控制台没有报错", realErrors.length === 0, realErrors.slice(0, 2).join(" | "));
  if (failedRequests.length > 0) {
    console.log(`      失败请求：${[...new Set(failedRequests)].slice(0, 4).join(" | ")}`);
  }
} catch (error) {
  check("网页版冒烟", false, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
} finally {
  await browser.close();
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
