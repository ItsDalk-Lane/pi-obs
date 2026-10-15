import { currentDemoLocale } from "./locale";

/** Message for actions that need a real Pi Obs server. */
export function demoOnlyMessage(): string {
  return currentDemoLocale() === "zh"
    ? "这是静态演示，此操作需要真实的 Pi Obs 服务。运行 npx pi-obs@latest 即可完整体验。"
    : "This is a static demo, so this action needs a real Pi Obs server. Run npx pi-obs@latest to try it for real.";
}
