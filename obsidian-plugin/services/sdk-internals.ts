import * as mcpClient from "@pi-obs-sdk/mcp-client";
import * as mcpConfig from "@pi-obs-sdk/mcp-config";
import * as mcpExtension from "@pi-obs-sdk/mcp-extension";
import * as mcpOAuth from "@pi-obs-sdk/mcp-oauth";
import * as mcpRuntime from "@pi-obs-sdk/mcp-runtime";
import * as mcpServers from "@pi-obs-sdk/mcp-servers";
import * as configValues from "@pi-obs-sdk/config-values";
import {
  buildPiSdkInternals,
  registerBundledPiSdkInternalsLoader,
  type PiSdkInternalsResult,
  type SdkInternalsModules,
} from "../../lib/pi-sdk-internals";

/**
 * MCP 支持：把 SDK 的"未导出模块"换成已打进 bundle 的那一份。
 *
 * 为什么需要它：`lib/pi-sdk-internals.ts` 原本按**文件位置**加载这些模块 ——
 * 从 `getPackageDir()` 推出 SDK 包目录、再用 `pathToFileURL` 动态 import，并校验
 * 两条路径指向同一个包、两个类是同一次加载。插件里 SDK 根本不在磁盘上（已打成单文件），
 * 那套校验必然失败，实测报错是：
 *
 *   [pi-obs] MCP is off: @earendil-works/pi-coding-agent at <插件目录> is not the package
 *   Pi Obs resolves (<仓库或安装目录>/node_modules/@earendil-works/pi-coding-agent)
 *
 * 打包之后这些文件本来就在同一个 bundle 里，直接 import 就是同一份代码：
 * 同实例校验自然成立，也就不再需要"SDK 在磁盘上的位置"这个概念。
 *
 * 别名的目标是 SDK 包内的深路径（见 esbuild.config.mjs）。深路径不在包里导出，
 * 所以只能靠构建期别名绕过 exports 限制；类型则由 pi-obs-sdk.d.ts 声明成 any。
 */
const BUNDLED_MODULES = {
  mcpExtension,
  mcpRuntime,
  mcpConfig,
  mcpOAuth,
  mcpServers,
  configValues,
  mcpClient,
} as unknown as SdkInternalsModules;

/**
 * 装上打包版加载器。必须在任何地方调用 `loadPiSdkInternals()` 之前执行
 * （结果会缓存在 globalThis 上，注册晚了就一直是文件位置那条路）。
 */
export function installBundledSdkInternals(): void {
  registerBundledPiSdkInternalsLoader(async (): Promise<PiSdkInternalsResult> => {
    // packageDir 只用于日志与 MCP 传输层的入参；打包后没有真实包目录，
    // 报插件自己的安装位置，至少是个真路径。
    const packageDir = __PI_OBS_IMPORT_META.dirname ?? "";
    return buildPiSdkInternals(packageDir, BUNDLED_MODULES);
  });
}
