// CSS Modules 的声明。
//
// Next 项目里这层声明由 next-env.d.ts 提供，插件的 tsconfig 没有它，
// 于是 `import styles from "./X.module.css"` 会报 TS2307。
// 运行期由 esbuild.config.mjs 里的替身插件提供同名映射（阶段 1 不带样式）。

declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}
