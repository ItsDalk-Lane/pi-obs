// 纯 Node 验证：node-http fetch shim 能否驱动 pi SDK 跑通一轮真实对话。
// 目的：在不开 Obsidian 的前提下把"网络层修法"验证到底，spike 第三轮只用来确认 Obsidian 侧环境。
import { createNodeFetch } from "../obsidian-plugin/platform-fetch";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { CHAT_ONLY_RESOURCE_LOADER_OPTIONS } from "../lib/chat-only";

const LM_STUDIO_URL = "http://127.0.0.1:1234/v1/chat/completions";
const MODEL = "qwen/qwen3.8-27b";

async function rawTest(): Promise<void> {
  const fetchImpl = createNodeFetch();
  const t0 = Date.now();
  const res = await fetchImpl(LM_STUDIO_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer 00000" },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "只回复两个字：成功" }], max_tokens: 400, stream: false }),
  });
  const text = await res.text();
  console.log("[raw] status:", res.status, "| ms:", Date.now() - t0, "| body head:", text.slice(0, 300));

  // 流式：确认 ReadableStream + for await 消费可用（pi-ai 的 SSE 解析依赖这个）
  const s0 = Date.now();
  const streamRes = await fetchImpl(LM_STUDIO_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer 00000" },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "只回复两个字：成功" }], max_tokens: 400, stream: true }),
  });
  let chunks = 0;
  let bytes = 0;
  if (streamRes.body) {
    for await (const chunk of streamRes.body as unknown as AsyncIterable<Uint8Array>) {
      chunks += 1;
      bytes += chunk.length;
      if (chunks >= 40) break;
    }
  }
  console.log("[stream] status:", streamRes.status, "| chunks:", chunks, "| bytes:", bytes, "| ms:", Date.now() - s0);
}

async function sdkTest(): Promise<void> {
  (globalThis as unknown as { fetch: unknown }).fetch = createNodeFetch();
  const agentDir = getAgentDir();
  const sessionManager = SessionManager.create(agentDir, undefined);
  const settingsManager = SettingsManager.create(agentDir, agentDir);
  const services = await createAgentSessionServices({
    cwd: agentDir,
    agentDir,
    settingsManager,
    resourceLoaderOptions: { ...CHAT_ONLY_RESOURCE_LOADER_OPTIONS },
  });
  const { session } = await createAgentSessionFromServices({ services, sessionManager, tools: [] });

  const counts: Record<string, number> = {};
  let reply = "";
  session.subscribe((event: { type?: string; message?: { role?: string; content?: unknown } }) => {
    counts[event.type ?? "?"] = (counts[event.type ?? "?"] ?? 0) + 1;
    if (event.type === "message_end" && event.message?.role === "assistant") reply = JSON.stringify(event.message.content).slice(0, 300);
  });

  const t0 = Date.now();
  await session.prompt("这是一次连通性测试。请只回复两个字：成功", { source: "rpc" });
  console.log("[sdk] sessionId:", session.sessionId, "| ms:", Date.now() - t0);
  console.log("[sdk] events:", JSON.stringify(counts));
  console.log("[sdk] reply:", reply);
  console.log(reply.includes("成功") ? "[sdk] 结论：通过" : "[sdk] 结论：未收到有效回复");
}

async function main(): Promise<void> {
  try { await rawTest(); } catch (error) { console.error("[raw] FAIL:", error instanceof Error ? error.message : error); }
  try { await sdkTest(); } catch (error) { console.error("[sdk] FAIL:", error instanceof Error ? error.message : error); }
}

void main();

process.on("exit", (code) => { console.log("[exit] code=", code); });
process.on("uncaughtException", (e) => { console.log("[uncaught]", e && e.message); });
process.on("unhandledRejection", (e) => { console.log("[unhandledRejection]", e && (e as Error).message); });
