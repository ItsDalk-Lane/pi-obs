import { json, jsonError, textError, type ApiHandler } from "./respond";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { allowFileRoot } from "../../lib/file-access";
import { invalidateSessionListCache, resolveSessionPath } from "../../lib/session-reader";
import {
  getRpcSession,
  setRpcSessionTools,
  startRpcSession,
} from "../../lib/rpc-manager";
import { createAgentEventStream, type AgentEventStreamSession } from "../../lib/agent-event-stream";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel)) {
    return value as ThinkingLevel;
  }
  throw new Error(`Invalid thinking level: ${String(value)}`);
}

/**
 * POST /api/agent/new  body: { cwd, type, message?, ... }
 * 新建一个 pi 会话。多数调用会紧接着发第一条命令；type:"ensure_session" 只创建运行时。
 */
export const postAgentNew: ApiHandler = async (request) => {
  let commandType: string | undefined;
  let promptAccepted = false;
  try {
    const body = await request.json() as { cwd?: string; [key: string]: unknown };
    const { cwd, ...command } = body;
    commandType = typeof command.type === "string" ? command.type : undefined;

    if (!cwd || typeof cwd !== "string") {
      return json({
        error: "cwd is required",
        ...(commandType === "prompt" ? { code: "prompt_rejected", accepted: false } : {}),
      }, 400);
    }
    if (!existsSync(cwd)) {
      return json({
        error: `Directory does not exist: ${cwd}`,
        ...(commandType === "prompt" ? { code: "prompt_rejected", accepted: false } : {}),
      }, 400);
    }

    // 用一次性 key，免得 startRpcSession 的锁与真实会话 id 撞车。
    const { provider, modelId, toolNames, thinkingLevel, ...promptCommand } = command as {
      provider?: string; modelId?: string; toolNames?: string[]; thinkingLevel?: unknown; [key: string]: unknown;
    };
    if ((provider && !modelId) || (!provider && modelId)) {
      throw new Error("provider and modelId must be provided together");
    }
    const explicitThinkingLevel = parseThinkingLevel(thinkingLevel);

    // 必须每个请求唯一：startRpcSession 会把同 key 的并发调用合并成一个会话，
    // Date.now() 的毫秒精度会让同毫秒内的两个新会话合并。
    const tempKey = `__new__${randomUUID()}`;
    const { session, realSessionId } = await startRpcSession(tempKey, "", cwd, {
      ...(toolNames ? { toolNames } : {}),
      ...(provider && modelId ? { initialModel: { provider, modelId } } : {}),
      ...(explicitThinkingLevel ? { thinkingLevel: explicitThinkingLevel } : {}),
    });

    // 同步文件路由的允许根缓存，否则新 cwd 下的文件请求会 403 到缓存过期。
    allowFileRoot(cwd);
    invalidateSessionListCache();

    const state = await session.send({ type: "get_state" }) as {
      model?: { id: string; provider: string };
      thinkingLevel?: string;
    };

    if (promptCommand.type === "ensure_session") {
      return json({
        success: true,
        sessionId: realSessionId,
        data: null,
        model: state.model ? { provider: state.model.provider, modelId: state.model.id } : null,
        thinkingLevel: state.thinkingLevel,
      });
    }

    const result = await session.send(promptCommand);
    promptAccepted = promptCommand.type === "prompt";

    return json({
      success: true,
      sessionId: realSessionId,
      data: result,
      model: state.model ? { provider: state.model.provider, modelId: state.model.id } : null,
      thinkingLevel: state.thinkingLevel,
    });
  } catch (error) {
    return json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted ? { code: "prompt_rejected", accepted: false } : {}),
    }, 500);
  }
};

/** POST /api/agent/[id] —— 向已有会话发命令。 */
export const postAgentCommand: ApiHandler = async (request, { params }) => {
  const id = params.id ?? "";
  let commandType: string | undefined;
  let promptAccepted = false;

  try {
    const body = await request.json() as { type: string; [key: string]: unknown };
    commandType = typeof body.type === "string" ? body.type : undefined;
    const requestedToolNames = body.toolNames;
    if (
      requestedToolNames !== undefined
      && (!Array.isArray(requestedToolNames) || requestedToolNames.some((name) => typeof name !== "string"))
    ) {
      throw new Error("toolNames must be an array of strings");
    }
    const toolNames = requestedToolNames as string[] | undefined;

    // 快路径：会话已在运行
    const existing = getRpcSession(id);
    if (body.type === "set_tools") {
      const filePath = existing?.sessionFile || await resolveSessionPath(id) || undefined;
      if (!existing?.isAlive() && !filePath) {
        return json({ error: "Session not found" }, 404);
      }
      const changed = await setRpcSessionTools(id, filePath, toolNames);
      return json({ success: true, data: { sessionId: changed.sessionId, recreated: changed.recreated } });
    }
    if (existing?.isAlive()) {
      const result = await existing.send(body);
      promptAccepted = body.type === "prompt";
      return json({ success: true, data: result });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return json({
        error: "Session not found",
        ...(body.type === "prompt" ? { code: "prompt_rejected", accepted: false } : {}),
      }, 404);
    }

    const { session } = await startRpcSession(id, filePath, undefined, {
      ...(toolNames !== undefined ? { toolNames } : {}),
    });
    const result = await session.send(body);
    promptAccepted = body.type === "prompt";

    return json({ success: true, data: result });
  } catch (error) {
    return json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted ? { code: "prompt_rejected", accepted: false } : {}),
    }, 500);
  }
};

/** GET /api/agent/[id] —— 会话当前的 agent 状态。 */
export const getAgentState: ApiHandler = async (_request, { params }) => {
  const id = params.id ?? "";
  try {
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) return json({ running: false });
    const state = await session.send({ type: "get_state" });
    return json({ running: true, state });
  } catch (error) {
    return jsonError(error);
  }
};

/**
 * GET /api/agent/[id]/events —— agent 事件流。
 *
 * 仍是同一份 SSE 报文（`createAgentEventStream` 原样复用），只是不经网络：
 * 接入层的 EventSource 替身拿到这个 Response 后自行拆帧派发。
 */
export const agentEvents: ApiHandler = async (request, { params }) => {
  const id = params.id ?? "";
  if (request.signal.aborted) return new Response(null, { status: 204 });

  const session = getRpcSession(id);
  let sessionPromise: Promise<AgentEventStreamSession>;
  if (session?.isAlive()) {
    sessionPromise = Promise.resolve(session);
  } else {
    const filePath = await resolveSessionPath(id);
    if (!filePath) return textError("Session not found", 404);
    if (request.signal.aborted) return new Response(null, { status: 204 });
    sessionPromise = startRpcSession(id, filePath, undefined).then((result) => result.session);
  }

  const stream = createAgentEventStream(request, id, sessionPromise);
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
};
