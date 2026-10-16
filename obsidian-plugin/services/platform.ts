import { json, jsonError, type ApiHandler } from "./respond";
import { existsSync } from "fs";
import { stat } from "fs/promises";
import { resolve } from "path";
import { createAgentSessionServices, getAgentDir, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { homedir } from "os";
import {
  getAwaitingInputRpcSessionIds,
  getCompletionNotificationSuppressedRpcSessionIds,
  getRunningRpcSessionIds,
} from "../../lib/rpc-manager";
import { getSessionListVersion } from "../../lib/session-reader";
import { getSessionUiStateRevision } from "../../lib/session-ui-state";
import {
  loadModelsWithCache,
  withModelRuntimeError,
  withSafeModelLoadFailure,
  type ModelsData,
} from "../../lib/models-cache";
import { orderSelectorModels, resolveVisibleModels, selectInitialModelScope } from "../../lib/model-scope";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "../../lib/file-access";
import { projectTrustReloadOptions } from "../../lib/project-trust";
import { rememberProviderModels, withDeferredProviderModels } from "../../lib/deferred-provider-models";
import { inferRemovedWorktree } from "../../lib/worktree";

/** GET /api/agent/running —— 可见标签页轮询用的轻量快照。 */
export const getRunningSessions: ApiHandler = () => json({
  sessionListVersion: getSessionListVersion(),
  runningSessionIds: getRunningRpcSessionIds(),
  awaitingInputSessionIds: getAwaitingInputRpcSessionIds(),
  completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
  sessionUiStateRevision: getSessionUiStateRevision(),
});

/** GET /api/home —— 主目录，侧栏用来把绝对路径显示成相对路径。 */
export const getHome: ApiHandler = () => json({ home: homedir() });

async function loadModels(cwd: string): Promise<ModelsData> {
  const nameMap = new Map<string, string>();
  let modelList: { id: string; name: string; provider: string }[] = [];
  let defaultModel: { provider: string; modelId: string } | null = null;
  const thinkingLevels: Record<string, string[]> = {};
  const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};

  const agentDir = getAgentDir();
  // 枚举模型会 import 并执行仓库里的 .pi/extensions 工厂，所以这里同样遵守项目信任设置。
  const trustReloadOptions = projectTrustReloadOptions(cwd, agentDir);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
  });
  const modelError = services.modelRuntime.getError();
  const settings: SettingsManager = services.settingsManager;
  await rememberProviderModels(services.modelRuntime);
  // `enabledModels` 支持 glob 与模糊匹配，按 CLI 的口径解析，而不是字面比较模式串。
  const scope = await resolveVisibleModels(
    withDeferredProviderModels(services.modelRuntime),
    settings.getEnabledModels(),
  );
  const { visible, thinkingLevelPins, warnings } = scope;
  modelList = orderSelectorModels(scope).map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    input: m.input,
  }));
  for (const m of visible) {
    const key = `${m.provider}:${m.id}`;
    nameMap.set(key, m.name);
    thinkingLevels[key] = getSupportedThinkingLevels(m);
    if (m.thinkingLevelMap) thinkingLevelMaps[key] = m.thinkingLevelMap;
  }

  const defaultProvider = settings.getDefaultProvider();
  const defaultModelId = settings.getDefaultModel();
  const initial = selectInitialModelScope(scope, {
    ...(defaultProvider && defaultModelId
      ? { defaultModel: { provider: defaultProvider, modelId: defaultModelId } }
      : {}),
  });
  if (initial.model) {
    defaultModel = { provider: initial.model.provider, modelId: initial.model.id };
  }
  const defaultThinkingLevel = initial.thinkingLevel
    ?? (initial.model
      ? settings.getModelThinkingLevel(initial.model.provider, initial.model.id)
      : undefined)
    ?? settings.getDefaultThinkingLevel()
    ?? null;

  return withModelRuntimeError(
    {
      models: Object.fromEntries(nameMap),
      modelList,
      defaultModel,
      defaultThinkingLevel,
      savedDefaultThinkingLevel: settings.getDefaultThinkingLevel() ?? null,
      thinkingLevels,
      thinkingLevelMaps,
      thinkingLevelPins,
      ...(warnings.length > 0 ? { modelScopeWarnings: warnings } : {}),
    },
    modelError,
  );
}

const EMPTY_MODELS: ModelsData = {
  models: {},
  modelList: [],
  defaultModel: null,
  defaultThinkingLevel: null,
  savedDefaultThinkingLevel: null,
  thinkingLevels: {},
  thinkingLevelMaps: {},
  thinkingLevelPins: {},
};

/** GET /api/models —— 模型选择器的数据源。 */
export const getModels: ApiHandler = async (request, { url }) => {
  const requestedCwd = resolve(url.searchParams.get("cwd") || process.cwd());
  // 隔离在 worktree 里的子代理运行结束后 worktree 会被删掉，但会话文件仍记着它当 cwd。
  // 回退到它分叉出来的主仓库，让打开一个已结束的子代理解析出与非隔离会话一致的模型。
  const cwd = existsSync(requestedCwd)
    ? requestedCwd
    : inferRemovedWorktree(requestedCwd)?.projectRoot ?? requestedCwd;

  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    return json({ error: `Directory does not exist: ${cwd}` }, 400);
  }
  if (!cwdStat.isDirectory()) {
    return json({ error: `Not a directory: ${cwd}` }, 400);
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return jsonError(new Error("Access denied"), 403);
  }

  try {
    return json(await loadModelsWithCache(cwd, () => loadModels(cwd)));
  } catch {
    return json(withSafeModelLoadFailure(EMPTY_MODELS));
  }
};
