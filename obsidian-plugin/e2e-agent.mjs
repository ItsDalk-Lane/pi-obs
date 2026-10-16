// 纯 Node 端到端：走接入层跑通"建会话 → 订阅事件流 → 发消息 → 收流式回复"。
//
// 这是阶段 1 验收标准的无头版：真的调用 LLM，真的走 EventSource 替身。
// 但它不验证渲染 —— 那一步必须由你在 Obsidian 里做。
//
// 用法：
//   node e2e-agent.mjs [cwd]
//   PI_OBS_E2E_PROVIDER=agnes PI_OBS_E2E_MODEL=agnes-3.0-flash node e2e-agent.mjs
//
// 会话用完即删（DELETE /api/sessions/:id），不在你的会话列表里留垃圾。

import { apiCall, fakeApp, installStubs, loadPluginClass } from "./stub-env.mjs";

const cwd = process.argv[2] ?? process.cwd();
const provider = process.env.PI_OBS_E2E_PROVIDER ?? "agnes";
const modelId = process.env.PI_OBS_E2E_MODEL ?? "agnes-3.0-flash";
const PROMPT = "这是一次连通性测试。请只回复两个字：成功";
const TURN_TIMEOUT_MS = 120_000;

installStubs();

// 插件自己的日志（console.warn/error）也要收：MCP 关闭时会打一行 "MCP is off: ..."，
// 那是本次修复要确认消失的东西。
const pluginLogs = [];
for (const level of ["warn", "error", "log"]) {
  const original = console[level];
  console[level] = (...args) => {
    pluginLogs.push(args.map((value) => (value instanceof Error ? `${value.name}: ${value.message}` : String(value))).join(" "));
    original(...args);
  };
}

const PluginClass = loadPluginClass();
const plugin = new PluginClass(fakeApp(), { id: "pi-obs", dir: "obsidian-plugin", version: "0.1.0" });
await plugin.onload();

let sessionId = null;
let exitCode = 1;

try {
  const created = await apiCall("POST", "/api/agent/new", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, type: "ensure_session", provider, modelId }),
  });
  if (created.status !== 200) throw new Error(`POST /api/agent/new -> ${created.status} ${JSON.stringify(created.body)}`);
  sessionId = created.body.sessionId;
  console.log(`PASS  POST /api/agent/new — session ${sessionId} model=${JSON.stringify(created.body.model)}`);

  // --- 事件流（走 EventSource 替身）----------------------------------------
  const events = [];
  let replyText = "";
  let lastAssistantMessage = null;
  const ended = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for agent_end")), TURN_TIMEOUT_MS);
    const source = new globalThis.EventSource(`/api/agent/${encodeURIComponent(sessionId)}/events`);
    source.onerror = () => {
      // 流正常结束也会走到这里；只有还没拿到 agent_end 才算失败。
      if (!events.some((event) => event.type === "agent_end")) {
        clearTimeout(timer);
        reject(new Error("event stream failed before agent_end"));
      }
    };
    source.onmessage = (message) => {
      let event;
      try { event = JSON.parse(message.data); } catch { return; }
      events.push(event);
      if (event.type === "connected") {
        console.log(`PASS  event stream connected — isStreaming=${event.isStreaming}`);
        void sendPrompt();
      }
      if (event.type === "message_update" && event.message?.role === "assistant") {
        const blocks = event.message.content;
        if (Array.isArray(blocks)) {
          replyText = blocks.filter((block) => block?.type === "text").map((block) => block.text).join("");
        }
      }
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const blocks = event.message.content;
        if (Array.isArray(blocks)) {
          const text = blocks.filter((block) => block?.type === "text").map((block) => block.text).join("");
          if (text) replyText = text;
        }
        lastAssistantMessage = event.message;
      }
      if (event.type === "startup_error") {
        clearTimeout(timer);
        reject(new Error(`startup_error: ${event.errorMessage}`));
        return;
      }
      if (event.type === "agent_end") {
        clearTimeout(timer);
        resolve();
      }
    };
  });

  const sendPrompt = async () => {
    const sent = await apiCall("POST", `/api/agent/${encodeURIComponent(sessionId)}`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "prompt", message: PROMPT }),
    });
    if (sent.status !== 200) throw new Error(`POST /api/agent/[id] -> ${sent.status} ${JSON.stringify(sent.body)}`);
    console.log("PASS  POST /api/agent/[id] — prompt accepted");
  };

  await ended;

  const kinds = [...new Set(events.map((event) => event.type))].sort();
  console.log(`PASS  event stream delivered ${events.length} events — ${kinds.join(", ")}`);
  console.log(`      assistant text: ${JSON.stringify(replyText.slice(0, 200))}`);
  if (!replyText && lastAssistantMessage) {
    console.log(`      (debug) last assistant message: ${JSON.stringify(lastAssistantMessage).slice(0, 400)}`);
  }

  const gotConnected = events.some((event) => event.type === "connected");
  const gotUpdates = events.some((event) => event.type === "message_update");
  const gotEnd = events.some((event) => event.type === "agent_end");
  const gotReply = replyText.includes("成功");
  // 插件负责的是"管道"：握手、事件、回合收尾。模型回了什么取决于 provider 是否可用。
  // 模型空回复时把原始消息打出来并给出方向，免得看起来像插件坏了。
  console.log(`${gotConnected ? "PASS" : "FAIL"}  handshake (connected event)`);
  console.log(`${gotUpdates ? "PASS" : "FAIL"}  streaming deltas (message_update)`);
  console.log(`${gotEnd ? "PASS" : "FAIL"}  turn completed (agent_end)`);
  console.log(`${gotReply ? "PASS" : "FAIL"}  reply carries the expected text ("成功")`);
  if (!gotReply) {
    console.log(`      原始 assistant 消息：${JSON.stringify(lastAssistantMessage ?? null).slice(0, 400)}`);
    console.log("      管道本身是通的（握手/事件/回合收尾都过）—— 先确认 provider 还能用（密钥、额度、网络），再怀疑插件。");
  }

  // MCP 的 SDK 内部模块换成 bundle 内那一份之后，这条日志不该再出现。
  const mcpOff = pluginLogs.filter((line) => line.includes("MCP is off"));
  console.log(`${mcpOff.length === 0 ? "PASS" : "FAIL"}  MCP 没有因为 SDK 定位问题被关掉${mcpOff.length ? ` — ${mcpOff[0].slice(0, 160)}` : ""}`);

  exitCode = gotConnected && gotUpdates && gotEnd && gotReply && mcpOff.length === 0 ? 0 : 1;
} catch (error) {
  console.log(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (sessionId) {
    const removed = await apiCall("DELETE", `/api/sessions/${encodeURIComponent(sessionId)}`);
    console.log(`${removed.status === 200 ? "PASS" : "FAIL"}  DELETE /api/sessions/[id] — cleanup status=${removed.status}`);
    if (removed.status !== 200) exitCode = 1;
  }
  plugin.onunload();
}

process.exit(exitCode);
