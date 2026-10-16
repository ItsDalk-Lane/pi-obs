// 插件侧的全局与别名声明。

/**
 * 引导段（obsidian-plugin/boot-banner.js）在产物最前面建立的全局。
 * 构建期 esbuild 用 `define: {"import.meta": "__PI_OBS_IMPORT_META"}` 把所有
 * `import.meta.*` 指向它，所以代码里可以直接引用这个名字。
 */
declare const __PI_OBS_IMPORT_META: {
  url: string;
  filename: string | null;
  dirname: string | null;
  resolve(specifier: string): string;
};

/**
 * esbuild 构建期把这些别名指到 SDK 打包目录里的具体文件（见 esbuild.config.mjs）。
 * 它们是 SDK 的"未导出模块"，包不导出、也没有类型声明，所以这里声明成 any。
 */
declare module "@pi-obs-sdk/*";
