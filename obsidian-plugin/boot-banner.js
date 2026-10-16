// Pi Obs 引导段 —— 在 esbuild 生成的模块初始化之前执行。
//
// 它只做一件事：给出 SDK 需要的 import.meta 等价物。
//
// 为什么必须在最前面做：pi SDK 在**模块顶层**就用 import.meta.url 定位自己的包目录 ——
// @earendil-works/pi-coding-agent/dist/config.js 会 join(getPackageDir(), "package.json")
// 再 readFileSync 它。打成 CJS 后 import.meta 是 undefined（加载即崩），所以构建期
// 用 --define:import.meta=__PI_OBS_IMPORT_META 整体替换掉。
//
// 为什么不能用 __filename（这是实测踩出来的坑）：
// Obsidian 不用 Node 的 CommonJS 包装器求值插件代码，插件里看到的 __filename 指向
// Electron 自己的 ...\Programs\Obsidian\resources\electron.asar\...。用它推导出的
// "包目录"里恰好有 Electron 的 package.json，于是 SDK 去读 asar 内部文件，Electron 抛
// "Invalid package ...electron.asar" —— 那不是 ENOENT，SDK 的容错分支接不住，
// 插件当场加载失败（实测报错就是这个）。
//
// 所以取值顺序是：
//   1) __filename —— 只在 Node 下成立（纯 Node 冒烟测试走这条）
//   2) Obsidian 自己的 vault 路径 + 插件目录（真机走这条）
//   3) 一个合法但不存在的 file URL（兜底）
//
// 关键不变量：**url 绝不能落在 .asar 里面**，且它所在目录下不能有 package.json ——
// 因为 SDK 对 package.json 缺失只容忍 ENOENT，那正好是"目录不存在或文件不存在"的结果。
(function () {
  "use strict";

  var path = require("path");
  var url = require("url");
  var fs = require("fs");

  var PLUGIN_ID = "pi-obs";

  /** 可信的文件路径：存在、是真文件、且不在 Electron 的 asar 归档里。 */
  function isRealFile(candidate) {
    if (typeof candidate !== "string" || candidate.length === 0) return false;
    if (/\.asar([\\/]|$)/i.test(candidate)) return false;
    try {
      return fs.statSync(candidate).isFile();
    } catch (error) {
      return false;
    }
  }

  /** 从 Obsidian 自己的状态里推出插件 main.js 的位置。 */
  function fromObsidian() {
    var candidates = [];
    try {
      var app = globalThis.app;
      var adapter = app && app.vault && app.vault.adapter;
      // FileSystemAdapter 上两种写法都见过，都接受。
      var base = adapter
        ? (typeof adapter.getBasePath === "function" ? adapter.getBasePath() : adapter.basePath)
        : null;
      if (typeof base === "string" && base.length > 0) {
        var manifestDir = app && app.plugins && app.plugins.manifests
          && app.plugins.manifests[PLUGIN_ID] && app.plugins.manifests[PLUGIN_ID].dir;
        if (typeof manifestDir === "string" && manifestDir.length > 0) {
          candidates.push(path.join(base, manifestDir, "main.js"));
        }
        // Obsidian 要求插件 id 与目录名一致，所以这条是稳定路径。
        candidates.push(path.join(base, ".obsidian", "plugins", PLUGIN_ID, "main.js"));
      }
    } catch (error) {
      /* 拿不到就往下走 */
    }

    for (var index = 0; index < candidates.length; index += 1) {
      if (isRealFile(candidates[index])) return url.pathToFileURL(candidates[index]).href;
    }
    // 路径算出来了但文件还没落盘也无所谓：SDK 只需要"目录下没有 package.json"。
    if (candidates.length > 0) return url.pathToFileURL(candidates[0]).href;
    return null;
  }

  var metaUrl = null;
  try {
    if (isRealFile(__filename)) metaUrl = url.pathToFileURL(__filename).href;
  } catch (error) {
    /* __filename 在插件环境里可能不可用 */
  }
  if (!metaUrl) metaUrl = fromObsidian();
  if (!metaUrl) metaUrl = "file:///C:/pi-obs/main.js";

  var filename = null;
  try {
    filename = url.fileURLToPath(metaUrl);
  } catch (error) {
    filename = null;
  }

  globalThis.__PI_OBS_IMPORT_META = {
    url: metaUrl,
    filename: filename,
    dirname: filename ? path.dirname(filename) : null,
    /**
     * 真的 import.meta.resolve 返回 URL 字符串，SDK 那边用 fileURLToPath 消费它。
     * 打包后没有模块解析上下文，只能借 createRequire 从 metaUrl 出发解析。
     */
    resolve: function (specifier) {
      var resolved = require("module").createRequire(metaUrl).resolve(specifier);
      return url.pathToFileURL(resolved).href;
    },
  };
})();
