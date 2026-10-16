// spike/smoke-sdk.mjs —— 在纯 Node 里预先验证 spike 的 pi SDK 最小调用序列。
// 与 spike/main.ts 的 testPiSdk 逻辑一致；通过 = 在 Obsidian 里再失败就只剩环境因素。
// 运行：node spike/smoke-sdk.mjs（在仓库根目录下）
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const CHAT_ONLY_RESOURCE_LOADER_OPTIONS = {
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: false,
  systemPrompt: " ",
  appendSystemPrompt: [" "],
  systemPromptOverride: () => undefined,
  appendSystemPromptOverride: () => [],
};

const SDK_TIMEOUT_MS = 120_000;

function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    }),
  ]);
}

const agentDir = getAgentDir();
console.log("agentDir =", agentDir);

const sessionManager = SessionManager.create(agentDir, undefined);
const settingsManager = SettingsManager.create(agentDir, agentDir);
const services = await createAgentSessionServices({
  cwd: agentDir,
  agentDir,
  settingsManager,
  resourceLoaderOptions: { ...CHAT_ONLY_RESOURCE_LOADER_OPTIONS },
});
const defaultProvider = services.settingsManager.getDefaultProvider?.() ?? null;
const defaultModelId = services.settingsManager.getDefaultModel?.() ?? null;
console.log("default provider/model =", defaultProvider, defaultModelId);

const model = defaultProvider && defaultModelId
  ? services.modelRuntime.getModel(defaultProvider, defaultModelId)
  : undefined;
const { session } = await createAgentSessionFromServices({
  services,
  sessionManager,
  tools: [],
  ...(model ? { model } : {}),
});
console.log("session created:", session.sessionId);

const eventTypes = {};
let assistantText = "";
const unsubscribe = session.subscribe((event) => {
  const type = event.type ?? "unknown";
  eventTypes[type] = (eventTypes[type] ?? 0) + 1;
  if (event.type === "message_end" && event.message?.role === "assistant") {
    assistantText = JSON.stringify(event.message.content ?? "").slice(0, 300);
  }
});

const t0 = Date.now();
await withTimeout(session.prompt("这是一次连通性测试。请只回复两个字：成功", { source: "rpc" }), SDK_TIMEOUT_MS, "pi SDK prompt");
try { unsubscribe?.(); } catch { /* 已解除 */ }

console.log("eventTypes =", JSON.stringify(eventTypes));
console.log("assistant reply =", assistantText);
console.log(`SMOKE-SDK OK (${Date.now() - t0}ms)`);
process.exit(0);
