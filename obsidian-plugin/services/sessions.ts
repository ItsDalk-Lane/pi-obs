import { json, jsonError, type ApiHandler } from "./respond";
import {
  attachSessionProjectInfo,
  buildSessionContext,
  getSessionListVersion,
  invalidateSessionListCache,
  invalidateSessionManagerCache,
  listAllSessions,
  listSessionSummaries,
  mergeSessionLists,
  openSessionManager,
  resolveSessionIdByPath,
  resolveSessionPath,
} from "../../lib/session-reader";
import {
  getAwaitingInputRpcSessionIds,
  getCompletionNotificationSuppressedRpcSessionIds,
  getRpcSession,
  getRpcSessionInfos,
  getRunningRpcSessionIds,
} from "../../lib/rpc-manager";
import { deleteSessions } from "../../lib/session-delete";
import { projectTreeForResponse, toSummaryTree } from "../../lib/project-tree";
import { computeSessionRevision } from "../../lib/session-revision";
import { computeSessionStats } from "../../lib/session-stats";
import { computeSessionTotalActiveMs } from "../../lib/session-timing";
import { readSessionToolSelection } from "../../lib/session-tool-selection";
import { readSubagentRun, readSubagentSessionResources } from "../../lib/subagents";
import type { SessionEntry } from "../../lib/types";
import { existsSync, statSync } from "fs";

/** GET /api/sessions —— 侧栏的会话列表（含运行中/等待输入的标记）。 */
export const listSessions: ApiHandler = async (request, { url }) => {
  try {
    const force = url.searchParams.get("force") === "1";
    // `summary=1` 只给表头/统计元数据，侧栏不必等每份会话记录解析完。
    const summary = url.searchParams.get("summary") === "1";
    const persistedSessionsPromise = summary
      ? listSessionSummaries()
      : listAllSessions({ force });
    // 扫描前先取版本号：扫描期间发生的改动仍要求之后刷新一次。
    const sessionListVersion = getSessionListVersion();
    const [persistedSessions, runtimeSessions] = await Promise.all([
      persistedSessionsPromise,
      attachSessionProjectInfo(getRpcSessionInfos()),
    ]);
    return json({
      sessions: mergeSessionLists(persistedSessions, runtimeSessions),
      sessionListVersion,
      runningSessionIds: getRunningRpcSessionIds(),
      awaitingInputSessionIds: getAwaitingInputRpcSessionIds(),
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
    });
  } catch (error) {
    return jsonError(error);
  }
};

/** GET /api/sessions/[id] —— 打开一个会话：树、上下文窗口、统计。 */
export const getSession: ApiHandler = async (request, { params, url }) => {
  const id = params.id ?? "";
  try {
    const rpc = getRpcSession(id);
    const force = url.searchParams.get("force") === "1";

    // 活动包装器只反映本进程追加的内容。另一个 pi 进程（TUI）写同一份文件时内存索引会过期，
    // 因此只在 ?force=1（挂载会话/刷新页面）时探测磁盘，回合之间的读取不扫盘。
    let liveWrapper = rpc?.isAlive() ? rpc : undefined;
    let wrapperRebuilt = false;
    if (force && liveWrapper?.evictIfDiskAhead()) {
      wrapperRebuilt = true;
      liveWrapper = undefined;
    }
    const liveRpc = liveWrapper;
    const resolvedPath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !resolvedPath) {
      return json({ error: "Session not found" }, 404);
    }

    const sm = liveRpc?.inner.sessionManager ?? openSessionManager(resolvedPath!);
    const filePath = liveRpc?.sessionFile || sm.getSessionFile() || resolvedPath || "";
    const entries = sm.getEntries();
    const leafId = sm.getLeafId();
    const summaryTree = url.searchParams.get("tree") === "summary";
    const tree = summaryTree
      ? toSummaryTree(projectTreeForResponse(sm.getTree()))
      : projectTreeForResponse(sm.getTree());
    const deferThinking = url.searchParams.has("deferThinking");
    const deferToolResultImages = url.searchParams.has("deferMedia");
    const rawTail = Number(url.searchParams.get("tail"));
    const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;
    const context = buildSessionContext(entries as never, leafId, {
      deferThinking,
      deferToolResultImages,
      tail,
      sessionId: id, // 本地：给历史工具结果图片用的惰性 URL
    });
    const totalActiveMs = computeSessionTotalActiveMs(entries);
    // 全部条目的累计用量（含已被压缩掉的历史），与 SDK 的 getSessionStats() 同一口径。
    const stats = computeSessionStats(entries as unknown as SessionEntry[]);
    const latestEntry = entries[entries.length - 1] as { id?: string } | undefined;
    const snapshotRevision = computeSessionRevision({
      filePath,
      sourceId: liveRpc ? `runtime:${String(liveRpc.inner.sessionId)}` : "disk",
      entryCount: entries.length,
      latestEntryId: typeof latestEntry?.id === "string" ? latestEntry.id : null,
      leafId: leafId ?? null,
    });
    const sessionName = sm.getSessionName();
    const firstUserEntry = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
    const firstUserMessage = firstUserEntry?.type === "message" ? firstUserEntry.message : undefined;

    const header = sm.getHeader();
    let modified = header?.timestamp ?? new Date().toISOString();
    try { modified = statSync(filePath).mtime.toISOString(); } catch { /* 用表头时间戳 */ }
    const parentSessionId = header?.parentSession
      ? await resolveSessionIdByPath(header.parentSession)
      : undefined;
    const subagent = header ? readSubagentRun(entries as never, header.id, filePath) : null;
    const toolNames = readSubagentSessionResources(entries as never)?.tools
      ?? readSessionToolSelection(entries as never);
    const info = header ? (await attachSessionProjectInfo([{
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      name: sessionName,
      created: header.timestamp,
      modified,
      messageCount: stats.totalMessages,
      firstMessage: firstUserMessage
        ? (() => {
            const c = (firstUserMessage as { content: unknown }).content;
            return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
          })()
        : "(no messages)",
      parentSessionId,
      ...(subagent
        ? { relation: { kind: "subagent" as const, parentSessionId: subagent.parentSessionId, profile: subagent.profile, description: subagent.description, status: liveRpc?.isRunning() ? "running" as const : subagent.status } }
        : header.parentSession
          ? { relation: { kind: "fork" as const, ...(parentSessionId ? { originSessionId: parentSessionId } : {}) } }
          : {}),
      transient: !filePath || !existsSync(filePath),
    }]))[0] : null;

    return json({
      sessionId: id,
      filePath,
      info,
      leafId,
      tree,
      ...(summaryTree ? { treeFormat: "summary" as const } : {}),
      snapshotRevision,
      context,
      stats,
      totalActiveMs,
      ...(toolNames !== undefined ? { toolNames } : {}),
      ...(wrapperRebuilt ? { wrapperRebuilt: true } : {}),
    });
  } catch (error) {
    return jsonError(error);
  }
};

/** GET /api/sessions/[id]/state —— 活动会话的实时状态（打开会话时调用）。 */
export const getSessionState: ApiHandler = async (_request, { params }) => {
  const id = params.id ?? "";
  try {
    const rpc = getRpcSession(id);
    if (rpc?.isAlive()) {
      const state = await rpc.send({ type: "get_state" });
      return json({ running: true, state });
    }
    if (!await resolveSessionPath(id)) {
      return json({ error: "Session not found" }, 404);
    }
    return json({ running: false });
  } catch (error) {
    return jsonError(error);
  }
};

/** PATCH /api/sessions/[id]  body: { name } */
export const renameSession: ApiHandler = async (request, { params }) => {
  const id = params.id ?? "";
  try {
    const { name } = await request.json() as { name?: string };
    if (typeof name !== "string") return json({ error: "name is required" }, 400);
    const filePath = await resolveSessionPath(id);
    if (!filePath) return json({ error: "Session not found" }, 404);
    // 改名走 appendSessionInfo：新开一份绕过缓存。
    const sm = openSessionManager(filePath, { mutable: true });
    sm.appendSessionInfo(name.trim());
    invalidateSessionManagerCache(filePath);
    invalidateSessionListCache();
    return json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
};

/** DELETE /api/sessions/[id] —— 会话及其下属子代理会话。 */
export const deleteSession: ApiHandler = async (_request, { params }) => {
  const id = params.id ?? "";
  try {
    const { missing } = await deleteSessions([id]);
    if (missing.length > 0) return json({ error: "Session not found" }, 404);
    return json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
};
